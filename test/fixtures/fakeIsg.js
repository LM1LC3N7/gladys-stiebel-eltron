// -----------------------------------------------------------------------------
// A fake ISG behind the socket factory: it parses the Modbus TCP frames the
// client writes, answers from its registers (0x8000 when unset, as the ISG
// says "unavailable"), and lets a test change its behaviour per request.
// No network: every socket is an in-memory EventEmitter.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.70';
export const NOW = Date.UTC(2026, 9, 18, 18, 0, 0);

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const word = (value) => (value < 0 ? 0x10000 + value : value);

/** A WPM 3 (390): FE7 room temperature, no FEK, program mode, compressor running. */
export function wpmRegisters() {
  return {
    input: {
      5001: 390,
      500: 215,
      506: word(-50),
      507: 350,
      514: 352,
      515: 301,
      521: 482,
      522: 500,
      2500: (1 << 4) | (1 << 6),
      2503: 0,
      3500: 12,
      3501: 345,
      3502: 12,
      3503: 3,
      3504: 678,
      3505: 4,
      3506: 10,
      3507: 0,
      3508: 5,
      3509: 0,
      3510: 4,
      3511: 123,
      3512: 3,
      3513: 1,
      3514: 456,
      3515: 1,
    },
    holding: {
      1500: 2,
      1501: 210,
      1502: 190,
      1509: 500,
      1510: 450,
    },
  };
}

/** An LWZ (103): room HC1 with humidity, automatic mode, compressor running. */
export function lwzRegisters() {
  return {
    input: {
      5001: 103,
      0: 212,
      1: 210,
      2: 455,
      6: 80,
      11: 330,
      12: 290,
      15: 470,
      16: 480,
      2000: 1 << 1,
      2001: 0,
      3000: 20,
      3001: 500,
      3002: 7,
      3003: 2,
      3004: 100,
      3005: 1,
      3006: 50,
      3007: 0,
      3008: 25,
      3009: 0,
      3021: 6,
      3022: 900,
      3023: 2,
      3024: 1,
      3025: 300,
      3026: 0,
    },
    holding: {
      1000: 11,
      1001: 215,
      1002: 180,
      1011: 480,
      1012: 450,
    },
  };
}

/**
 * `registers`: `{ input: { address: word }, holding: {...} }`.
 * `behave(request)`: per request, return undefined (answer normally),
 * `'silent'` (no answer), `{ exception: code }`, `'close'` (drop the
 * connection), `'garbage'` (answer another transaction id) or, for a
 * write, `'silent-applied'` (the value is written, no answer).
 */
export function fakeIsg({ registers = wpmRegisters(), behave } = {}) {
  const isg = {
    input: new Map(Object.entries(registers.input).map(([k, v]) => [Number(k), v])),
    holding: new Map(Object.entries(registers.holding).map(([k, v]) => [Number(k), v])),
    /** Every request received: { fn, address, count?, value?, tid, unit }. */
    requests: [],
    connects: [],
    sockets: [],
    down: false,
    behave,
  };

  const answer = (socket, buffer) => {
    setImmediate(() => {
      if (!socket.destroyed) {
        socket.emit('data', buffer);
      }
    });
  };

  const frame = (tid, unit, pdu) => {
    const out = Buffer.alloc(7 + pdu.length);
    out.writeUInt16BE(tid, 0);
    out.writeUInt16BE(0, 2);
    out.writeUInt16BE(pdu.length + 1, 4);
    out.writeUInt8(unit, 6);
    pdu.copy(out, 7);
    return out;
  };

  const handle = (socket, data) => {
    const tid = data.readUInt16BE(0);
    const unit = data.readUInt8(6);
    const fn = data.readUInt8(7);
    const address = data.readUInt16BE(8);
    const request = { fn, address, tid, unit };
    if (fn === 6) {
      request.value = data.readUInt16BE(10);
    } else {
      request.count = data.readUInt16BE(10);
    }
    isg.requests.push(request);
    const rule = isg.behave?.(request, isg);
    if (rule === 'silent') {
      return;
    }
    if (rule === 'close') {
      socket.destroy();
      return;
    }
    if (rule?.exception !== undefined) {
      answer(socket, frame(tid, unit, Buffer.from([fn | 0x80, rule.exception])));
      return;
    }
    if (fn === 6) {
      isg.holding.set(address, request.value);
      if (rule === 'silent-applied') {
        return;
      }
      const echo = Buffer.from(data.subarray(7, 12));
      if (rule === 'bad-echo') {
        echo.writeUInt16BE((request.value + 1) & 0xffff, 3);
      }
      answer(socket, frame(tid, unit, echo));
      return;
    }
    const space = fn === 4 ? isg.input : isg.holding;
    const pdu = Buffer.alloc(2 + request.count * 2);
    pdu[0] = fn;
    pdu[1] = request.count * 2;
    for (let i = 0; i < request.count; i += 1) {
      pdu.writeUInt16BE(space.get(address + i) ?? 0x8000, 2 + i * 2);
    }
    answer(socket, frame(rule === 'garbage' ? (tid + 1) & 0xffff : tid, unit, pdu));
  };

  isg.connect = ({ host, port }) => {
    isg.connects.push({ host, port });
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.setNoDelay = () => {};
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        setImmediate(() => socket.emit('close'));
      }
    };
    socket.write = (data) => {
      if (!socket.destroyed) {
        handle(socket, Buffer.from(data));
      }
      return true;
    };
    isg.sockets.push(socket);
    setImmediate(() => {
      if (isg.down) {
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );
        socket.destroyed = true;
        socket.emit('close');
      } else {
        socket.emit('connect');
      }
    });
    return socket;
  };

  /** The writes received: [address, value]. */
  isg.writes = () => isg.requests.filter((r) => r.fn === 6).map((r) => [r.address, r.value]);
  return isg;
}
