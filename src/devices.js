// -----------------------------------------------------------------------------
// The heat pump -> one Gladys device and its states (pure).
//
// `ext:<selector>:stiebel-eltron:<family>`: one ISG per integration, one
// device per controller family (`wpm` or `lwz`: their registers mean
// different things). Modbus gives no serial number nor MAC address, and the
// IP address may change: the family is the only stable key there is. The
// feature roles (the last part of their external ids) are published
// forever: never rename them.
//
// A feature appears once its register gave a value; a device published
// again never loses a feature: those of the device already created in
// Gladys are kept as they are (the core would mark it `structure_changed`,
// and "Update" would delete the missing feature and its history).
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach the heat pump.
// The commands are the operating mode (`text/select`), the heating setpoint
// (`thermostat/target-temperature`) and the hot water setpoint
// (`water-heater/target-temperature`), refused unless the configuration
// allows them (src/app.js). Compressor, booster and fault are read-only
// `unknown/binary`.
//
// Energy (lot 6 and wave 2 lessons): never an `energy-sensor` index. The
// ISG gives a counter of the day and a total that, as far as the manual and
// pystiebeleltron say, does not include the day (pystiebeleltron sums the
// two and keeps the highest value seen, a sign the sum is not monotonic
// around midnight). Nothing confirms it is cumulative and reliable, so the
// values are plain `unknown/decimal` sensors, the unit in their name, and
// the core never bills them.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on `temperature-sensor`,
// `thermostat` and `water-heater`, % on `humidity-sensor`. Water, outside
// temperatures and setpoints are `probe`, kept out of the room temperature
// of the core; only the room temperatures are `decimal`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DHW_CAP, FEATURES as F } from './constants.js';
import { COMMANDS, FAMILIES, SELECTABLE } from './isg.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, STATE_TEXTS, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const probe = (min = -60, max = 120) =>
  sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.TEMPERATURE_SENSOR.PROBE,
    unit: U.CELSIUS,
    min,
    max,
  });
const room = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -60,
  max: 120,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const energy = sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: 0, max: 100_000_000 });

/** The features, by role, in display order; `family` gives the setpoint ranges. */
export function definitionOf(role, family) {
  switch (role) {
    case F.MODE:
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: true,
        keep_history: false,
      };
    case F.MODE_STATE:
      return sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
    case F.HEATING_SETPOINT: {
      const { min, max } = COMMANDS[family].heatingSetpoint;
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min,
        max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    }
    case F.DHW_SETPOINT: {
      const { min, max } = COMMANDS[family].dhwSetpoint;
      return {
        category: C.WATER_HEATER,
        type: T.WATER_HEATER.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        // The slider stops at the hard ceiling; the configured one refuses below it.
        min,
        max: Math.min(max, DHW_CAP.max),
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    }
    case F.HEATING_SETPOINT_ECO:
    case F.DHW_SETPOINT_ECO:
    case F.DHW_TARGET:
      return probe(0, 90);
    case F.TEMP_ROOM:
    case F.TEMP_ROOM_FE7:
    case F.TEMP_ROOM_FEK:
      return room;
    case F.HUMIDITY:
      return sensor({
        category: C.HUMIDITY_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.PERCENT,
        min: 0,
        max: 100,
      });
    case F.COMPRESSOR:
    case F.BOOSTER:
    case F.FAULT:
      return binary;
    case F.TEMP_OUTDOOR:
    case F.TEMP_FLOW:
    case F.TEMP_RETURN:
    case F.TEMP_DHW:
      return probe();
    default:
      return energy;
  }
}

/** Where each read-only number or flag comes from in the decoded values (src/isg.js). */
const VALUES = {
  [F.HEATING_SETPOINT]: (v) => v.heatingSetpoint,
  [F.HEATING_SETPOINT_ECO]: (v) => v.heatingSetpointEco,
  [F.DHW_SETPOINT]: (v) => v.dhwSetpoint,
  [F.DHW_SETPOINT_ECO]: (v) => v.dhwSetpointEco,
  [F.DHW_TARGET]: (v) => v.dhwTarget,
  [F.TEMP_OUTDOOR]: (v) => v.outdoor,
  [F.TEMP_FLOW]: (v) => v.flow,
  [F.TEMP_RETURN]: (v) => v.return,
  [F.TEMP_DHW]: (v) => v.dhw,
  [F.TEMP_ROOM]: (v) => v.room,
  [F.TEMP_ROOM_FE7]: (v) => v.roomFe7,
  [F.TEMP_ROOM_FEK]: (v) => v.roomFek,
  [F.HUMIDITY]: (v) => v.humidity,
  [F.COMPRESSOR]: (v) => v.compressor,
  [F.BOOSTER]: (v) => v.booster,
  [F.FAULT]: (v) => v.fault,
  [F.CONSUMED_HEATING_TODAY]: (v) => v.energy?.consumedHeatingToday,
  [F.CONSUMED_HEATING_TOTAL]: (v) => v.energy?.consumedHeatingTotal,
  [F.CONSUMED_DHW_TODAY]: (v) => v.energy?.consumedDhwToday,
  [F.CONSUMED_DHW_TOTAL]: (v) => v.energy?.consumedDhwTotal,
  [F.PRODUCED_HEATING_TODAY]: (v) => v.energy?.producedHeatingToday,
  [F.PRODUCED_HEATING_TOTAL]: (v) => v.energy?.producedHeatingTotal,
  [F.PRODUCED_DHW_TODAY]: (v) => v.energy?.producedDhwToday,
  [F.PRODUCED_DHW_TOTAL]: (v) => v.energy?.producedDhwTotal,
  [F.BOOSTER_HEATING_TOTAL]: (v) => v.energy?.boosterHeatingTotal,
  [F.BOOSTER_DHW_TOTAL]: (v) => v.energy?.boosterDhwTotal,
};

export const ROLES = [F.MODE, F.MODE_STATE, ...Object.keys(VALUES)];
export const COMMAND_ROLES = [F.MODE, F.HEATING_SETPOINT, F.DHW_SETPOINT];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, family) => gladys.externalIds('stiebel-eltron', family);

/** The family and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = /:stiebel-eltron:([a-z]+):([a-z0-9-]+)$/.exec(externalId);
  if (!match || !FAMILIES.includes(match[1]) || !ROLES.includes(match[2])) {
    return undefined;
  }
  return { family: match[1], role: match[2] };
}

/** The family of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:stiebel-eltron:([a-z]+)$/.exec(String(externalId ?? ''));
  return match && FAMILIES.includes(match[1]) ? match[1] : undefined;
}

/** The roles the values of one poll report (a value read, not unavailable). */
export function reportedRoles(values) {
  const roles = new Set();
  if (values.mode !== undefined) {
    roles.add(F.MODE);
    roles.add(F.MODE_STATE);
  }
  for (const [role, valueOf] of Object.entries(VALUES)) {
    if (valueOf(values) !== undefined) {
      roles.add(role);
    }
  }
  return roles;
}

export function modeOptions(family, language) {
  return SELECTABLE[family].map((key, index) => ({
    value: key,
    label: word(MODE_NAMES[key], language),
    sort_order: index,
  }));
}

/**
 * The Gladys device of the heat pump. `roles`: those seen; `created`: the
 * device already created in Gladys, whose features are kept when the new
 * build lacks them.
 */
export function buildDevice(gladys, family, { roles, controller, language, created }) {
  const ids = deviceIds(gladys, family);
  const params = [{ name: 'family', value: family }];
  if (controller) {
    params.push({ name: 'controller', value: `${controller.model} (${controller.code})` });
  }
  const built = {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: controller ? `STIEBEL ELTRON ${controller.model}` : 'STIEBEL ELTRON',
    should_poll: false,
    features: ROLES.filter((role) => roles.has(role)).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role, family),
      ...(role === F.MODE ? { supported_options: modeOptions(family, language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The text of the operating mode read. */
export function modeText(mode, language) {
  if (mode.key) {
    return word(MODE_NAMES[mode.key], language);
  }
  return word(STATE_TEXTS.unknownMode(mode.code), language);
}

/**
 * The current values of the device. `status`: 'online', or 'offline' (the
 * ISG does not answer) and 'other' (another controller family answers):
 * then only the mode text changes, Gladys keeps the last value of the others.
 */
export function deviceStates(ids, family, values, { status = 'online', language }) {
  if (status !== 'online') {
    const text = status === 'other' ? STATE_TEXTS.otherController : STATE_TEXTS.offline;
    return [{ device_feature_external_id: ids.feature(F.MODE_STATE), text: word(text, language) }];
  }
  const states = [];
  if (values.mode !== undefined) {
    states.push({ role: F.MODE_STATE, text: modeText(values.mode, language) });
    if (SELECTABLE[family].includes(values.mode.key)) {
      states.push({ role: F.MODE, text: values.mode.key });
    }
  }
  for (const [role, valueOf] of Object.entries(VALUES)) {
    const value = valueOf(values);
    if (value !== undefined && Number.isFinite(value)) {
      states.push({ role, state: value });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
