import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {config} from '../src/config.js';
import {env, fixture, order} from './support/fixtures.js';

const count = (f, type) => f.state.calls.filter((m) => m.payloadType === type).length;

test('reused reads authenticate once while positions, balance and PnL are still requested from the broker', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  assert.equal((await f.call('/v1/demo/positions')).data.positions.length, 0);
  f.state.positions = [{positionId: 99}];
  assert.equal((await f.call('/v1/demo/positions')).data.positions[0].positionId, 99);
  f.state.trader.balance = 12345;
  assert.equal((await f.call('/v1/demo/account')).data.balanceRaw, 12345);
  assert.equal(count(f, 2124), 2);
  assert.equal(count(f, 2121), 1);
  assert.equal(count(f, 2187), 1);
  assert.equal(count(f, 2100), 1);
  assert.equal(count(f, 2149), 1);
  assert.equal(count(f, 2102), 1);
  assert.equal(f.state.connections, 1);
});

test('independent account reads can be outstanding together and correlate out-of-order responses', async (t) => {
  const f = await fixture(t, {reuseReadSession: true, state: {holdAccountReads: true}});
  const r = await f.call('/v1/demo/account');
  assert.equal(r.status, 200);
  assert.equal(r.data.currency, 'USD');
  assert.equal(r.data.balanceRaw, 1000000);
  assert.deepEqual(r.data.unrealizedPnl, []);
});

test('replacing stored credentials or approaching expiry invalidates the read session and persists renewal first', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  await f.call('/v1/demo/positions');
  await f.store.setTokens({accessToken: 'replacement', refreshToken: 'replacement-refresh', expiresAt: Date.now() + 3600000});
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.state.calls.filter((m) => m.payloadType === 2149).at(-1).payload.accessToken, 'replacement');
  assert.equal(f.state.connections, 2);
  await f.store.setTokens({...f.store.tokens, expiresAt: Date.now() + 1000});
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.store.tokens.accessToken, 'fixture-renewed');
  assert.equal(count(f, 2173), 1);
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.state.connections, 3);
  assert.equal(count(f, 2106), 0);
});

test('a disconnect during a read fails that request without replay and reconnects only on the next request', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  await f.call('/v1/demo/positions');
  f.state.responseDelayMs = 80;
  const pending = f.call('/v1/demo/positions');
  // Wait for the broker to receive the in-flight read before dropping the wire.
  while (count(f, 2124) < 2) await delay(2);
  f.disconnect();
  assert.equal((await pending).status, 502);
  assert.equal(count(f, 2124), 2);
  f.state.responseDelayMs = 0;
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.state.connections, 2);
  assert.equal(count(f, 2124), 3);
});

test('session revocation rechecks the demo account before further reads', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  await f.call('/v1/demo/positions');
  f.state.live = true;
  f.event(2164, {});
  await delay(10);
  const r = await f.call('/v1/demo/positions');
  assert.equal(r.data.error, 'DEMO_ACCOUNT_NOT_VERIFIED');
  assert.equal(count(f, 2124), 1);
  assert.equal(f.state.connections, 2);
});

test('a total read deadline discards the transport without retrying its callback', async (t) => {
  const f = await fixture(t, {reuseReadSession: true, readSessionOptions: {timeoutMs: 2000}});
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  f.service.readSession.timeoutMs = 60;
  f.state.responseDelayMs = 120;
  const r = await f.call('/v1/demo/positions');
  assert.equal(r.data.error, 'TOTAL_TIMEOUT');
  assert.equal(count(f, 2124), 2);
  f.state.responseDelayMs = 0;
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.state.connections, 2);
});

test('idle expiry and service shutdown close the session; closed services cannot reconnect', async (t) => {
  const f = await fixture(t, {reuseReadSession: true, readSessionOptions: {idleMs: 20}});
  await f.call('/v1/demo/positions');
  await delay(40);
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.state.connections, 2);
  f.service.close();
  assert.equal((await f.call('/v1/demo/positions')).data.error, 'BROKER_SESSION_CLOSED');
  assert.equal(f.state.connections, 2);
});

test('maximum session age requires authentication again even with unchanged tokens', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  await f.call('/v1/demo/positions');
  t.mock.timers.enable({apis: ['Date'], now: Date.now() + 300001});
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  assert.equal(f.state.connections, 2);
});

test('the reused session refuses trading commands; real write paths authenticate afresh and keep idempotency', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  await f.call('/v1/demo/positions');
  await assert.rejects(f.service.readSession.withSession((s) => s.request(2106, {}), {tokenStore: f.store}), /READ_ONLY_SESSION/);
  assert.equal(count(f, 2106), 0);
  await f.call('/v1/demo/positions');
  f.state.scope = 0;
  const denied = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'fresh_scope_open_0001'});
  assert.equal(denied.status, 403);
  assert.equal(count(f, 2106), 0);
  f.state.scope = 1;
  await f.call('/v1/demo/positions');
  const before = f.state.connections;
  const opened = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'fresh_scope_open_0002'});
  assert.equal(opened.data.status, 'completed');
  assert.equal(f.state.connections, before + 1);
  assert.equal(count(f, 2106), 1);
  const replay = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'fresh_scope_open_0002'});
  assert.equal(replay.data.operationId, opened.data.operationId);
  assert.equal(count(f, 2106), 1);
});

test('live quote updates are reused only while fresh and stale subscriptions obtain a new two-sided snapshot', async (t) => {
  const f = await fixture(t, {reuseReadSession: true});
  assert.equal((await f.call('/v1/demo/symbols/1/quote')).status, 200);
  f.event(2131, {symbolId: 1, bid: 120000, ask: 120010, timestamp: Date.now()});
  await delay(5);
  assert.equal((await f.call('/v1/demo/symbols/1/quote')).data.quote.bid, 1.2);
  assert.equal(count(f, 2127), 1);
  t.mock.timers.enable({apis: ['Date'], now: Date.now() + 11000});
  assert.equal((await f.call('/v1/demo/symbols/1/quote')).status, 200);
  assert.equal(count(f, 2129), 1);
  assert.equal(count(f, 2127), 2);
  f.state.symbol.symbolId = 2;
  const next = await f.call('/v1/demo/symbols/2/quote');
  assert.equal(next.status, 200);
  assert.equal(next.data.quote.symbolId, 2);
  assert.equal(count(f, 2129), 2);
  assert.equal(count(f, 2127), 3);
});

test('stale streaming quotes still fail and invalidate the connection', async (t) => {
  const f = await fixture(t, {reuseReadSession: true, state: {quoteOffset: -60000}});
  assert.equal((await f.call('/v1/demo/symbols/1/quote')).data.error, 'FRESH_QUOTE_UNAVAILABLE');
  f.state.quoteOffset = 0;
  assert.equal((await f.call('/v1/demo/symbols/1/quote')).status, 200);
  assert.equal(f.state.connections, 2);
});

test('read-session reuse has a validated configuration rollback switch', () => {
  assert.equal(config(env).reuseReadSession, true);
  assert.equal(config({...env, CTRADER_REUSE_READ_SESSION: 'false'}).reuseReadSession, false);
  assert.throws(() => config({...env, CTRADER_REUSE_READ_SESSION: '1'}), /CONFIG_CTRADER_REUSE_READ_SESSION_INVALID/);
});
