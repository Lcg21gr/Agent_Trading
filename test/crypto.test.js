import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {DEFAULT_ALLOWED_SYMBOLS, symbolAllowed, symbolLimits} from '../src/symbol-limits.js';
import {env, cfg, symbol, order, fixture} from './support/fixtures.js';

const ada = {...order, symbol: 'ADAUSD', volume: '64'};
const adaState = {symbolName: 'ADAUSD', symbol: {...symbol, symbolId: 10095, digits: 4, pipPosition: 3,
  minVolume: 100, maxVolume: 250000, stepVolume: 100}, bid: 0.151, spread: 0.004};

test('wildcard defaults allow every broker market and preserve an explicit allowlist', () => {
  const defaults = config(env);
  assert.deepEqual(defaults.symbols, DEFAULT_ALLOWED_SYMBOLS);
  assert.deepEqual(defaults.symbols, ['*']);
  for (const name of ['ADAUSD', 'BTCUSD', 'XAUUSD', 'Japan 225', 'AAPL.US']) assert.equal(symbolAllowed(defaults, name), true);
  assert.deepEqual(config({...env, ALLOWED_SYMBOLS: 'EURUSD,GBPUSD'}).symbols, ['EURUSD', 'GBPUSD']);
  assert.deepEqual(symbolLimits(defaults, 'EURUSD'), {maxVolumeUnits: 1000, maxSpreadPips: 3, maxStopLossPips: 100});
  assert.equal(symbolLimits(defaults, 'ADAUSD').maxVolumeUnits, 1000);
  assert.equal(symbolLimits(defaults, 'BTCUSD').maxSpreadBps, 300);
  assert.equal(symbolLimits(defaults, 'BTCUSD').maxStopLossPips, undefined);
  for (const value of ['*,EURUSD', 'EURUSD,EURUSD', 'EURUSD,', ' EURUSD', 'EURUSD\n']) {
    assert.throws(() => config({...env, ALLOWED_SYMBOLS: value}), /CONFIG_SYMBOLS_INVALID/);
  }
});

test('per-symbol market filter overrides are validated and do not silently impose a USD allocation', () => {
  const c = config({...env, SYMBOL_LIMITS_JSON: '{"ADAUSD":{"maxSpreadPips":8,"maxStopLossPips":50,"maxSpreadBps":200}}'});
  assert.equal(symbolLimits(c, 'ADAUSD').maxSpreadPips, 8);
  assert.equal(symbolLimits(c, 'ADAUSD').maxStopLossPips, 50);
  assert.equal(symbolLimits(c, 'ADAUSD').maxSpreadBps, 200);
  assert.equal(symbolLimits(c, 'EURUSD').maxSpreadPips, 3);
  for (const value of ['null', '[]', '{', '{"ADAUSD":{"maxNotionalUsd":10}}', '{"ADAUSD":{"maxSpreadPips":0}}', '{"ADAUSD":{"maxSpreadPips":"15"}}']) {
    assert.throws(() => config({...env, SYMBOL_LIMITS_JSON: value}), /CONFIG_SYMBOL_LIMITS_INVALID/);
  }
});

test('authenticated capabilities expose the active allowlist and market filters without credentials or broker calls', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/v1/demo/capabilities')).status, 401);
  const r = await f.call('/v1/demo/capabilities', {read: true});
  assert.equal(r.status, 200);
  assert.equal(r.data.environment, 'demo');
  assert.deepEqual(r.data.allowedSymbols, ['*']);
  assert.equal(r.data.allBrokerSymbols, true);
  assert.equal(r.data.marketDefaults.maxSpreadBps, 300);
  assert.equal(r.data.fixedNotionalUsd, false);
  assert.equal(r.data.volumeInput, 'instrument_units');
  assert.ok(!JSON.stringify(r.data).includes(env.API_KEY));
  assert.equal(f.state.calls.length, 0);
});

test('ADA preview validates broker volume and protections without a fixed ten-dollar cap', async (t) => {
  const f = await fixture(t, {state: adaState});
  for (const volume of ['64', '128']) {
    const r = await f.call('/v1/demo/orders/preview', {method: 'POST', read: true, body: {...ada, volume}});
    assert.equal(r.status, 200);
    assert.equal(r.data.volume, Number(volume) * 100);
    assert.equal(r.data.minVolumeUnits, 1);
    assert.equal(r.data.stepVolumeUnits, 1);
    assert.equal(r.data.pipPosition, 3);
    assert.equal(r.data.relativeStopLoss, 1000);
    assert.equal(r.data.relativeTakeProfit, 2000);
    assert.equal(r.data.volumeUnits, Number(volume));
    assert.equal(r.data.limits.maxSpreadBps, 300);
  }
  assert.equal(f.state.calls.filter((m) => m.payloadType === 2106).length, 0);
});

test('ADA can open and close through the full simulated wire path for both BUY and SELL', async (t) => {
  for (const side of ['BUY', 'SELL']) {
    const f = await fixture(t, {state: structuredClone(adaState)});
    const opened = await f.call('/v1/demo/orders', {method: 'POST', body: {...ada, side}, key: 'crypto_open_test_0001'});
    assert.equal(opened.status, 201);
    assert.equal(opened.data.status, 'completed');
    assert.equal(opened.data.result.verified, true);
    const sent = f.state.calls.find((m) => m.payloadType === 2106).payload;
    assert.equal(sent.volume, 6400);
    assert.equal(sent.relativeStopLoss, 1000);
    const closed = await f.call('/v1/demo/positions/71/close', {method: 'POST', body: {}, key: 'crypto_close_test_001'});
    assert.equal(closed.data.status, 'completed');
    assert.equal(closed.data.result.positionClosed, true);
  }
});

test('BTC fractional units and its wider pip scale do not relax EURUSD filters', async (t) => {
  const f = await fixture(t, {state: {symbolName: 'BTCUSD', symbol: {...symbol, symbolId: 10028, digits: 2, pipPosition: 1,
    minVolume: 1, maxVolume: 2500, stepVolume: 1}, bid: 63906.75, spread: 15}});
  const r = await f.call('/v1/demo/orders/preview', {method: 'POST', body: {symbol: 'BTCUSD', side: 'BUY', volume: '0.01', stopLossPips: '1000', takeProfitPips: '2000'}});
  assert.equal(r.status, 200);
  assert.equal(r.data.volume, 1);
  assert.equal(r.data.volumeUnits, 0.01);
  assert.equal(r.data.relativeStopLoss, 10000000);
  assert.equal(r.data.spreadPips, 150);
  assert.equal(r.data.limits.maxSpreadBps, 300);
  assert.equal(r.data.limits.maxSpreadPips, undefined);
  assert.equal(symbolLimits(cfg, 'EURUSD').maxSpreadPips, 3);
});

test('crypto enablement preserves volume, spread and explicit allowlist rejection paths', async (t) => {
  const limitedCfg = config({...env, ALLOWED_SYMBOLS: 'EURUSD', SYMBOL_LIMITS_JSON: '{"ADAUSD":{"maxSpreadPips":3}}'});
  const denied = await fixture(t, {state: structuredClone(adaState), cfg: limitedCfg});
  assert.equal((await denied.call('/v1/demo/orders/preview', {method: 'POST', body: ada})).data.error, 'SYMBOL_NOT_ALLOWED');
  const wide = await fixture(t, {state: structuredClone(adaState), cfg: {...config({...env, SYMBOL_LIMITS_JSON: '{"ADAUSD":{"maxSpreadPips":3}}'}), requestIntervalMs: 0}});
  assert.equal((await wide.call('/v1/demo/orders/preview', {method: 'POST', body: ada})).data.error, 'SPREAD_TOO_HIGH');
  const step = await fixture(t, {state: structuredClone(adaState)});
  assert.equal((await step.call('/v1/demo/orders/preview', {method: 'POST', body: {...ada, volume: '1.5'}})).data.error, 'INVALID_SYMBOL_VOLUME');
});

const otherMarket = {symbol: {...symbol, minVolume: 100, maxVolume: 100000, stepVolume: 100, digits: 2, pipPosition: 1}, bid: 100, spread: 0.5};
const otherOrder = {...order, volume: '2', stopLossPips: '200', takeProfitPips: '300'};

test('wildcard previews accept exact broker names with spaces, suffixes and mixed case across markets', async (t) => {
  for (const name of ['Japan 225', 'AAPL.US', 'Brent Crude', 'DE40.cash', 'XAUUSD', 'ACME.EUR']) {
    const f = await fixture(t, {state: {...structuredClone(otherMarket), symbolName: name}});
    const r = await f.call('/v1/demo/orders/preview', {method: 'POST', read: true, body: {...otherOrder, symbol: name}});
    assert.equal(r.status, 200, name);
    assert.equal(r.data.relativeStopLoss, 2000000);
    assert.equal(r.data.limits.maxStopLossPips, undefined);
    assert.equal(r.data.limits.maxSpreadPips, undefined);
    assert.equal(r.data.limits.maxSpreadBps, 300);
    assert.equal(r.data.estimatedNotionalUsd, undefined);
    assert.equal(f.state.calls.some((m) => [2106, 2111].includes(m.payloadType)), false);
  }
});

test('wildcard still rejects missing, disabled or too-wide broker instruments', async (t) => {
  for (const [state, error] of [
    [{symbolName: 'OTHER'}, 'SYMBOL_NOT_AVAILABLE'],
    [{symbolEnabled: false}, 'SYMBOL_NOT_AVAILABLE'],
    [{symbol: {...otherMarket.symbol, tradingMode: 2}}, 'SYMBOL_TRADING_DISABLED'],
    [{spread: 4}, 'SPREAD_TOO_HIGH'],
  ]) {
    const f = await fixture(t, {state: {...structuredClone(otherMarket), symbolName: 'Japan 225', ...state}});
    const r = await f.call('/v1/demo/orders/preview', {method: 'POST', body: {...otherOrder, symbol: 'Japan 225'}});
    assert.equal(r.data.error, error);
    assert.equal(f.state.calls.some((m) => [2106, 2111].includes(m.payloadType)), false);
  }
});

test('wildcard is a configuration option only; invalid request names fail before contacting the broker', async (t) => {
  const f = await fixture(t);
  for (const name of ['*', '', ' ADAUSD', 'ADAUSD\n', 'A'.repeat(101)]) {
    const r = await f.call('/v1/demo/orders/preview', {method: 'POST', body: {...order, symbol: name}});
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'INVALID_SYMBOL');
  }
  assert.equal(f.state.calls.length, 0);
});
