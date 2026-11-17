import test from 'node:test';
import assert from 'node:assert/strict';
import {candleParams, normalizeCandles, CANDLE_PERIODS} from '../src/candles.js';
import {TradingService} from '../src/trading.js';
import {cfg, order, fixture, MemoryStore} from './support/fixtures.js';

const base = 1700000040000;
const bar = (time = base, overrides = {}) => ({utcTimestampInMinutes: time / 60000, low: 110000, deltaOpen: 5, deltaClose: 10, deltaHigh: 20, volume: '123', ...overrides});
const query = '?period=M1&from=' + (base - 60000) + '&to=' + (base + 180000) + '&limit=2';

test('historical candle HTTP uses the authenticated read-only wire path and normalizes cTrader deltas', async (t) => {
  const f = await fixture(t, {reuseReadSession: true, scope: 0, state: {trendbars: [bar(base + 60000), bar()]}});
  assert.equal((await fetch(f.base + '/v1/demo/symbols/1/candles')).status, 401);
  const r = await f.call('/v1/demo/symbols/1/candles' + query, {read: true});
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.candles[0], {openTime: base, open: '1.10005', high: '1.10020', low: '1.10000', close: '1.10010', tickVolume: '123'});
  assert.equal(r.data.nextTo, base - 1);
  assert.equal(r.data.brokerHasMore, false);
  assert.equal(r.data.mayHaveMore, true);
  const request = f.state.calls.find(m => m.payloadType === 2137).payload;
  assert.equal(request.count, 2);
  assert.equal(request.period, 1);
  assert.equal(request.fromTimestamp, base - 60000);
  assert.equal(f.state.calls.some(m => [2106, 2111].includes(m.payloadType)), false);
});

test('all documented candle periods map to provider enums and malformed ranges fail before the broker', async (t) => {
  for (const [period, id] of Object.entries(CANDLE_PERIODS)) assert.equal(candleParams(new URLSearchParams({period})).periodId, id);
  const f = await fixture(t);
  for (const query of ['period=__proto__', 'period=m1', 'limit=0', 'limit=1001', 'period=M1&period=H1', 'accountId=99', 'from=200&to=100', 'to=' + (Date.now() + 60000), 'from=-1', 'from=0']) {
    assert.equal((await f.call('/v1/demo/symbols/1/candles?' + query)).status, 400, query);
  }
  assert.equal(f.state.calls.length, 0);
});

test('candles preserve large integers, zero omitted deltas, time gaps and empty histories without inventing data', () => {
  const args = {...candleParams(new URLSearchParams(query)), symbolId: 1};
  const huge = bar(base, {low: '9007199254740993', deltaOpen: 1, deltaClose: 0, deltaHigh: 1, volume: '9007199254740993'});
  const r = normalizeCandles({period: 1, trendbar: [bar(base + 180000, {deltaOpen: undefined, deltaClose: undefined, deltaHigh: undefined}), huge]}, args);
  assert.equal(r.candles[0].open, '90071992547.40994');
  assert.equal(r.candles[0].tickVolume, '9007199254740993');
  assert.equal(r.candles[1].open, '1.10000');
  assert.equal(r.candles[1].openTime - r.candles[0].openTime, 180000);
  assert.deepEqual(normalizeCandles({period: 1}, args).candles, []);
  assert.equal(normalizeCandles({period: 1}, args).brokerHasMore, null);
});

test('malformed historical responses fail closed instead of returning misleading prices', () => {
  const args = {...candleParams(new URLSearchParams(query)), symbolId: 1};
  const changes = [
    {period: 9}, {symbolId: 2}, {hasMore: 'true'}, {trendbar: null},
    {trendbar: [bar(), bar()]}, {trendbar: [bar(base, {utcTimestampInMinutes: null})]},
    {trendbar: [bar(base, {volume: 9007199254740992})]},
    {trendbar: [bar(base, {deltaHigh: 1})]}, {trendbar: [bar(base, {deltaClose: -1})]},
  ];
  for (const change of changes) assert.throws(() => normalizeCandles({period: 1, trendbar: [bar()], ...change}, args), /INVALID_CANDLE_RESPONSE/);
});

test('agents save arbitrary strategy state with optimistic versions without broker calls or enabling trading', async (t) => {
  const f = await fixture(t, {cfg: {...cfg, tradingEnabled: false}});
  const url = '/v1/demo/agents/agent-a/state';
  assert.equal((await f.call(url, {read: true})).status, 404);
  const state = {strategy: 'caller-defined', risk: {budget: 'variable', currency: 'USD'}, checkpoint: {lastDealId: '99'}};
  assert.equal((await f.call(url, {method: 'PUT', read: true, body: {expectedVersion: 0, state}})).status, 403);
  const created = await f.call(url, {method: 'PUT', body: {expectedVersion: 0, state}});
  assert.equal(created.status, 200);
  assert.equal(created.data.version, 1);
  assert.deepEqual((await f.call(url, {read: true})).data.state, state);
  assert.equal((await f.call(url, {method: 'PUT', body: {expectedVersion: 0, state: {}}})).status, 409);
  assert.equal((await f.call(url, {method: 'PUT', body: {expectedVersion: 1, state: {customRule: true}}})).data.version, 2);
  assert.equal((await f.call('/v1/demo/agents/agent-b/state', {method: 'PUT', body: {expectedVersion: 0, state: {other: true}}})).data.version, 1);
  assert.deepEqual((await f.call(url, {read: true})).data.state, {customRule: true});
  assert.equal(f.state.calls.length, 0);
});

test('agent state survives service restart and rejects stale writers without losing newer data', async () => {
  const store = new MemoryStore();
  const first = new TradingService(cfg, {store});
  try {
    await first.handle('save-agent-state', {agentId: 'bot1'}, {expectedVersion: 0, state: {pendingIntent: 'key_123'}});
    first.close();
    const restarted = new TradingService(cfg, {store});
    try {
      assert.equal((await restarted.handle('agent-state', {agentId: 'bot1'})).data.state.pendingIntent, 'key_123');
      const changes = await Promise.allSettled([1, 2].map(n => restarted.handle('save-agent-state', {agentId: 'bot1'}, {expectedVersion: 1, state: {n}})));
      assert.equal(changes.filter(r => r.status === 'fulfilled').length, 1);
    } finally { restarted.close(); }
  } finally { first.close(); }
});

test('invalid state schemas, IDs, oversized bodies and missing persistence are rejected', async (t) => {
  const f = await fixture(t);
  for (const body of [{expectedVersion: -1, state: {}}, {expectedVersion: '0', state: {}}, {expectedVersion: 0, state: []}, {expectedVersion: 0, state: null}, {expectedVersion: 0, state: {}, extra: 1}]) {
    assert.equal((await f.call('/v1/demo/agents/a/state', {method: 'PUT', body})).status, 400);
  }
  assert.equal((await f.call('/v1/demo/agents/bad%20id/state')).status, 400);
  assert.equal((await f.call('/v1/demo/agents/a/state', {method: 'PUT', body: {expectedVersion: 0, state: {padding: 'x'.repeat(9000)}}})).status, 413);
  const service = new TradingService(cfg);
  try { await assert.rejects(service.handle('agent-state', {agentId: 'a'}), /PERSISTENCE_REQUIRED/); }
  finally { service.close(); }
});

test('optional agent attribution survives operation replay and prevents cross-agent idempotency collisions', async (t) => {
  const f = await fixture(t);
  const send = agent => f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'shared_intent_key_001', headers: {'x-agent-id': agent}});
  const opened = await send('agent-a');
  assert.equal(opened.data.status, 'completed');
  assert.equal(opened.data.agentId, 'agent-a');
  assert.equal((await send('agent-a')).data.operationId, opened.data.operationId);
  assert.equal((await send('agent-b')).status, 409);
  assert.equal((await f.call('/v1/demo/operations/' + opened.data.operationId, {read: true})).data.agentId, 'agent-a');
  assert.equal(f.state.calls.filter(m => m.payloadType === 2106).length, 1);
});
