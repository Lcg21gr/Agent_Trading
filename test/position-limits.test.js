import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {env, cfg, order, fixture} from './support/fixtures.js';

const positions = count => Array.from({length: count}, (_, i) => ({positionId: i + 100, usedMargin: 300, moneyDigits: 2,
  tradeData: {symbolId: i + 20, volume: 100, label: 'other-agent'}}));

test('position count has no API cap by default; explicit positive limits remain supported', () => {
  assert.equal(config(env).maxPositions, 0);
  for (const value of ['0', '1', '20', '100', '1000']) assert.equal(config({...env, MAX_OPEN_POSITIONS: value}).maxPositions, Number(value));
  for (const value of ['-1', 'unlimited', '1.5', '9007199254740992', '']) assert.throws(() => config({...env, MAX_OPEN_POSITIONS: value}), /CONFIG_MAX_OPEN_POSITIONS_INVALID/);
});

test('an existing ADA position does not consume a unique slot for a SOL preview when count is unlimited', async (t) => {
  const f = await fixture(t, {cfg: {...cfg, maxPositions: 0}, state: {
    positions: [{...positions(1)[0], tradeData: {symbolId: 10095, volume: 6400, label: cfg.label}}],
    symbolName: 'SOLUSD', symbol: {symbolId: 10737, minVolume: 100, maxVolume: 50000, stepVolume: 100,
      digits: 2, pipPosition: 1, enableShortSelling: true, tradingMode: 0, slDistance: 0, tpDistance: 0,
      scheduleTimeZone: 'UTC', schedule: [{startSecond: 0, endSecond: 604800}]}, bid: 72.78, spread: 0.4,
  }});
  const r = await f.call('/v1/demo/orders/preview', {method: 'POST', read: true,
    body: {symbol: 'SOLUSD', side: 'BUY', volume: '1', stopLossPips: '10', takeProfitPips: '20'}});
  assert.equal(r.status, 200);
  assert.equal(r.data.symbolId, 10737);
  assert.equal(f.state.positions[0].tradeData.symbolId, 10095);
  assert.equal(f.state.calls.some(m => [2106, 2111].includes(m.payloadType)), false);
});

test('removing the API count cap still checks margin when many positions are already open', async (t) => {
  const f = await fixture(t, {cfg: {...cfg, maxPositions: 0}, state: {positions: positions(25)}});
  assert.equal((await f.call('/v1/demo/orders/preview', {method: 'POST', body: order})).status, 200);
  f.state.trader.balance = 100;
  assert.equal((await f.call('/v1/demo/orders/preview', {method: 'POST', body: order})).data.error, 'INSUFFICIENT_FREE_MARGIN');
  assert.equal(f.state.calls.some(m => m.payloadType === 2106), false);
});

test('multiple simulated orders coexist and closing one leaves the other positions open', async (t) => {
  const f = await fixture(t, {cfg: {...cfg, maxPositions: 0}});
  const ids = [];
  for (let n = 0; n < 3; n++) {
    const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'parallel_positions_00' + n});
    assert.equal(r.data.status, 'completed');
    ids.push(r.data.result.positionId);
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal((await f.call('/v1/demo/positions')).data.positions.length, 3);
  const closed = await f.call('/v1/demo/positions/' + ids[1] + '/close', {method: 'POST', body: {}, key: 'parallel_close_00001'});
  assert.equal(closed.data.status, 'completed');
  assert.deepEqual((await f.call('/v1/demo/positions')).data.positions.map(p => p.positionId), [ids[0], ids[2]]);
});

test('a caller-configured positive cap counts all account positions and is reported by capabilities', async (t) => {
  const f = await fixture(t, {cfg: {...cfg, maxPositions: 2}, state: {positions: positions(1)}});
  assert.equal((await f.call('/v1/demo/orders/preview', {method: 'POST', body: order})).status, 200);
  f.state.positions = positions(2);
  assert.equal((await f.call('/v1/demo/orders/preview', {method: 'POST', body: order})).data.error, 'MAX_POSITIONS_REACHED');
  const cap = await f.call('/v1/demo/capabilities', {read: true});
  assert.equal(cap.data.maxOpenPositions, 2);
  assert.equal(cap.data.positionLimitEnabled, true);
  const unlimited = await fixture(t, {cfg: {...cfg, maxPositions: 0}});
  const available = await unlimited.call('/v1/demo/capabilities', {read: true});
  assert.equal(available.data.maxOpenPositions, 0);
  assert.equal(available.data.positionLimitEnabled, false);
});
