import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS,
  CONTROLLERS,
  MODES,
  SELECTABLE,
  decode,
  flag,
  modeOf,
  setpointWord,
  tenths,
  total,
} from '../src/isg.js';
import { lwzRegisters, wpmRegisters } from './fixtures/fakeIsg.js';

const rawOf = ({ input, holding }) => ({
  input: new Map(Object.entries(input).map(([k, v]) => [Number(k), v])),
  holding: new Map(Object.entries(holding).map(([k, v]) => [Number(k), v])),
});

test('tenths: signed, 0x8000 unavailable, out of range unknown', () => {
  assert.equal(tenths(215), 21.5);
  assert.equal(tenths(0x10000 - 50), -5);
  assert.equal(tenths(0x8000), undefined);
  assert.equal(tenths(0x9000), undefined, 'the WPM 3i sentinel is out of every range');
  assert.equal(tenths(undefined), undefined);
  assert.equal(tenths(1300), undefined, '130 °C is not a temperature of a heat pump');
});

test('energy totals: kWh below 1000 plus MWh, never with a part unavailable', () => {
  assert.equal(total(345, 12), 12345);
  assert.equal(total(0, 0), 0);
  assert.equal(total(1000, 1), undefined, 'the kWh part is 0-999');
  assert.equal(total(345, 0x8000), undefined);
  assert.equal(total(0x8000, 1), undefined);
  assert.equal(flag(2), undefined);
  assert.equal(flag(1), 1);
});

test('a WPM 3 decoded', () => {
  const values = decode('wpm', rawOf(wpmRegisters()));
  assert.equal(values.outdoor, -5);
  assert.equal(values.roomFe7, 21.5);
  assert.equal(values.roomFek, undefined);
  assert.equal(values.flow, 35.2);
  assert.equal(values.return, 30.1);
  assert.equal(values.dhw, 48.2);
  assert.equal(values.dhwTarget, 50);
  assert.deepEqual(values.mode, { code: 2, key: 'program' });
  assert.equal(values.heatingSetpoint, 21);
  assert.equal(values.dhwSetpoint, 50);
  assert.equal(values.compressor, 1, 'bit 6 of the operating status');
  assert.equal(values.booster, 0, 'bit 3 of the operating status');
  assert.equal(values.fault, 0);
  assert.deepEqual(values.energy, {
    producedHeatingToday: 12,
    producedHeatingTotal: 12345,
    producedDhwToday: 3,
    producedDhwTotal: 4678,
    boosterHeatingTotal: 10,
    boosterDhwTotal: 5,
    consumedHeatingToday: 4,
    consumedHeatingTotal: 3123,
    consumedDhwToday: 1,
    consumedDhwTotal: 1456,
  });
});

test('a WPMsystem: compressors and booster stages from their own registers', () => {
  const registers = wpmRegisters();
  Object.assign(registers.input, {
    5001: 449,
    2500: 0,
    2541: 0,
    2542: 1,
    2524: 0,
    2525: 0,
    2526: 0,
  });
  const values = decode('wpm', rawOf(registers));
  assert.equal(values.compressor, 1);
  assert.equal(values.booster, 0);
  registers.input[2542] = 0x8000;
  assert.equal(decode('wpm', rawOf(registers)).compressor, 0, 'none on, one unknown: status bit');
});

test('a WPMsystem with one heat pump: compressor 1 then 0 with 2542-2546 = 0x8000', () => {
  const registers = wpmRegisters();
  Object.assign(registers.input, { 5001: 449, 2500: 1 << 6, 2541: 1 });
  for (const address of [2542, 2543, 2544, 2545, 2546]) {
    registers.input[address] = 0x8000;
  }
  assert.equal(decode('wpm', rawOf(registers)).compressor, 1);
  Object.assign(registers.input, { 2500: 0, 2541: 0 });
  assert.equal(decode('wpm', rawOf(registers)).compressor, 0, 'never stuck at 1');
  // Every register unavailable: the operating status bit alone.
  registers.input[2541] = 0x8000;
  registers.input[2500] = 1 << 6;
  assert.equal(decode('wpm', rawOf(registers)).compressor, 1);
  // Booster: stage 1 known, the others unavailable.
  Object.assign(registers.input, { 2500: 0, 2524: 1, 2525: 0x8000, 2526: 0x8000 });
  assert.equal(decode('wpm', rawOf(registers)).booster, 1);
  registers.input[2524] = 0;
  assert.equal(decode('wpm', rawOf(registers)).booster, 0);
});

test('an LWZ decoded', () => {
  const values = decode('lwz', rawOf(lwzRegisters()));
  assert.equal(values.room, 21.2);
  assert.equal(values.humidity, 45.5);
  assert.equal(values.outdoor, 8);
  assert.deepEqual(values.mode, { code: 11, key: 'automatic' });
  assert.equal(values.heatingSetpoint, 21.5);
  assert.equal(values.heatingSetpointEco, 18);
  assert.equal(values.dhwSetpoint, 48);
  assert.equal(values.compressor, 1, 'bit 1');
  assert.equal(values.booster, 0, 'bit 5');
  assert.equal(values.energy.consumedHeatingTotal, 2900);
  assert.equal(values.energy.producedHeatingTotal, 7500);
});

test('modes: known codes, unknown kept with its code, the selectable ones never emergency nor manual', () => {
  assert.deepEqual(modeOf('wpm', 0), { code: 0, key: 'emergency' });
  assert.deepEqual(modeOf('wpm', 9), { code: 9, key: undefined });
  assert.deepEqual(modeOf('lwz', 14), { code: 14, key: 'manual' });
  assert.equal(modeOf('lwz', 0x8000), undefined);
  for (const family of ['wpm', 'lwz']) {
    assert.ok(!SELECTABLE[family].includes('emergency'));
    assert.ok(!SELECTABLE[family].includes('manual'));
    assert.ok(SELECTABLE[family].every((key) => Object.values(MODES[family]).includes(key)));
  }
});

test('setpoints to register words', () => {
  assert.equal(setpointWord(21.5), 215);
  assert.equal(setpointWord(55), 550);
  assert.equal(setpointWord(-1), 0xfff6);
});

test('the blocks stay inside the ranges pystiebeleltron gives for each variant', () => {
  // pystiebeleltron 0.9.2: WPM3_INPUT_RANGES, WPM3I_INPUT_RANGES, WPM_INPUT_RANGES, LWZ_INPUT_RANGES and the holding ones.
  const ranges = {
    wpm3: {
      input: [
        [500, 507],
        [509, 537],
        [541, 582],
        [2500, 2506],
        [3500, 3515],
        [3522, 3642],
        [5000, 5001],
      ],
      holding: [
        [1500, 1520],
        [4000, 4002],
      ],
    },
    wpm3i: {
      input: [
        [500, 526],
        [532, 533],
        [535, 540],
        [2500, 2501],
        [2503, 2504],
        [2506, 2506],
        [3500, 3521],
        [5000, 5001],
      ],
      holding: [
        [1500, 1520],
        [4000, 4002],
      ],
    },
    wpmsystem: {
      input: [
        [500, 607],
        [609, 610],
        [2500, 2546],
        [2560, 2565],
        [2569, 2572],
        [3500, 3654],
        [5000, 5001],
      ],
      holding: [
        [1500, 1520],
        [1550, 1558],
      ],
    },
    lwz: {
      input: [
        [0, 33],
        [2000, 2004],
        [3000, 3031],
        [5000, 5001],
      ],
      holding: [
        [1000, 1026],
        [4000, 4002],
      ],
    },
  };
  for (const [variant, blocks] of Object.entries(BLOCKS)) {
    for (const block of blocks) {
      const last = block.start + block.count - 1;
      assert.ok(
        ranges[variant][block.space].some(([a, b]) => block.start >= a && last <= b),
        `${variant} ${block.name}`,
      );
    }
  }
  const variants = new Set(Object.values(CONTROLLERS).map((c) => c.variant));
  assert.deepEqual([...variants].sort(), Object.keys(BLOCKS).sort());
});
