import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dhwCapOf, normalizeConfig, parseAddress } from '../src/config.js';
import { DHW_CAP, POLL_INTERVAL } from '../src/constants.js';

test('the address: IPv4 or host name, port 502 unless given, a pasted URL reduced', () => {
  assert.deepEqual(parseAddress(' 192.168.1.70 '), { host: '192.168.1.70', port: 502 });
  assert.deepEqual(parseAddress('http://192.168.1.70/?s=1,0'), { host: '192.168.1.70', port: 502 });
  assert.deepEqual(parseAddress('192.168.1.70:5020'), { host: '192.168.1.70', port: 5020 });
  assert.deepEqual(parseAddress('Servicewelt'), { host: 'servicewelt', port: 502 });
  for (const bad of [
    '',
    '300.1.1.1',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
    '-x',
    'a_b',
    'u:p@h',
    '[::1]',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.equal(normalizeConfig({ address: 'a_b' }).invalid, 'a_b');
  assert.equal(normalizeConfig({ address: '' }).invalid, undefined);
  assert.equal(normalizeConfig({ address: '' }).address, undefined);
});

test('the commands are allowed by true only', () => {
  assert.equal(normalizeConfig({}).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  for (const value of [1, '1', 'yes', 'TRUE', {}, [], null, undefined, false, 'false']) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
});

test('the hot water ceiling: 55 °C by default, whole degrees from 40 to 60, never above 60', () => {
  assert.equal(normalizeConfig({}).dhwCap, DHW_CAP.default);
  assert.equal(DHW_CAP.default, 55);
  assert.equal(dhwCapOf(50), 50);
  assert.equal(dhwCapOf('52'), 52);
  assert.equal(dhwCapOf(58.9), 58, 'rounded down, never up');
  assert.equal(dhwCapOf(65), 60);
  assert.equal(dhwCapOf(1e9), 60);
  assert.equal(dhwCapOf(20), 40);
  for (const value of ['', ' ', null, undefined, 'abc', NaN, Infinity, {}, [], true]) {
    assert.equal(dhwCapOf(value), 55, String(value));
  }
});

test('interval bounded, language fr or en, unknown keys ignored', () => {
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, POLL_INTERVAL.min);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, POLL_INTERVAL.max);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ poll_interval: '60' }).pollInterval, 60);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  const polluted = normalizeConfig(JSON.parse('{"__proto__":{"allow_commands":true}}'));
  assert.equal(polluted.allowCommands, false);
  assert.equal({}.allow_commands, undefined);
});
