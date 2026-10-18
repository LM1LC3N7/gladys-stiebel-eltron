// -----------------------------------------------------------------------------
// The integration: the ISG typed in the configuration (its IP address), one
// Modbus read of its registers every poll interval, the Gladys device of the
// heat pump and its states, the transport badge, the "Test the connection"
// button, and the three commands (operating mode, heating setpoint, hot
// water setpoint), refused unless the configuration allows them.
// index.js only wires the SDK handlers.
//
// The commands follow the rules learnt on the previous modules:
//   - decided on a fresh read of the parameters only, never on the values
//     kept in memory, and refused when the value they need is missing;
//   - the "Allow the commands" option (and the hot water ceiling) is checked
//     on arrival and again right before the bytes leave;
//   - the fresh read and the write hold the Modbus connection together: no
//     other request runs in between;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a write that may have reached the ISG (silence, a dropped connection,
//     an answer that is not its echo) is never answered "not sent": "sent,
//     without confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time; never retried.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { DHW_CAP, FEATURES as F, SECOND, TIMINGS, UNIT_ID } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  reportedRoles,
} from './devices.js';
import { ERRORS, MODE_NAMES, STATE_TEXTS, T, age, join, word } from './i18n.js';
import {
  COMMANDS,
  CONTROLLERS,
  MODES,
  PARAMETERS,
  PROTECTED_MODES,
  SELECTABLE,
  decode,
  freshBlocks,
  readBlocks,
  readController,
  setpointWord,
} from './isg.js';
import { ERROR_KINDS, ModbusClient, errorReason } from './modbus/client.js';
import { StatePublisher } from './publisher.js';

/** The decoded values that come from the parameters (holding registers). */
const PARAMETER_VALUES = [
  'mode',
  'heatingSetpoint',
  'heatingSetpointEco',
  'dhwSetpoint',
  'dhwSetpointEco',
];

/** What a command compares, for a role: the mode key or the setpoint register word. */
function comparable(role, values) {
  if (role === F.MODE) {
    return values?.mode?.key;
  }
  const value = role === F.HEATING_SETPOINT ? values?.heatingSetpoint : values?.dhwSetpoint;
  return value === undefined ? undefined : setpointWord(value);
}

/** A number sent by Gladys: a finite number, or a plain decimal text ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export class StiebelApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'stiebel-eltron' }),
    connect,
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    /** The socket factory (tests); node:net otherwise. */
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.isg = undefined;
    /** family -> the roles its values were seen to report (a feature never disappears). */
    this.seen = new Map();
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** The command in flight (one at a time for the ISG). */
    this.inFlight = undefined;
    /** `${family}:${role}` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  freshIsg(address) {
    return {
      address,
      client: new ModbusClient({
        host: address.host,
        port: address.port,
        unitId: UNIT_ID,
        timers: this.timers,
        now: this.now,
        ...(this.connect ? { connect: this.connect } : {}),
      }),
      /** `{ code, family, variant, model }` of the controller last identified. */
      controller: undefined,
      /** The identification of a controller this integration does not know. */
      unsupported: undefined,
      online: undefined,
      failures: 0,
      wait: undefined,
      error: undefined,
      /** The values of the last read (src/isg.js decode). */
      values: undefined,
      /** The blocks that failed in the last read. */
      failed: [],
      blocks: freshBlocks(),
      timer: undefined,
      running: undefined,
      followUps: new Set(),
    };
  }

  async start(raw = {}) {
    const previous = this.isg;
    this.stop();
    await previous?.running;
    this.config = normalizeConfig(raw);
    this.isg = this.config.address ? this.freshIsg(this.config.address) : undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.isg) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    if (this.isg) {
      this.clearTimer();
      for (const handle of this.isg.followUps) {
        this.timers.clearTimeout(handle);
      }
      this.isg.followUps.clear();
      this.isg.client.close();
    }
    this.publisher.stop();
  }

  clearTimer() {
    if (this.isg?.timer) {
      this.timers.clearTimeout(this.isg.timer);
      this.isg.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges) and the last states. The client and its state stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.pollInterval !== this.config.pollInterval ||
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid
    );
  }

  /** A new address or interval restarts; the option, the ceiling and the language apply at once. */
  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`ISG commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The next read: after a backoff when the last one failed, else the interval. */
  schedule() {
    const isg = this.isg;
    this.clearTimer();
    const wait = isg.online === false ? isg.wait : this.interval;
    const generation = this.generation;
    isg.timer = this.timers.setTimeout(
      () => {
        isg.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('ISG refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const isg = this.isg;
    if (!isg) {
      return Promise.resolve();
    }
    if (!isg.running) {
      isg.running = this.run(isg).finally(() => {
        isg.running = undefined;
      });
    }
    return isg.running;
  }

  async run(isg) {
    const generation = this.generation;
    try {
      const code = await readController(isg.client);
      if (generation !== this.generation) {
        return;
      }
      const known = Object.hasOwn(CONTROLLERS, code) ? CONTROLLERS[code] : undefined;
      if (!known) {
        isg.unsupported = code;
        isg.controller = undefined;
        isg.values = undefined;
        throw Object.assign(new Error('unsupported'), { unsupported: true });
      }
      if (isg.controller && isg.controller.variant !== known.variant) {
        // Another controller answers at this address: what was read of the first one is dropped.
        this.logger.warn('ISG: another controller answers at this address');
        isg.blocks = freshBlocks();
        isg.values = undefined;
      }
      isg.controller = { code, ...known };
      const { raw, failed } = await readBlocks(isg.client, known.variant, isg.blocks, {
        logger: this.logger,
      });
      if (generation !== this.generation) {
        return;
      }
      isg.values = decode(known.family, raw);
      isg.failed = failed;
      isg.online = true;
      isg.failures = 0;
      isg.wait = undefined;
      isg.error = undefined;
      isg.unsupported = undefined;
      this.observe(known.family, isg.values);
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      this.failed(isg, err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  failed(isg, err) {
    if (err.unsupported) {
      isg.online = false;
      isg.error = 'unsupported';
      isg.wait = Math.max(this.interval, TIMINGS.unsupportedRetry);
      this.logger.warn(`ISG: unknown controller identification ${isg.unsupported}`);
      return;
    }
    const reason = errorReason(err);
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(isg.failures, TIMINGS.backoff.length - 1)],
    );
    isg.failures += 1;
    isg.online = false;
    isg.wait = wait;
    isg.error = reason;
    this.logger.warn(
      `ISG ${addressKey(isg.address)}: ${reason}; next try in ${Math.round(wait / 1000)} s`,
    );
  }

  // --- What the ISG gives ------------------------------------------------------

  /** Whether the values of the last read are current. */
  get live() {
    return Boolean(this.isg?.online === true && this.isg.controller && this.isg.values);
  }

  get family() {
    return this.isg?.controller?.family;
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices: [{ device, family }]. */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const family = parseDeviceId(device?.external_id);
      if (family && deviceIds(this.gladys, family).device === device.external_id) {
        list.push({ device, family });
      }
    }
    return list;
  }

  /**
   * How a created device stands: 'online', 'offline' (the ISG does not
   * answer, or an unknown controller) or 'other' (the ISG answers for
   * another family). undefined while a first read is under way.
   */
  standing(family) {
    if (this.live) {
      return family === this.family ? 'online' : 'other';
    }
    if (!this.isg || this.isg.online === false) {
      return 'offline';
    }
    return undefined;
  }

  /** The roles of a family: those seen during this run, plus those the last read reports. */
  rolesFor(family) {
    const seen = this.seen.get(family) ?? new Set();
    if (family === this.family && this.isg?.values) {
      for (const role of reportedRoles(this.isg.values)) {
        seen.add(role);
      }
    }
    this.seen.set(family, seen);
    return seen;
  }

  // --- Gladys ----------------------------------------------------------------

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery list: the heat pump of the controller last identified
   * (even unreachable now); before any identification, the devices already
   * created, as they are.
   */
  async publishDevices() {
    const families = this.family
      ? [this.family]
      : [...new Set(this.ourDevices().map((entry) => entry.family))];
    if (families.length === 0) {
      return;
    }
    const devices = families.map((family) =>
      buildDevice(this.gladys, family, {
        roles: this.rolesFor(family),
        controller: family === this.family ? this.isg.controller : undefined,
        language: this.config.language,
        created: this.createdDevice(deviceIds(this.gladys, family).device),
      }),
    );
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    for (const { family } of this.ourDevices()) {
      const status = this.standing(family);
      if (status === undefined) {
        continue;
      }
      const ids = deviceIds(this.gladys, family);
      const states = deviceStates(ids, family, status === 'online' ? this.isg.values : {}, {
        status,
        language: this.config.language,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    for (const { device, family } of this.ourDevices()) {
      const status = this.standing(family);
      if (status === undefined) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport: status === 'online' ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  withInvalid(message) {
    return this.config.invalid ? join([message, T.invalid(this.config.invalid)]) : message;
  }

  status() {
    const isg = this.isg;
    if (!isg) {
      return [false, this.withInvalid(T.noAddress)];
    }
    if (isg.online === false) {
      return isg.error === 'unsupported'
        ? [false, T.unsupported(isg.unsupported, age(isg.wait))]
        : [false, T.unreachable(addressKey(isg.address), isg.error, age(isg.wait))];
    }
    if (isg.online === undefined || !isg.controller) {
      return [false, T.connecting];
    }
    const notes = [];
    if (isg.failed.length > 0) {
      notes.push(T.notes.failing(isg.failed.join(', ')));
    }
    const created = this.ourDevices();
    if (created.length > 0 && !created.some((entry) => entry.family === this.family)) {
      notes.push(T.notes.otherFamily);
    }
    return [true, T.connected(isg.controller.model, isg.controller.code, notes)];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  async testConnection() {
    if (!this.isg) {
      return this.withInvalid(T.noAddress);
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join([T.test.cooldown, last]) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    // A read now (a read in progress is joined).
    await this.tick();
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- The commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, checked strictly (null, '' or 'abc' are not a
   * number; a mode is one of the exact keys of the list). Returns
   * `{ address, word, value }`.
   */
  parseCommand({ family, role }, value) {
    const commands = COMMANDS[family];
    if (role === F.MODE) {
      if (typeof value !== 'string' || !SELECTABLE[family].includes(value)) {
        throw this.refusal(ERRORS.badMode);
      }
      const code = Number(Object.keys(MODES[family]).find((k) => MODES[family][k] === value));
      return { address: commands.mode, word: code, value, key: value };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (role === F.HEATING_SETPOINT) {
      const { address, min, max } = commands.heatingSetpoint;
      if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-6) {
        throw this.refusal(ERRORS.badStep(0.1));
      }
      if (number < min || number > max) {
        throw this.refusal(ERRORS.outOfRange(min, max));
      }
      return { address, word: setpointWord(number), value: number };
    }
    // The hot water setpoint: whole degrees (water-heater commands are
    // integers), never above the hard ceiling nor the configured one.
    const { address, min, max } = commands.dhwSetpoint;
    if (!Number.isInteger(number)) {
      throw this.refusal(ERRORS.badStep(1));
    }
    const top = Math.min(max, DHW_CAP.max);
    if (number < min || number > top) {
      throw this.refusal(ERRORS.outOfRange(min, top));
    }
    if (number > this.config.dhwCap) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
    return { address, word: setpointWord(number), value: number };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.parseCommand(target, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.command(target, wanted, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The checks before sending, on the latest configuration. */
  checkBeforeSend(generation, { family, role }, wanted) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.live || family !== this.family) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // The ceiling may have been lowered since the command arrived.
    if (
      role === F.DHW_SETPOINT &&
      (wanted.value > this.config.dhwCap || wanted.value > DHW_CAP.max)
    ) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
  }

  async command(target, wanted, received) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    this.checkBeforeSend(generation, target, wanted);
    const isg = this.isg;
    const readBy = Math.min(this.now() + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // One session holds the connection from the fresh read to the end of
    // the write: no other request runs in between. Still waiting at
    // readBy - minRead (a slow poll request in flight): refused unsent.
    try {
      return await isg.client.session(
        (raw) =>
          this.commandSession(raw, target, wanted, { generation, isg, received, sendBy, readBy }),
        { startBy: readBy - TIMINGS.commandMinRead },
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw err;
    }
  }

  /** The command inside its session (the gate is held: `raw` requests). */
  async commandSession(raw, target, wanted, { generation, isg, received, sendBy, readBy }) {
    const { family, role } = target;
    // The parameters just before acting, never the values in memory.
    const { start, count } = PARAMETERS[family];
    let words;
    try {
      words = await raw.readHolding(start, count, { answerBy: readBy });
    } catch (err) {
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    if (generation !== this.generation || this.isg !== isg || !this.live) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const holding = new Map(words.map((w, i) => [start + i, w]));
    const fresh = decode(family, { holding });
    for (const key of PARAMETER_VALUES) {
      isg.values[key] = fresh[key];
    }
    this.observe(family, isg.values);
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));

    if (role === F.MODE) {
      if (fresh.mode === undefined) {
        throw this.refusal(ERRORS.missingValue);
      }
      if (!fresh.mode.key || PROTECTED_MODES.has(fresh.mode.key)) {
        const name = fresh.mode.key
          ? MODE_NAMES[fresh.mode.key]
          : STATE_TEXTS.unknownMode(fresh.mode.code);
        throw this.refusal(ERRORS.protectedMode(name));
      }
    }
    const current = comparable(role, fresh);
    if (current === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const expected = role === F.MODE ? wanted.key : wanted.word;
    const key = `${family}:${role}`;
    if (current === expected && !this.guardActive(key)) {
      // Already so: nothing sent.
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, target, wanted);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.logger.info(`ISG ${role}: ${wanted.value}`);
    const plan = { from: current, expected };
    try {
      await raw.writeRegister(wanted.address, wanted.word, {
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        // The very last check, right before the bytes leave.
        beforeSend: () => this.checkBeforeSend(generation, target, wanted),
      });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = errorReason(err);
      this.logger.warn(`ISG ${role}: ${wanted.value} failed (${reason})`);
      if (!err.sent) {
        // Nothing reached the socket.
        throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.EXCEPTION) {
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a dropped connection or an answer that is not the echo:
      // the write may have reached the ISG.
      this.guard(key, plan);
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    // The ISG echoed the write: accepted.
    this.guard(key, plan);
    this.followUp();
  }

  /** Reads after a command, spaced: its effect, then a check. */
  followUp() {
    const isg = this.isg;
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        isg.followUps.delete(handle);
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('ISG refresh failed'));
        }
      }, delay);
      isg.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until a read shows it: a new command is always sent,
   * never answered "already so" on a value that may not show the previous
   * one yet. The start value is kept: a read equal to it lifts nothing
   * until a move was seen.
   */
  guard(key, plan) {
    this.guards.set(key, { ...plan, moved: false, until: this.now() + TIMINGS.guard });
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read, through the guards of its family: never lifted on an unknown value. */
  observe(family, values) {
    for (const role of COMMAND_ROLES) {
      const key = `${family}:${role}`;
      if (!this.guardActive(key)) {
        continue;
      }
      const value = comparable(role, values);
      if (value === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(key);
      }
    }
  }
}
