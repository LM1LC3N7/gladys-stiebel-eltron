// -----------------------------------------------------------------------------
// A minimal Modbus TCP client on node:net: read holding registers (function
// 3), read input registers (4) and write one register (6), the only three
// functions the ISG needs. Written here rather than taken from npm (see
// TODO.md "Decisions"): about 300 lines, no dependency, and the rules of a
// local protocol enforced in one place:
//
//   - one request at a time (the Gate), never two on the wire: an answer is
//     always the answer of the one request in flight;
//   - every answer is attributed to its request: transaction id, protocol id
//     0, unit id and function code must all match, the byte count must be
//     the one asked, a write must echo its address and value exactly;
//     anything else is a PROTOCOL error and the connection is dropped;
//   - bounded: a frame is 260 bytes at most, a read 125 registers at most;
//     a byte beyond the frame, or arriving with no request in flight, drops
//     the connection;
//   - a request that times out drops the connection too, so a late answer
//     can never be taken for the answer of the next request;
//   - `sent` says whether the request reached the socket: a write that may
//     have left is never reported "not sent".
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';

export const ERROR_KINDS = {
  /** No TCP connection could be opened: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time (the connection is dropped). */
  TIMEOUT: 'timeout',
  /** The connection closed while a request was in flight. */
  CLOSED: 'closed',
  /** An answer that does not belong to the request (the connection is dropped). */
  PROTOCOL: 'protocol',
  /** A Modbus exception answer (code 1 to 11): the ISG refused the request. */
  EXCEPTION: 'exception',
  /** Still waiting for its turn (or its connection) at its deadline: nothing was sent. */
  LATE: 'late',
};

/** Modbus exception code 2: the register is not served by this controller. */
export const ILLEGAL_DATA_ADDRESS = 2;

export class ModbusError extends Error {
  constructor(kind, { code, sent = false, detail } = {}) {
    super(code === undefined ? kind : `${kind} ${code}`);
    this.name = 'ModbusError';
    this.kind = kind;
    this.code = code;
    this.sent = sent;
    this.detail = detail;
  }
}

/** A short reason for the logs and the messages: our own words only. */
export function errorReason(err) {
  if (err instanceof ModbusError) {
    return err.kind === ERROR_KINDS.EXCEPTION ? `Modbus exception ${err.code}` : err.kind;
  }
  return 'error';
}

const FUNCTION = { READ_HOLDING: 3, READ_INPUT: 4, WRITE_SINGLE: 6 };
const HEADER = 7;

const isWord = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff;

/**
 * One job at a time, in order; `first` jobs (commands) pass before the
 * others but never cut the job running. A job still queued at `startBy`
 * leaves the queue, rejected LATE (never run).
 */
export class Gate {
  constructor({ timers = globalThis, now = Date.now } = {}) {
    this.timers = timers;
    this.now = now;
    this.queue = [];
    this.running = false;
  }

  run(fn, { first = false, startBy } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, first, timer: undefined };
      if (startBy !== undefined) {
        job.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new ModbusError(ERROR_KINDS.LATE));
            }
          },
          Math.max(0, startBy - this.now()),
        );
      }
      if (first) {
        const at = this.queue.findIndex((queued) => !queued.first);
        this.queue.splice(at === -1 ? this.queue.length : at, 0, job);
      } else {
        this.queue.push(job);
      }
      this.pump();
    });
  }

  pump() {
    if (this.running || this.queue.length === 0) {
      return;
    }
    const job = this.queue.shift();
    if (job.timer !== undefined) {
      this.timers.clearTimeout(job.timer);
    }
    this.running = true;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }
}

export class ModbusClient {
  constructor({
    host,
    port,
    unitId,
    connect = (options) => net.createConnection(options),
    timers = globalThis,
    now = Date.now,
  }) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.connect = connect;
    this.timers = timers;
    this.now = now;
    this.gate = new Gate({ timers, now });
    this.socket = undefined;
    this.connecting = undefined;
    this.pending = undefined;
    this.transaction = 0;
    this.closed = false;
    /** The requests without the gate, for a session that holds it. */
    this.raw = {
      readInput: (address, count, options) =>
        this.read(FUNCTION.READ_INPUT, address, count, options),
      readHolding: (address, count, options) =>
        this.read(FUNCTION.READ_HOLDING, address, count, options),
      writeRegister: (address, value, options) => this.write(address, value, options),
    };
  }

  // --- Public, through the gate ------------------------------------------------

  readInput(address, count, options = {}) {
    return this.gate.run(() => this.raw.readInput(address, count, options));
  }

  readHolding(address, count, options = {}) {
    return this.gate.run(() => this.raw.readHolding(address, count, options));
  }

  /**
   * Holds the gate for `fn(raw)`: no other request runs in between (a
   * command: its fresh read, then its write). Passes before the queued
   * reads; still queued at `startBy`, it is rejected LATE, never run.
   */
  session(fn, { startBy } = {}) {
    return this.gate.run(() => fn(this.raw), { first: true, startBy });
  }

  /** Drops the connection (a stop, another address). */
  close() {
    this.closed = true;
    this.drop(new ModbusError(ERROR_KINDS.CLOSED, { sent: true }));
  }

  // --- Requests ----------------------------------------------------------------

  read(fn, address, count, options) {
    if (
      !Number.isInteger(address) ||
      !Number.isInteger(count) ||
      address < 0 ||
      count < 1 ||
      count > LIMITS.registersPerRead ||
      address + count > 0x10000
    ) {
      return Promise.reject(new RangeError('Invalid Modbus read'));
    }
    const pdu = Buffer.from([fn, address >> 8, address & 0xff, count >> 8, count & 0xff]);
    return this.transact(pdu, options, (answer) => {
      const bytes = answer[1];
      if (answer.length < 2 || bytes !== count * 2 || answer.length !== 2 + bytes) {
        throw new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail: 'byte count' });
      }
      const words = [];
      for (let i = 0; i < count; i += 1) {
        words.push(answer.readUInt16BE(2 + i * 2));
      }
      return words;
    });
  }

  write(address, value, options) {
    if (!isWord(address) || !isWord(value)) {
      return Promise.reject(new RangeError('Invalid Modbus write'));
    }
    const pdu = Buffer.from([
      FUNCTION.WRITE_SINGLE,
      address >> 8,
      address & 0xff,
      value >> 8,
      value & 0xff,
    ]);
    // The answer of a write is its own echo: anything else is not ours.
    return this.transact(pdu, options, (answer) => {
      if (!answer.equals(pdu)) {
        throw new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail: 'echo' });
      }
      return value;
    });
  }

  /**
   * One request and its answer. `timeoutMs`: the whole request (connection
   * included); or `startBy` (the last moment the request may leave) and
   * `answerBy` (the last moment to wait for its answer). `beforeSend`: a
   * last check run once connected, right before the bytes leave; what it
   * throws is rethrown with `beforeSend: true`, nothing sent.
   */
  async transact(
    pdu,
    { timeoutMs = TIMINGS.requestTimeout, startBy, answerBy, beforeSend },
    check,
  ) {
    if (this.closed) {
      throw new ModbusError(ERROR_KINDS.UNREACHABLE);
    }
    const end = answerBy ?? this.now() + timeoutMs;
    const leaveBy = Math.min(startBy ?? end, end);
    await this.open(leaveBy);
    if (this.now() > leaveBy) {
      throw new ModbusError(ERROR_KINDS.LATE);
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        throw err;
      }
    }
    const socket = this.socket;
    if (!socket || this.pending) {
      throw new ModbusError(ERROR_KINDS.UNREACHABLE);
    }
    this.transaction = (this.transaction % 0xffff) + 1;
    const tid = this.transaction;
    const frame = Buffer.alloc(HEADER + pdu.length);
    frame.writeUInt16BE(tid, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(pdu.length + 1, 4);
    frame.writeUInt8(this.unitId, 6);
    pdu.copy(frame, HEADER);
    return new Promise((resolve, reject) => {
      const pending = {
        tid,
        fn: pdu[0],
        check,
        buffer: Buffer.alloc(0),
        resolve,
        reject,
        timer: undefined,
      };
      pending.timer = this.timers.setTimeout(
        () => this.fail(pending, new ModbusError(ERROR_KINDS.TIMEOUT, { sent: true }), true),
        Math.max(0, end - this.now()),
      );
      this.pending = pending;
      // From here the request may reach the ISG: `sent` in every error.
      socket.write(frame);
    });
  }

  /** The connection, opened when needed; gives up at `by` (nothing sent). */
  async open(by) {
    if (this.socket && (this.socket.destroyed || this.socket.writable === false)) {
      // Closed by the ISG, its 'close' not seen yet: never write into it
      // (a write lost there would be reported "sent").
      this.drop(new ModbusError(ERROR_KINDS.CLOSED));
    }
    if (this.socket) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.dial().finally(() => {
        this.connecting = undefined;
      });
    }
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new ModbusError(ERROR_KINDS.LATE)),
        Math.max(0, by - this.now()),
      );
    });
    try {
      await Promise.race([this.connecting, late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  dial() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      const timer = this.timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket?.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE, { detail: 'connect timeout' }));
        }
      }, TIMINGS.connectTimeout);
      try {
        socket = this.connect({ host: this.host, port: this.port });
      } catch {
        settled = true;
        this.timers.clearTimeout(timer);
        reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        return;
      }
      socket.on('error', () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          socket.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        }
      });
      socket.once('connect', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(timer);
        if (this.closed) {
          socket.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
          return;
        }
        socket.setNoDelay?.(true);
        this.socket = socket;
        socket.on('data', (chunk) => this.receive(socket, chunk));
        socket.on('close', () => {
          if (this.socket === socket) {
            this.drop(new ModbusError(ERROR_KINDS.CLOSED, { sent: true }));
          }
        });
        resolve();
      });
      socket.once('close', () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        }
      });
    });
  }

  receive(socket, chunk) {
    if (socket !== this.socket) {
      return;
    }
    const pending = this.pending;
    if (!pending) {
      // Nothing was asked: not an answer of ours.
      this.drop(new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true }));
      return;
    }
    pending.buffer = Buffer.concat([pending.buffer, chunk]);
    const fail = (detail) =>
      this.fail(pending, new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail }), true);
    if (pending.buffer.length > LIMITS.frameBytes) {
      fail('too long');
      return;
    }
    if (pending.buffer.length < HEADER) {
      return;
    }
    const buffer = pending.buffer;
    const length = buffer.readUInt16BE(4);
    if (buffer.readUInt16BE(2) !== 0 || length < 2 || length > LIMITS.frameBytes - 6) {
      fail('header');
      return;
    }
    const total = 6 + length;
    if (buffer.length < total) {
      return;
    }
    if (buffer.length > total) {
      fail('trailing bytes');
      return;
    }
    if (buffer.readUInt16BE(0) !== pending.tid || buffer.readUInt8(6) !== this.unitId) {
      fail('transaction');
      return;
    }
    const answer = buffer.subarray(HEADER, total);
    if (answer[0] === (pending.fn | 0x80)) {
      if (answer.length !== 2) {
        fail('exception');
        return;
      }
      // A well-formed refusal: the connection stays.
      this.fail(pending, new ModbusError(ERROR_KINDS.EXCEPTION, { code: answer[1], sent: true }));
      return;
    }
    if (answer[0] !== pending.fn) {
      fail('function');
      return;
    }
    let value;
    try {
      value = pending.check(answer);
    } catch (err) {
      this.fail(pending, err, true);
      return;
    }
    this.settle(pending);
    pending.resolve(value);
  }

  settle(pending) {
    this.timers.clearTimeout(pending.timer);
    if (this.pending === pending) {
      this.pending = undefined;
    }
  }

  fail(pending, err, dropConnection = false) {
    if (this.pending !== pending) {
      return;
    }
    this.settle(pending);
    pending.reject(err);
    if (dropConnection) {
      this.drop(err);
    }
  }

  /** Closes the connection; a request in flight fails with `err`. */
  drop(err) {
    const socket = this.socket;
    this.socket = undefined;
    const pending = this.pending;
    if (pending) {
      this.settle(pending);
      pending.reject(err);
    }
    socket?.destroy();
  }
}
