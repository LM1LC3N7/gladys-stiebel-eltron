// -----------------------------------------------------------------------------
// The Modbus TCP client: frames, attribution of the answers, bounds, one
// request at a time, timeouts and `sent`. A scripted socket stands for the
// ISG; the last test runs the real node:net transport on a loopback server.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { ERROR_KINDS, Gate, ModbusClient, ModbusError } from '../src/modbus/client.js';
import { settle } from './fixtures/fakeIsg.js';

/** A socket the test answers by hand: `written` holds the frames sent. */
function scripted({ refuse = false } = {}) {
  const sockets = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.written = [];
    socket.destroyed = false;
    socket.setNoDelay = () => {};
    socket.write = (data) => socket.written.push(Buffer.from(data));
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        setImmediate(() => socket.emit('close'));
      }
    };
    sockets.push(socket);
    setImmediate(() => {
      if (refuse) {
        socket.emit('error', new Error('ECONNREFUSED'));
        socket.emit('close');
      } else {
        socket.emit('connect');
      }
    });
    return socket;
  };
  return { sockets, connect };
}

const frame = (tid, unit, pdu) => {
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out.writeUInt8(unit, 6);
  Buffer.from(pdu).copy(out, 7);
  return out;
};

const client = (connect, options = {}) =>
  new ModbusClient({ host: '10.0.0.5', port: 502, unitId: 1, connect, ...options });

async function sentFrame(sockets) {
  await settle();
  const socket = sockets.at(-1);
  return { socket, frame: socket.written.at(-1) };
}

test('a read of input registers: the frame on the wire, then the words', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readInput(5001, 2);
  const { socket, frame: sent } = await sentFrame(sockets);
  assert.deepEqual([...sent], [0, 1, 0, 0, 0, 6, 1, 4, 0x13, 0x89, 0, 2]);
  socket.emit('data', frame(1, 1, [4, 4, 0x01, 0x86, 0x80, 0x00]));
  assert.deepEqual(await read, [390, 0x8000]);
  c.close();
});

test('an answer that is not the one of the request is refused and the connection dropped', async () => {
  const cases = [
    ['another transaction', (tid) => frame(tid + 1, 1, [3, 2, 0, 1])],
    ['another unit', (tid) => frame(tid, 2, [3, 2, 0, 1])],
    ['another function', (tid) => frame(tid, 1, [4, 2, 0, 1])],
    ['a wrong byte count', (tid) => frame(tid, 1, [3, 4, 0, 1, 0, 2])],
    ['a protocol id', (tid) => Buffer.concat([frame(tid, 1, [3, 2, 0, 1])]).fill(1, 2, 3)],
    ['trailing bytes', (tid) => Buffer.concat([frame(tid, 1, [3, 2, 0, 1]), Buffer.from([0])])],
    ['a frame too long', (tid) => frame(tid, 1, [3, 254, ...new Array(260).fill(0)])],
  ];
  for (const [name, build] of cases) {
    const { sockets, connect } = scripted();
    const c = client(connect);
    const read = c.readHolding(1500, 1);
    const { socket, frame: sent } = await sentFrame(sockets);
    socket.emit('data', build(sent.readUInt16BE(0)));
    await assert.rejects(read, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent, name);
    await settle();
    assert.equal(socket.destroyed, true, name);
    // The next request opens a new connection.
    const next = c.readHolding(1500, 1);
    const again = await sentFrame(sockets);
    assert.notEqual(again.socket, socket, name);
    again.socket.emit('data', frame(again.frame.readUInt16BE(0), 1, [3, 2, 0, 7]));
    assert.deepEqual(await next, [7], name);
    c.close();
  }
});

test('an answer split over several chunks is put back together', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  const answer = frame(sent.readUInt16BE(0), 1, [3, 2, 0, 3]);
  socket.emit('data', answer.subarray(0, 4));
  socket.emit('data', answer.subarray(4));
  assert.deepEqual(await read, [3]);
  c.close();
});

test('data with no request in flight drops the connection', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [3, 2, 0, 3]));
  await read;
  socket.emit('data', frame(99, 1, [3, 2, 0, 3]));
  await settle();
  assert.equal(socket.destroyed, true);
  c.close();
});

test('a Modbus exception is a refusal: the connection stays', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readInput(3500, 16);
  const { socket, frame: sent } = await sentFrame(sockets);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [0x84, 2]));
  await assert.rejects(read, (err) => err.kind === ERROR_KINDS.EXCEPTION && err.code === 2);
  assert.equal(socket.destroyed, false);
  c.close();
});

test('a silence times out, sent; the connection is dropped so a late answer is never taken', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1, { timeoutMs: 1000 });
  const { socket, frame: sent } = await sentFrame(sockets);
  t.mock.timers.tick(1000);
  await assert.rejects(read, (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent === true);
  await settle();
  assert.equal(socket.destroyed, true);
  // The late answer arrives on the dropped socket: ignored.
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [3, 2, 0, 9]));
  const next = c.readHolding(1500, 1);
  const again = await sentFrame(sockets);
  assert.notEqual(again.socket, socket);
  again.socket.emit('data', frame(again.frame.readUInt16BE(0), 1, [3, 2, 0, 1]));
  assert.deepEqual(await next, [1]);
  c.close();
});

test('a write: its echo exactly, else a protocol error, sent', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const write = c.raw.writeRegister(1509, 500, {});
  const { socket, frame: sent } = await sentFrame(sockets);
  assert.deepEqual([...sent.subarray(6)], [1, 6, 0x05, 0xe5, 0x01, 0xf4]);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [6, 0x05, 0xe5, 0x01, 0xf4]));
  assert.equal(await write, 500);
  const bad = c.raw.writeRegister(1509, 500, {});
  const second = await sentFrame(sockets);
  second.socket.emit('data', frame(second.frame.readUInt16BE(0), 1, [6, 0x05, 0xe5, 0x01, 0xf5]));
  await assert.rejects(bad, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent === true);
  c.close();
});

test('a connection closed by the ISG is never written into: a new one is opened', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1);
  const first = await sentFrame(sockets);
  first.socket.emit('data', frame(first.frame.readUInt16BE(0), 1, [3, 2, 0, 2]));
  await read;
  // Closed on the other side, its 'close' event not handled yet.
  first.socket.destroyed = true;
  const write = c.raw.writeRegister(1500, 3, {});
  const second = await sentFrame(sockets);
  assert.notEqual(second.socket, first.socket);
  assert.equal(first.socket.written.length, 1);
  second.socket.emit('data', frame(second.frame.readUInt16BE(0), 1, [6, 0x05, 0xdc, 0, 3]));
  assert.equal(await write, 3);
  c.close();
});

test('nothing listening: unreachable, not sent', async () => {
  const { connect } = scripted({ refuse: true });
  const c = client(connect);
  await assert.rejects(
    c.raw.writeRegister(1500, 3, {}),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && err.sent === false,
  );
});

test('beforeSend runs once connected, right before the bytes; what it throws leaves nothing sent', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const refusal = new Error('option off');
  const write = c.raw.writeRegister(1500, 3, {
    beforeSend: () => {
      throw refusal;
    },
  });
  await assert.rejects(write, (err) => err === refusal && err.beforeSend === true);
  await settle();
  assert.equal(sockets[0].written.length, 0);
  c.close();
});

test('one request at a time: the second leaves only after the first is answered', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const first = c.readInput(500, 8);
  const second = c.readInput(509, 14);
  const { socket } = await sentFrame(sockets);
  assert.equal(socket.written.length, 1);
  socket.emit(
    'data',
    frame(socket.written[0].readUInt16BE(0), 1, [4, 16, ...new Array(16).fill(0)]),
  );
  await first;
  await settle();
  assert.equal(socket.written.length, 2);
  socket.emit(
    'data',
    frame(socket.written[1].readUInt16BE(0), 1, [4, 28, ...new Array(28).fill(0)]),
  );
  assert.equal((await second).length, 14);
  c.close();
});

test('the gate: a session passes the queued reads; still queued at its deadline it is LATE, never run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = new Gate();
  const order = [];
  let release;
  const running = gate.run(() => new Promise((resolve) => (release = resolve)));
  const queued = gate.run(async () => order.push('read'));
  const session = gate.run(async () => order.push('command'), { first: true });
  const late = gate.run(async () => order.push('late'), { first: true, startBy: Date.now() + 100 });
  t.mock.timers.tick(100);
  await assert.rejects(late, (err) => err instanceof ModbusError && err.kind === ERROR_KINDS.LATE);
  release();
  await Promise.all([running, queued, session]);
  assert.deepEqual(order, ['command', 'read']);
});

test('requests out of bounds are refused before the wire', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  await assert.rejects(c.readInput(0, 126), RangeError);
  await assert.rejects(c.readInput(65535, 2), RangeError);
  await assert.rejects(c.raw.writeRegister(1500, 70000, {}), RangeError);
  await assert.rejects(c.raw.writeRegister(1500, 1.5, {}), RangeError);
  assert.equal(sockets.length, 0);
});

test('the real transport on a loopback server', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      const tid = data.readUInt16BE(0);
      socket.write(frame(tid, 1, [4, 2, 0x01, 0x87]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const c = new ModbusClient({ host: '127.0.0.1', port: server.address().port, unitId: 1 });
  try {
    assert.deepEqual(await c.readInput(5001, 1), [391]);
    assert.deepEqual(await c.readInput(5001, 1), [391]);
  } finally {
    c.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
