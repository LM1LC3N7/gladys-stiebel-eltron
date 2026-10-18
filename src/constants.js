// -----------------------------------------------------------------------------
// Constants: Modbus, manifest keys, feature roles, limits and timings.
//
// The ISG (Internet Service Gateway) of a STIEBEL ELTRON heat pump answers
// Modbus TCP on port 502, unit 1, without authentication, once its Modbus
// module is enabled (as pystiebeleltron 0.9.2 and Home Assistant read it).
// The register map lives in src/isg.js.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;
/** The Modbus unit (slave) id of the ISG (Home Assistant's UNIT_ID). */
export const UNIT_ID = 1;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  MODE_STATE: 'operating-mode',
  HEATING_SETPOINT: 'heating-setpoint',
  HEATING_SETPOINT_ECO: 'heating-setpoint-eco',
  DHW_SETPOINT: 'dhw-setpoint',
  DHW_SETPOINT_ECO: 'dhw-setpoint-eco',
  DHW_TARGET: 'dhw-target',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_FLOW: 'temperature-flow',
  TEMP_RETURN: 'temperature-return',
  TEMP_DHW: 'temperature-dhw',
  TEMP_ROOM: 'temperature-room',
  TEMP_ROOM_FE7: 'temperature-room-fe7',
  TEMP_ROOM_FEK: 'temperature-room-fek',
  HUMIDITY: 'humidity',
  COMPRESSOR: 'compressor',
  BOOSTER: 'booster',
  FAULT: 'fault',
  CONSUMED_HEATING_TODAY: 'energy-consumed-heating-today',
  CONSUMED_HEATING_TOTAL: 'energy-consumed-heating-total',
  CONSUMED_DHW_TODAY: 'energy-consumed-dhw-today',
  CONSUMED_DHW_TOTAL: 'energy-consumed-dhw-total',
  PRODUCED_HEATING_TODAY: 'energy-produced-heating-today',
  PRODUCED_HEATING_TOTAL: 'energy-produced-heating-total',
  PRODUCED_DHW_TODAY: 'energy-produced-dhw-today',
  PRODUCED_DHW_TOTAL: 'energy-produced-dhw-total',
  BOOSTER_HEATING_TOTAL: 'energy-booster-heating-total',
  BOOSTER_DHW_TOTAL: 'energy-booster-dhw-total',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds (Home Assistant: 30 s). */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

/**
 * The hot water setpoint the commands may set, in °C (scalding risk). The
 * configuration chooses the ceiling between `min` and `max`, 55 °C by
 * default; nothing above 60 °C is ever sent, whatever the configuration or
 * the controller would accept (65 °C on some LWZ).
 */
export const DHW_CAP = {
  min: 40,
  max: 60,
  default: 55,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Modbus TCP: 7 bytes of MBAP header + a PDU of 253 bytes at most. */
  frameBytes: 260,
  /** Registers in one read (Modbus: 125 at most). */
  registersPerRead: 125,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection to the ISG. */
  connectTimeout: 3 * SECOND,
  /** One Modbus request of the polling (the ISG answers in well under a second). */
  requestTimeout: 3 * SECOND,
  /** Failed polls: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** A controller the integration does not know: read again every 30 minutes. */
  unsupportedRetry: 30 * MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the ISG at most this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 2 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_000,
  commandMinRead: 300,
  commandMinSend: 300,
  /** After a write that may have left, the next command waits this long ("still running"). */
  commandSpacing: 3 * SECOND,
  /** Polls after a command, spaced: its effect (the ISG takes a few seconds), then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
};
