// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake ISG behind the socket factory. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { StiebelApp } from '../src/app.js';
import { ACTIONS, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { HOST, NOW, fakeIsg, lwzRegisters, settle, wpmRegisters } from './fixtures/fakeIsg.js';

const CONFIG = { address: HOST };
const ALLOWED = { address: HOST, allow_commands: true };
const device = (family = 'wpm') => `ext:test-integration:stiebel-eltron:${family}`;
const feature = (role, family = 'wpm') => `${device(family)}:${role}`;

async function setup(t, { config = CONFIG, isg = fakeIsg(), create = true, logs = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new StiebelApp({
    gladys,
    logger: recorder(logs),
    connect: isg.connect,
    now: () => Date.now(),
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  /** A command on a feature of the created device; resolves with the ack. */
  const command = async (role, value, { family = 'wpm', wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device(family));
    const target = d.features.find((f) => f.external_id === feature(role, family));
    const ack = gladys.fake.setValue(d, target, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, isg, advance, logs, command };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role, family) => gladys.fake.lastState(feature(role, family));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const discovered = (gladys, family = 'wpm') =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === device(family));
const roles = (d) => d.features.map((f) => f.external_id.slice(d.external_id.length + 1));
const transportOf = (gladys, family = 'wpm') =>
  gladys.fake.transports.filter((x) => x.device_external_id === device(family)).at(-1)?.transport;
const reads = (isg) => isg.requests.filter((r) => r.fn !== 6).length;

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const isg = fakeIsg();
  const { gladys } = await setup(t, { config: {}, isg });
  assert.equal(isg.connects.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(isg.connects.length, 0);
});

test('one poll: the controller, then each block once, unit 1 on port 502, one request at a time', async (t) => {
  const isg = fakeIsg();
  const { gladys } = await setup(t, { isg, create: false });
  assert.deepEqual(isg.connects, [{ host: HOST, port: 502 }]);
  assert.deepEqual(
    isg.requests.map((r) => `${r.fn}:${r.address}+${r.count}`),
    ['4:5001+1', '4:500+8', '4:509+14', '3:1500+11', '4:2500+1', '4:2503+1', '4:3500+16'],
  );
  assert.ok(isg.requests.every((r) => r.unit === 1));
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Connecté : WPM 3 \(régulateur 390\)/);
});

test('one device: the features its registers gave, no switch, energy never an index', async (t) => {
  const { gladys } = await setup(t, { create: false });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  const d = discovered(gladys);
  assert.equal(d.name, 'Pompe à chaleur STIEBEL ELTRON');
  assert.equal(d.model, 'STIEBEL ELTRON WPM 3');
  assert.equal(d.should_poll, false);
  assert.deepEqual(d.params, [
    { name: 'family', value: 'wpm' },
    { name: 'controller', value: 'WPM 3 (390)' },
  ]);
  const shape = Object.fromEntries(
    d.features.map((f) => [
      f.external_id.slice(d.external_id.length + 1),
      [f.category, f.type, f.unit ?? null, f.read_only, f.min, f.max],
    ]),
  );
  assert.deepEqual(roles(d), [
    'mode',
    'operating-mode',
    'heating-setpoint',
    'heating-setpoint-eco',
    'dhw-setpoint',
    'dhw-setpoint-eco',
    'dhw-target',
    'temperature-outdoor',
    'temperature-flow',
    'temperature-return',
    'temperature-dhw',
    'temperature-room-fe7',
    'compressor',
    'booster',
    'fault',
    'energy-consumed-heating-today',
    'energy-consumed-heating-total',
    'energy-consumed-dhw-today',
    'energy-consumed-dhw-total',
    'energy-produced-heating-today',
    'energy-produced-heating-total',
    'energy-produced-dhw-today',
    'energy-produced-dhw-total',
    'energy-booster-heating-total',
    'energy-booster-dhw-total',
  ]);
  assert.deepEqual(shape.mode, ['text', 'select', null, false, 0, 0]);
  assert.deepEqual(shape['heating-setpoint'], [
    'thermostat',
    'target-temperature',
    'celsius',
    false,
    5,
    30,
  ]);
  assert.deepEqual(shape['dhw-setpoint'], [
    'water-heater',
    'target-temperature',
    'celsius',
    false,
    10,
    60,
  ]);
  assert.deepEqual(shape['temperature-outdoor'], [
    'temperature-sensor',
    'probe',
    'celsius',
    true,
    -60,
    120,
  ]);
  assert.deepEqual(shape['temperature-room-fe7'], [
    'temperature-sensor',
    'decimal',
    'celsius',
    true,
    -60,
    120,
  ]);
  assert.deepEqual(shape.compressor, ['unknown', 'binary', null, true, 0, 1]);
  assert.deepEqual(shape['energy-consumed-heating-total'], [
    'unknown',
    'decimal',
    null,
    true,
    0,
    100_000_000,
  ]);
  assert.ok(d.features.every((f) => f.category !== 'switch' && f.category !== 'energy-sensor'));
  assert.ok(d.features.filter((f) => !f.read_only).every((f) => f.type !== 'binary'));
  const select = d.features.find((f) => f.external_id === feature('mode'));
  assert.deepEqual(
    select.supported_options.map((o) => [o.value, o.label]),
    [
      ['program', 'Programme (automatique)'],
      ['comfort', 'Confort'],
      ['eco', 'Éco'],
      ['dhw', 'Eau chaude seule'],
      ['standby', 'Veille'],
    ],
  );
});

test('the values of the created device, badge local', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(last(gladys, 'mode'), 'program');
  assert.equal(last(gladys, 'operating-mode'), 'Programme (automatique)');
  assert.equal(last(gladys, 'temperature-outdoor'), -5);
  assert.equal(last(gladys, 'temperature-flow'), 35.2);
  assert.equal(last(gladys, 'temperature-return'), 30.1);
  assert.equal(last(gladys, 'temperature-dhw'), 48.2);
  assert.equal(last(gladys, 'temperature-room-fe7'), 21.5);
  assert.equal(last(gladys, 'heating-setpoint'), 21);
  assert.equal(last(gladys, 'dhw-setpoint'), 50);
  assert.equal(last(gladys, 'compressor'), 1);
  assert.equal(last(gladys, 'booster'), 0);
  assert.equal(last(gladys, 'energy-consumed-heating-total'), 3123);
  assert.equal(last(gladys, 'energy-produced-heating-total'), 12345);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
});

test('an LWZ: its own device, modes and setpoint ranges', async (t) => {
  const isg = fakeIsg({ registers: lwzRegisters() });
  const { gladys } = await setup(t, { isg });
  const d = discovered(gladys, 'lwz');
  assert.equal(d.model, 'STIEBEL ELTRON LWZ / LWA');
  assert.ok(roles(d).includes('temperature-room'));
  assert.ok(roles(d).includes('humidity'));
  const setpoint = d.features.find((f) => f.external_id === feature('heating-setpoint', 'lwz'));
  assert.deepEqual([setpoint.min, setpoint.max], [10, 30]);
  const select = d.features.find((f) => f.external_id === feature('mode', 'lwz'));
  assert.deepEqual(
    select.supported_options.map((o) => o.value),
    ['automatic', 'day', 'setback', 'dhw', 'standby'],
  );
  assert.equal(last(gladys, 'mode', 'lwz'), 'automatic');
  assert.equal(last(gladys, 'temperature-room', 'lwz'), 21.2);
  assert.equal(last(gladys, 'compressor', 'lwz'), 1);
});

test('commands are refused while the option is off: nothing written', async (t) => {
  const isg = fakeIsg();
  const { command } = await setup(t, { isg });
  for (const [role, value] of [
    ['mode', 'comfort'],
    ['heating-setpoint', 22],
    ['dhw-setpoint', 50],
  ]) {
    const ack = await command(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /commandes sont désactivées/);
  }
  assert.deepEqual(isg.writes(), []);
});

test('read-only features refuse every command', async (t) => {
  const isg = fakeIsg();
  const { command } = await setup(t, { isg, config: ALLOWED });
  for (const role of [
    'operating-mode',
    'compressor',
    'temperature-dhw',
    'energy-consumed-heating-total',
  ]) {
    const ack = await command(role, 1);
    assert.match(ack.error, /lecture seule/);
  }
  assert.deepEqual(isg.writes(), []);
});

test('the mode: a fresh read of the parameters, then the write, nothing in between', async (t) => {
  const isg = fakeIsg();
  const { gladys, command, advance } = await setup(t, { isg, config: ALLOWED });
  const before = isg.requests.length;
  const ack = await command('mode', 'comfort', { wait: 0 });
  assert.equal(ack.success, true);
  assert.deepEqual(
    isg.requests.slice(before, before + 2).map((r) => `${r.fn}:${r.address}`),
    ['3:1500', '6:1500'],
  );
  assert.deepEqual(isg.writes(), [[1500, 3]]);
  // The follow-up read 5 s later shows it.
  await advance(5 * SECOND);
  assert.equal(last(gladys, 'mode'), 'comfort');
  assert.equal(last(gladys, 'operating-mode'), 'Confort');
});

test('the ack never waits for a publication to Gladys', async (t) => {
  const isg = fakeIsg();
  const { app, command } = await setup(t, { isg, config: ALLOWED });
  app.publishAll = () => new Promise(() => {});
  const ack = await command('mode', 'eco', { wait: 0 });
  assert.equal(ack.success, true);
  assert.deepEqual(isg.writes(), [[1500, 4]]);
});

test('the setpoints: tenths for heating, whole degrees for hot water, written as tenths', async (t) => {
  const isg = fakeIsg();
  const { command } = await setup(t, { isg, config: ALLOWED });
  assert.equal((await command('heating-setpoint', 21.5)).success, true);
  assert.equal((await command('dhw-setpoint', '52')).success, true);
  assert.deepEqual(isg.writes(), [
    [1501, 215],
    [1509, 520],
  ]);
});

test('hot water is capped at 55 °C by default; the bounds and the steps are strict', async (t) => {
  const isg = fakeIsg();
  const { command } = await setup(t, { isg, config: ALLOWED });
  assert.match((await command('dhw-setpoint', 56)).error, /plafonnée à 55 °C/);
  assert.match((await command('dhw-setpoint', 61)).error, /entre 10 et 60 °C/);
  assert.match((await command('dhw-setpoint', 52.5)).error, /multiple de 1 °C/);
  assert.match((await command('dhw-setpoint', 9)).error, /entre 10 et 60 °C/);
  for (const bad of ['', ' ', null, 'abc', '55°', true, '1e2', 'NaN', {}]) {
    assert.match((await command('dhw-setpoint', bad)).error, /doit être un nombre/, String(bad));
  }
  assert.match((await command('heating-setpoint', 21.55)).error, /multiple de 0,1 °C/);
  assert.match((await command('heating-setpoint', 31)).error, /entre 5 et 30 °C/);
  assert.match((await command('mode', 'emergency')).error, /Mode de fonctionnement inconnu/);
  assert.match((await command('mode', 'Comfort')).error, /Mode de fonctionnement inconnu/);
  assert.match((await command('mode', 3)).error, /Mode de fonctionnement inconnu/);
  assert.deepEqual(isg.writes(), []);
});

test('a ceiling raised in the configuration allows up to it, never above 60 °C', async (t) => {
  const isg = fakeIsg();
  const { command } = await setup(t, { isg, config: { ...ALLOWED, dhw_max_temperature: 70 } });
  assert.equal((await command('dhw-setpoint', 60)).success, true);
  assert.match((await command('dhw-setpoint', 61)).error, /entre 10 et 60 °C/);
  assert.deepEqual(isg.writes(), [[1509, 600]]);
});

test('the option and the ceiling are checked again right before the write', async (t) => {
  let app;
  const isg = fakeIsg({
    behave: (request) => {
      if (request.fn === 3 && isg.requests.filter((r) => r.fn === 3).length > 1) {
        // Changed while the command reads the parameters.
        app.configUpdated({ ...ALLOWED, dhw_max_temperature: 45 });
      }
      return undefined;
    },
  });
  const setup1 = await setup(t, { isg, config: ALLOWED });
  app = setup1.app;
  const ack = await setup1.command('dhw-setpoint', 52);
  assert.match(ack.error, /plafonnée à 45 °C/);
  assert.deepEqual(isg.writes(), []);
});

test('already so: nothing written; a protected or unknown mode is never left', async (t) => {
  const isg = fakeIsg();
  const { command } = await setup(t, { isg, config: ALLOWED });
  assert.equal((await command('mode', 'program')).success, true);
  assert.equal((await command('heating-setpoint', 21)).success, true);
  assert.deepEqual(isg.writes(), []);
  isg.holding.set(1500, 0);
  assert.match((await command('mode', 'comfort')).error, /mode « Mode secours »/);
  isg.holding.set(1500, 9);
  assert.match((await command('mode', 'comfort')).error, /Mode inconnu \(9\)/);
  isg.holding.set(1509, 0x8000);
  assert.match((await command('dhw-setpoint', 50)).error, /pas donné la valeur actuelle/);
  assert.deepEqual(isg.writes(), []);
});

test('a write without answer: "sent, without confirmation", then read again', async (t) => {
  const isg = fakeIsg({
    behave: (request) => (request.fn === 6 ? 'silent-applied' : undefined),
  });
  const { gladys, command, advance } = await setup(t, { isg, config: ALLOWED });
  const ack = await command('heating-setpoint', 22);
  assert.match(ack.error, /Commande envoyée, sans confirmation \(timeout\)/);
  assert.deepEqual(isg.writes(), [[1501, 220]]);
  // The follow-up read (5 s after the answer) shows what the ISG did.
  await advance(5 * SECOND);
  assert.equal(last(gladys, 'heating-setpoint'), 22);
});

test('a guard: the ISG still shows the old value after a write, going back to it is sent', async (t) => {
  const isg = fakeIsg({
    // The ISG answers the write but shows the new value only later.
    behave: (request, state) => {
      if (request.fn === 6) {
        const previous = state.holding.get(request.address);
        setImmediate(() => state.holding.set(request.address, previous));
      }
      return undefined;
    },
  });
  const { command, advance } = await setup(t, { isg, config: ALLOWED });
  assert.equal((await command('heating-setpoint', 22, { wait: 0 })).success, true);
  await settle();
  // Never two writes back to back.
  assert.match((await command('mode', 'eco', { wait: 0 })).error, /encore en cours/);
  await advance(3 * SECOND);
  // The fresh read shows 21, the start value, which 21 asks: without the
  // guard this would be "already so" while 22 may still land.
  assert.equal((await command('heating-setpoint', 21, { wait: 0 })).success, true);
  assert.deepEqual(isg.writes(), [
    [1501, 220],
    [1501, 210],
  ]);
});

test('a Modbus exception on the write: refused by the ISG', async (t) => {
  const isg = fakeIsg({ behave: (request) => (request.fn === 6 ? { exception: 3 } : undefined) });
  const { command } = await setup(t, { isg, config: ALLOWED });
  const ack = await command('mode', 'eco');
  assert.match(ack.error, /L'ISG a refusé la commande \(Modbus exception 3\)/);
});

test('an ambiguous exception on the write (11): sent, without confirmation, guarded and read again', async (t) => {
  const isg = fakeIsg({
    // The gateway answers "no response from the target", the setting lands later.
    behave: (request, state) => {
      if (request.fn === 6) {
        setImmediate(() => state.holding.set(request.address, request.value));
        return { exception: 11 };
      }
      return undefined;
    },
  });
  const { gladys, command, app, advance } = await setup(t, { isg, config: ALLOWED });
  isg.holding.set(1500, 2);
  const ack = await command('mode', 'eco', { wait: 0 });
  assert.match(ack.error, /Commande envoyée, sans confirmation \(Modbus exception 11\)/);
  assert.ok(app.guardActive('wpm:mode'));
  await advance(5 * SECOND);
  assert.equal(last(gladys, 'mode'), 'eco');
  assert.equal(app.guardActive('wpm:mode'), false, 'lifted by the read showing it');
});

test('a write whose answer is not its echo: sent, without confirmation', async (t) => {
  const isg = fakeIsg({ behave: (request) => (request.fn === 6 ? 'bad-echo' : undefined) });
  const { command } = await setup(t, { isg, config: ALLOWED });
  assert.match((await command('mode', 'eco')).error, /sans confirmation \(protocol\)/);
});

test('a slow fresh read: refused unsent within the 5 s of Gladys', async (t) => {
  let slow = false;
  const isg = fakeIsg({ behave: (request) => (slow && request.fn === 3 ? 'silent' : undefined) });
  const { gladys, advance } = await setup(t, { isg, config: ALLOWED });
  slow = true;
  const d = gladys.fake.devices[0];
  const target = d.features.find((f) => f.external_id === feature('mode'));
  let ack;
  gladys.fake.setValue(d, target, 'eco').then((a) => (ack = a));
  await advance(4_900, 100);
  assert.ok(ack, 'answered within 5 s');
  assert.match(ack.error, /n'a pas pu être relue juste avant \(timeout\) : commande non envoyée/);
  assert.deepEqual(isg.writes(), []);
});

test('one command at a time', async (t) => {
  const isg = fakeIsg({ behave: (request) => (request.fn === 6 ? 'silent-applied' : undefined) });
  const { gladys, advance } = await setup(t, { isg, config: ALLOWED });
  const d = gladys.fake.devices[0];
  const mode = d.features.find((f) => f.external_id === feature('mode'));
  const setpoint = d.features.find((f) => f.external_id === feature('heating-setpoint'));
  const first = gladys.fake.setValue(d, mode, 'eco');
  await settle();
  const second = await gladys.fake.setValue(d, setpoint, 23);
  assert.match(second.error, /encore en cours/);
  await advance(5 * SECOND, 100);
  assert.match((await first).error, /sans confirmation/);
});

test('the ISG unreachable: status, badge, mode text; retried after 30 s, 1, 2, 5 min', async (t) => {
  const isg = fakeIsg();
  const { gladys, advance, command, app } = await setup(t, { isg, config: ALLOWED });
  isg.down = true;
  for (const s of isg.sockets) s.destroy();
  await settle();
  await advance(30 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /Lecture de l'ISG 192\.168\.1\.70 impossible \(unreachable/);
  assert.equal(last(gladys, 'operating-mode'), 'ISG injoignable');
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(last(gladys, 'temperature-flow'), 35.2, 'the other values keep their last one');
  const connects = isg.connects.length;
  await advance(29 * SECOND);
  assert.equal(isg.connects.length, connects);
  await advance(2 * SECOND);
  assert.equal(isg.connects.length, connects + 1);
  assert.match((await command('mode', 'eco')).error, /pas le régulateur lu actuellement/);
  isg.down = false;
  await advance(MINUTE + SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
  assert.ok(app.live);
});

test('an unknown controller is named in the status and read again every 30 min', async (t) => {
  const registers = wpmRegisters();
  registers.input[5001] = 999;
  const isg = fakeIsg({ registers });
  const { gladys, advance } = await setup(t, { isg, create: false });
  assert.match(message(gladys).fr, /Régulateur inconnu \(identification 999\)/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  const count = isg.requests.length;
  await advance(29 * MINUTE, 10 * SECOND);
  assert.equal(isg.requests.length, count);
  await advance(MINUTE, 10 * SECOND);
  assert.equal(isg.requests.length, count + 1);
});

test('a block the controller does not serve is dropped; a core block refused fails the poll', async (t) => {
  const isg = fakeIsg({
    behave: (request) =>
      request.fn === 4 && request.address === 3500 ? { exception: 2 } : undefined,
  });
  const { gladys, advance } = await setup(t, { isg, create: false });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(!roles(discovered(gladys)).some((r) => r.startsWith('energy-')));
  const energyReads = () => isg.requests.filter((r) => r.address === 3500).length;
  assert.equal(energyReads(), 1);
  await advance(30 * SECOND);
  assert.equal(energyReads(), 1, 'not read again');
  isg.behave = (request) =>
    request.fn === 4 && request.address === 509 ? { exception: 4 } : undefined;
  await advance(30 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /Modbus exception 4/);
});

test('a secondary block failing after it answered: noted, its values dropped, the rest published', async (t) => {
  const isg = fakeIsg();
  const { gladys, advance, logs } = await setup(t, { isg });
  isg.behave = (request) =>
    request.fn === 4 && request.address === 3500 ? { exception: 4 } : undefined;
  isg.input.set(514, 400);
  await advance(30 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Certains registres n'ont pas pu être lus \(energy\)/);
  assert.equal(last(gladys, 'temperature-flow'), 40);
  assert.equal(logs.filter((l) => /energy registers failed/.test(l)).length, 1);
  await advance(30 * SECOND);
  assert.equal(logs.filter((l) => /energy registers failed/.test(l)).length, 1, 'logged once');
  isg.behave = undefined;
  await advance(30 * SECOND);
  assert.doesNotMatch(message(gladys).fr, /Certains registres/);
});

test('a republished device never loses a feature', async (t) => {
  const isg = fakeIsg();
  const { gladys, advance } = await setup(t, { isg });
  const before = roles(discovered(gladys));
  isg.input.set(500, 0x8000);
  isg.input.set(2503, 0x8000);
  await gladys.fake.scanRequest();
  await advance(30 * SECOND);
  await gladys.fake.scanRequest();
  assert.deepEqual(roles(discovered(gladys)), before);
});

test('a reconnection to Gladys resends status, devices and badge, without a new read', async (t) => {
  const isg = fakeIsg();
  const { gladys } = await setup(t, { isg });
  const devices = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  const transports = gladys.fake.transports.length;
  const count = reads(isg);
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, devices + 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(gladys.fake.transports.length > transports);
  assert.equal(reads(isg), count);
});

test('the test button reads now, at most every 10 s', async (t) => {
  const isg = fakeIsg();
  const { gladys } = await setup(t, { isg });
  const count = reads(isg);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /Connecté : WPM 3/);
  assert.ok(reads(isg) > count);
  const again = reads(isg);
  const second = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(second.data.message.fr, /moins de 10 s/);
  assert.equal(reads(isg), again);
});

test('logs never carry register values nor the answers of the ISG', async (t) => {
  const logs = [];
  const isg = fakeIsg({ behave: (request) => (request.fn === 6 ? { exception: 3 } : undefined) });
  const { command } = await setup(t, { isg, config: ALLOWED, logs });
  await command('dhw-setpoint', 50);
  await command('dhw-setpoint', 48);
  assert.ok(logs.every((l) => !/12345|3123/.test(l)));
});

test('an LWZ R290 (551) is read with the WPM map and written at the WPM addresses', async (t) => {
  const registers = wpmRegisters();
  registers.input[5001] = 551;
  const isg = fakeIsg({ registers });
  const { gladys, command } = await setup(t, { isg, config: ALLOWED });
  const d = discovered(gladys, 'wpm');
  assert.equal(d.model, 'STIEBEL ELTRON LWZ R290');
  assert.equal(discovered(gladys, 'lwz'), undefined);
  assert.ok(
    isg.requests.every((r) => r.address >= 500),
    'never the LWZ addresses',
  );
  assert.equal(last(gladys, 'temperature-flow'), 35.2);
  assert.equal((await command('mode', 'eco')).success, true);
  assert.deepEqual(isg.writes(), [[1500, 4]]);
});

test('a start refused by the ISG is read again from a start it answered (ReadStartRetry)', async (t) => {
  // A WPM 3 that refuses reads starting at 509 and at 2503, though it serves them.
  const isg = fakeIsg({
    behave: (request) =>
      request.fn === 4 && [509, 2503].includes(request.address) ? { exception: 2 } : undefined,
  });
  const { gladys } = await setup(t, { isg });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'temperature-flow'), 35.2);
  assert.equal(last(gladys, 'temperature-dhw'), 48.2);
  assert.equal(last(gladys, 'fault'), 0);
  assert.ok(isg.requests.some((r) => r.address === 500 && r.count === 23));
  assert.ok(isg.requests.some((r) => r.address === 2500 && r.count === 4));
});

test('a retry that fails too: the core block fails the poll, a secondary one is dropped', async (t) => {
  const isg = fakeIsg({
    behave: (request) =>
      request.fn === 4 && request.address === 500 && request.count !== 8
        ? { exception: 2 }
        : request.fn === 4 && request.address === 509
          ? { exception: 2 }
          : undefined,
  });
  const { gladys } = await setup(t, { isg, create: false });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /Modbus exception 2/);
  assert.equal(gladys.fake.discoveredDevices.length, 0, 'no device for a controller never read');
});

test('a controller id still unavailable (0x8000) is a passing failure, not an unknown controller', async (t) => {
  const registers = wpmRegisters();
  registers.input[5001] = 0x8000;
  const isg = fakeIsg({ registers });
  const { gladys, advance } = await setup(t, { isg, create: false });
  assert.match(message(gladys).en, /controller unavailable; next try in 30 s/);
  assert.doesNotMatch(message(gladys).en, /Unknown controller/);
  isg.input.set(5001, 390);
  await advance(31 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});
