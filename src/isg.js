// -----------------------------------------------------------------------------
// The registers of the ISG, ported from pystiebeleltron 0.9.2 (MIT): its
// register tables (api/*.csv, transcribed from the STIEBEL ELTRON Modbus
// manual) and its generated modules (wpm.py, wpm3.py, wpm3i.py, lwz.py).
// Addresses here are the zero-based PDU addresses, the manual's numbers
// minus one, as pystiebeleltron generates them.
//
// Two families of controllers, told apart by the controller identification
// (input register 5001, manual 5002):
//   - WPM: WPM 3 (390), WPM 3i (391), WPMsystem (449);
//   - LWZ / LWA integral units: 103, 104 and the LWZ R290 (551).
// Each reads only the registers this integration shows, in blocks that stay
// inside the ranges pystiebeleltron lists for every variant (a WPM 3 does not
// serve 508, a WPM 3i not 527-531...): a read across a hole would be refused
// as a whole.
//
// Values: 0x8000 is the ISG's "unavailable" (pystiebeleltron UNAVAILABLE);
// some WPM 3i registers also give 0x9000, which every plausibility range
// below rejects. A value outside its range is unknown, never published.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, ILLEGAL_DATA_ADDRESS, ModbusError } from './modbus/client.js';

export const UNAVAILABLE = 0x8000;

/** Input register of the controller identification (manual 5002). */
export const CONTROLLER_REGISTER = 5001;

/** The controllers known, by identification (pystiebeleltron ControllerModel). */
export const CONTROLLERS = {
  103: { family: 'lwz', variant: 'lwz', model: 'LWZ / LWA' },
  104: { family: 'lwz', variant: 'lwz', model: 'LWZ x04 SOL' },
  551: { family: 'lwz', variant: 'lwz', model: 'LWZ R290' },
  390: { family: 'wpm', variant: 'wpm3', model: 'WPM 3' },
  391: { family: 'wpm', variant: 'wpm3i', model: 'WPM 3i' },
  449: { family: 'wpm', variant: 'wpmsystem', model: 'WPMsystem' },
};

export const FAMILIES = ['wpm', 'lwz'];

/**
 * The blocks read at each poll, by variant. `core`: the poll fails without
 * it. Otherwise a Modbus exception on the block drops its values for that
 * poll only (the main values are still published); an "illegal data
 * address" on a block never answered means the controller does not have it:
 * not read again until a restart.
 */
const WPM_BLOCKS = [
  // FE7 / FEK room temperatures, humidity, outside, heating circuit 1.
  { name: 'values', space: 'input', start: 500, count: 8, core: true },
  // Flow, return, hot water (508 is not served by a WPM 3).
  { name: 'values2', space: 'input', start: 509, count: 14, core: true },
  { name: 'parameters', space: 'holding', start: 1500, count: 11 },
  { name: 'status', space: 'input', start: 2500, count: 1 },
  { name: 'fault', space: 'input', start: 2503, count: 1 },
  { name: 'energy', space: 'input', start: 3500, count: 16 },
];

export const BLOCKS = {
  wpm3: WPM_BLOCKS,
  wpm3i: WPM_BLOCKS,
  wpmsystem: [
    ...WPM_BLOCKS,
    // WPMsystem only: room temperature of heating circuit 1 (FET), the
    // electric booster stages and the six compressors.
    { name: 'room', space: 'input', start: 583, count: 1 },
    { name: 'booster', space: 'input', start: 2524, count: 3 },
    { name: 'compressors', space: 'input', start: 2541, count: 6 },
  ],
  lwz: [
    { name: 'values', space: 'input', start: 0, count: 17, core: true },
    { name: 'parameters', space: 'holding', start: 1000, count: 14 },
    { name: 'status', space: 'input', start: 2000, count: 2 },
    { name: 'energy', space: 'input', start: 3000, count: 27 },
  ],
};

/**
 * The operating modes (holding register 1500 on a WPM, 1000 on an LWZ), as
 * the manual numbers them (pystiebeleltron's OperatingMode for the LWZ).
 */
export const MODES = {
  wpm: { 0: 'emergency', 1: 'standby', 2: 'program', 3: 'comfort', 4: 'eco', 5: 'dhw' },
  lwz: {
    0: 'emergency',
    1: 'standby',
    3: 'day',
    4: 'setback',
    5: 'dhw',
    11: 'automatic',
    14: 'manual',
  },
};

/**
 * The modes Gladys may select, in display order. Never the emergency mode
 * (the installer's, when the compressor is out) nor the LWZ manual mode (a
 * service mode with its own flow and hot water setpoints).
 */
export const SELECTABLE = {
  wpm: ['program', 'comfort', 'eco', 'dhw', 'standby'],
  lwz: ['automatic', 'day', 'setback', 'dhw', 'standby'],
};

/** Modes a command never leaves: the installer chose them. */
export const PROTECTED_MODES = new Set(['emergency', 'manual']);

/**
 * The registers the commands write, with the range the manual gives. The
 * heating setpoint is the comfort temperature of heating circuit 1 (WPM) or
 * the day room temperature of heating circuit 1 (LWZ, as Home Assistant);
 * the hot water setpoint the comfort (WPM) or day (LWZ) temperature.
 */
export const COMMANDS = {
  wpm: {
    mode: 1500,
    heatingSetpoint: { address: 1501, min: 5, max: 30 },
    dhwSetpoint: { address: 1509, min: 10, max: 60 },
  },
  lwz: {
    mode: 1000,
    heatingSetpoint: { address: 1001, min: 10, max: 30 },
    dhwSetpoint: { address: 1011, min: 10, max: 65 },
  },
};

/** The holding block a command reads again just before writing. */
export const PARAMETERS = {
  wpm: { start: 1500, count: 11 },
  lwz: { start: 1000, count: 14 },
};

// --- Decoding -------------------------------------------------------------------

const signed = (word) => (word >= 0x8000 ? word - 0x10000 : word);

const within = (value, min, max) =>
  value !== undefined && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

/** A temperature in tenths of °C (manual data type 2), or undefined. */
export function tenths(word, min = -60, max = 120) {
  if (word === undefined || word === UNAVAILABLE) {
    return undefined;
  }
  return within(Math.round(signed(word)) / 10, min, max);
}

/** An unsigned value (data type 6), or undefined. */
export function unsigned(word, max = 0x7fff) {
  if (word === undefined || word === UNAVAILABLE) {
    return undefined;
  }
  return within(word, 0, max);
}

/** 0 or 1, else undefined. */
export function flag(word) {
  return word === 0 || word === 1 ? word : undefined;
}

/**
 * An energy total split over two registers (pystiebeleltron scaled_sum):
 * kWh below 1000 + MWh. Undefined when either is unavailable or the kWh part
 * is out of its documented 0-999.
 */
export function total(low, high) {
  const kwh = unsigned(low, 999);
  const mwh = unsigned(high);
  return kwh === undefined || mwh === undefined ? undefined : mwh * 1000 + kwh;
}

const bit = (word, n) => (word === undefined ? undefined : (word >> n) & 1);

/** Any of the flags on (1), all known and off (0), else undefined. */
function anyOn(words) {
  const flags = words.map(flag);
  if (flags.includes(1)) {
    return 1;
  }
  return flags.length > 0 && flags.every((f) => f === 0) ? 0 : undefined;
}

/** The mode of a register word: `{ code, key }`, `key` undefined when unknown. */
export function modeOf(family, word) {
  if (word === undefined || word === UNAVAILABLE) {
    return undefined;
  }
  return { code: word, key: Object.hasOwn(MODES[family], word) ? MODES[family][word] : undefined };
}

/**
 * The values of one poll. `raw`: `{ input: Map, holding: Map }` of the
 * register words read (address -> word). Every value is undefined when its
 * register was not read, unavailable or out of range.
 */
export function decode(family, raw) {
  const input = (address) => raw.input?.get(address);
  const holding = (address) => raw.holding?.get(address);
  return family === 'lwz' ? decodeLwz(input, holding) : decodeWpm(input, holding);
}

const setpoint = (word) => tenths(word, 0, 90);

function decodeWpm(input, holding) {
  // Operating status (manual 2501, bit-coded): bit 3 electric booster
  // stages running, bit 6 compressor running.
  const status = unsigned(input(2500), 0xffff);
  const compressors = [2541, 2542, 2543, 2544, 2545, 2546].map(input);
  const boosters = [2524, 2525, 2526].map(input);
  return {
    roomFe7: tenths(input(500)),
    roomFek: tenths(input(502)),
    humidity: tenths(input(504), 0, 100),
    outdoor: tenths(input(506)),
    room: tenths(input(583)),
    flow: tenths(input(514)),
    return: tenths(input(515)),
    dhw: tenths(input(521)),
    dhwTarget: setpoint(input(522)),
    mode: modeOf('wpm', holding(1500)),
    heatingSetpoint: setpoint(holding(1501)),
    heatingSetpointEco: setpoint(holding(1502)),
    dhwSetpoint: setpoint(holding(1509)),
    dhwSetpointEco: setpoint(holding(1510)),
    // WPMsystem: the compressor and booster registers when it serves them;
    // otherwise the bits of the operating status.
    compressor: compressors.some((w) => w !== undefined) ? anyOn(compressors) : bit(status, 6),
    booster: boosters.some((w) => w !== undefined) ? anyOn(boosters) : bit(status, 3),
    fault: flag(input(2503)),
    energy: {
      producedHeatingToday: unsigned(input(3500)),
      producedHeatingTotal: total(input(3501), input(3502)),
      producedDhwToday: unsigned(input(3503)),
      producedDhwTotal: total(input(3504), input(3505)),
      boosterHeatingTotal: total(input(3506), input(3507)),
      boosterDhwTotal: total(input(3508), input(3509)),
      consumedHeatingToday: unsigned(input(3510)),
      consumedHeatingTotal: total(input(3511), input(3512)),
      consumedDhwToday: unsigned(input(3513)),
      consumedDhwTotal: total(input(3514), input(3515)),
    },
  };
}

function decodeLwz(input, holding) {
  // Operating status (manual 2001, bit-coded; pystiebeleltron reads bit 2
  // heating, 3 cooling, 8/12/13 filters): bit 1 compressor, bit 5 electric
  // reheating.
  const status = unsigned(input(2000), 0xffff);
  return {
    room: tenths(input(0)),
    humidity: tenths(input(2), 0, 100),
    outdoor: tenths(input(6)),
    flow: tenths(input(11)),
    return: tenths(input(12)),
    dhw: tenths(input(15)),
    dhwTarget: setpoint(input(16)),
    mode: modeOf('lwz', holding(1000)),
    heatingSetpoint: setpoint(holding(1001)),
    heatingSetpointEco: setpoint(holding(1002)),
    dhwSetpoint: setpoint(holding(1011)),
    dhwSetpointEco: setpoint(holding(1012)),
    compressor: bit(status, 1),
    booster: bit(status, 5),
    fault: flag(input(2001)),
    energy: {
      producedHeatingToday: unsigned(input(3000)),
      producedHeatingTotal: total(input(3001), input(3002)),
      producedDhwToday: unsigned(input(3003)),
      producedDhwTotal: total(input(3004), input(3005)),
      boosterHeatingTotal: total(input(3006), input(3007)),
      boosterDhwTotal: total(input(3008), input(3009)),
      consumedHeatingToday: unsigned(input(3021)),
      consumedHeatingTotal: total(input(3022), input(3023)),
      consumedDhwToday: unsigned(input(3024)),
      consumedDhwTotal: total(input(3025), input(3026)),
    },
  };
}

/** A setpoint in °C -> the register word (tenths, two's complement). */
export function setpointWord(value) {
  return Math.round(value * 10) & 0xffff;
}

// --- Reading ----------------------------------------------------------------------

/** The controller identification, a number, or a ModbusError. */
export async function readController(client, options) {
  const [word] = await client.readInput(CONTROLLER_REGISTER, 1, options);
  return word;
}

/**
 * Reads the blocks of a variant. `blocks`: the state kept across polls
 * (`{ answered: Set, absent: Set, failing: Set }`). Returns the raw words
 * and the names of the blocks that failed this time. A connection-level
 * error (timeout, closed, unreachable, protocol) fails the whole poll: the
 * next requests would fail the same way.
 */
export async function readBlocks(client, variant, blocks, { logger, options } = {}) {
  const raw = { input: new Map(), holding: new Map() };
  const failed = [];
  for (const block of BLOCKS[variant]) {
    if (blocks.absent.has(block.name)) {
      continue;
    }
    let words;
    try {
      words =
        block.space === 'input'
          ? await client.readInput(block.start, block.count, options)
          : await client.readHolding(block.start, block.count, options);
    } catch (err) {
      if (!(err instanceof ModbusError) || err.kind !== ERROR_KINDS.EXCEPTION || block.core) {
        throw err;
      }
      if (err.code === ILLEGAL_DATA_ADDRESS && !blocks.answered.has(block.name)) {
        blocks.absent.add(block.name);
        logger?.info(`ISG: the controller does not serve the ${block.name} registers`);
        continue;
      }
      failed.push(block.name);
      if (!blocks.failing.has(block.name)) {
        blocks.failing.add(block.name);
        logger?.warn(
          `ISG: reading the ${block.name} registers failed (Modbus exception ${err.code})`,
        );
      }
      continue;
    }
    if (blocks.failing.delete(block.name)) {
      logger?.info(`ISG: the ${block.name} registers are read again`);
    }
    blocks.answered.add(block.name);
    words.forEach((word, i) => raw[block.space].set(block.start + i, word));
  }
  return { raw, failed };
}

export const freshBlocks = () => ({ answered: new Set(), absent: new Set(), failing: new Set() });
