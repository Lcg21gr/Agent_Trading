import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {selectDemo, DemoClient, DEMO_URL, queryDemo} from '../src/ctrader.js';
import {fixed, orderBody, historyParams} from '../src/validation.js';
import {sealTokens, openTokens} from '../src/store.js';
import {TradingService} from '../src/trading.js';
import {env, cfg, order, fixture} from './support/fixtures.js';

const idempotency = 'test_order_key_0001';
const writes = (state) => state.calls.filter((m) => [2106, 2111].includes(m.payloadType));

test('configuration fails closed for missing secrets, live environment, weak or reused keys and missing persistence', () => {
  for (const values of [{}, {...env, API_KEY: 'short'}, {...env, CTRADER_ENV: 'live'}, {...env, TRADING_API_KEY: env.API_KEY}, {...env, TRADING_ENABLED: 'true'}, {...env, TRADING_ENABLED: 'yes'}, {...env, CORS_ORIGINS: '*'}]) assert.throws(() => config(values));
  assert.equal(config(env).tradingEnabled, false);
});

test('selects only the exact unambiguous demo account', () => {
  assert.equal(selectDemo([{traderLogin: 5371977, isLive: false, ctidTraderAccountId: 12}], cfg.login), 12);
  for (const accounts of [[], [{traderLogin: 5371977, isLive: true, ctidTraderAccountId: 12}], [{traderLogin: 5371977, ctidTraderAccountId: 12}], [{traderLogin: 3, isLive: false, ctidTraderAccountId: 12}], [{traderLogin: 5371977, isLive: false, ctidTraderAccountId: '9007199254740993'}]]) assert.throws(() => selectDemo(accounts, cfg.login));
  assert.equal(DEMO_URL, 'wss://demo.ctraderapi.com:5036');
});

test('decimal conversion is exact and request fields are closed', () => {
  assert.equal(fixed('1000.01', 2), 100001);
  for (const value of [1000, '1e3', '-1', 'NaN', '0', '1.001', '01']) assert.throws(() => fixed(value, 2));
  assert.throws(() => orderBody({...order, accountId: 99}));
  assert.throws(() => orderBody({...order, side: 'buy'}));
});

test('history validates timestamps, limits and duplicate or unknown query parameters', () => {
  assert.equal(historyParams(new URLSearchParams(), 'deals').maxRows, 100);
  for (const q of ['from=0&to=9999999999999', 'limit=0', 'limit=1001', 'limit=1&limit=2', 'accountId=5', 'from=1&to=999999999']) assert.throws(() => historyParams(new URLSearchParams(q), 'deals'));
});

test('tokens are encrypted, authenticated and bound to the account namespace', () => {
  const values = {accessToken: 'secret', refreshToken: 'private'};
  const encrypted = sealTokens(values, cfg.encryptionKey, 'account');
  assert.ok(!encrypted.includes('secret'));
  assert.deepEqual(openTokens(encrypted, cfg.encryptionKey, 'account'), values);
  assert.throws(() => openTokens(encrypted, cfg.encryptionKey, 'another-account'));
  const tampered = Buffer.from(encrypted, 'base64'); tampered[30] ^= 1;
  assert.throws(() => openTokens(tampered.toString('base64'), cfg.encryptionKey, 'account'));
});

test('HTTP requires authentication and independent execution key; public health does not claim readiness', async (t) => {
  const f = await fixture(t);
  const health = await fetch(f.base + '/health');
  assert.equal((await health.json()).brokerConnection, 'not_checked');
  assert.equal((await fetch(f.base + '/v1/demo/account')).status, 401);
  assert.equal((await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency, read: true})).status, 403);
  assert.equal((await f.call('/v1/demo/account?accountId=99')).status, 400);
  assert.equal(writes(f.state).length, 0);
});

test('wire integration accepts empty application auth and binary JSON; account data has currency and PnL', async (t) => {
  const f = await fixture(t);
  const r = await f.call('/v1/demo/account');
  assert.equal(r.status, 200);
  assert.equal(r.data.currency, 'USD');
  assert.equal(r.data.balanceRaw, 1000000);
  assert.equal(JSON.stringify(r.data).includes(env.CTRADER_ACCESS_TOKEN), false);
  assert.equal(writes(f.state).length, 0);
});

test('live account and view-only token block writes', async (t) => {
  for (const options of [{live: true}, {scope: 0}]) {
    const f = await fixture(t, options);
    const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
    assert.equal(r.data.status, 'rejected');
    assert.equal(writes(f.state).length, 0);
  }
});

test('preview has no write and opening submits volume and protections atomically', async (t) => {
  const f = await fixture(t);
  const preview = await f.call('/v1/demo/orders/preview', {method: 'POST', body: order, read: true});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.relativeStopLoss, 100);
  assert.equal(writes(f.state).length, 0);
  const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'completed');
  const sent = writes(f.state)[0].payload;
  assert.equal(sent.volume, 100000);
  assert.equal(sent.relativeStopLoss, 100);
  assert.equal(sent.relativeTakeProfit, 200);
  assert.equal(sent.clientOrderId, r.data.operationId);
  assert.equal(sent.stopLoss, undefined);
  assert.equal(r.data.result.positionId, 71);
});

test('same idempotency key replays after a new service instance, while changed bodies conflict', async (t) => {
  const f = await fixture(t);
  const first = await f.service.handle('open', {}, order, idempotency);
  const restarted = new TradingService(cfg, {store: f.store, session: () => { throw Error('must not connect'); }});
  const repeated = await restarted.handle('open', {}, {...order}, idempotency);
  assert.equal(repeated.data.operationId, first.data.operationId);
  await assert.rejects(restarted.handle('open', {}, {...order, side: 'SELL'}, idempotency), /IDEMPOTENCY_CONFLICT/);
  assert.equal(writes(f.state).length, 1);
});

test('invalid volume, excessive spread, exposure, unsupported accounts and closed market cannot send orders', async (t) => {
  const changes = [
    {body: {...order, volume: '1000.01'}}, {body: {...order, volume: '2000'}},
    {body: {...order, stopLossPips: '101'}},
    {state: {spread: 0.001}},
    {state: {positions: [{positionId: 7}]}, cfg: {maxPositions: 1}},
    {change: (s) => { s.symbol.schedule = [{startSecond: 1, endSecond: 2}]; }},
    {change: (s) => { s.trader.accountType = 1; }},
    {change: (s) => { s.trader.balance = 1; }},
    {change: (s) => { s.symbol.stepVolume = 300000; }},
    {body: {...order, symbol: 'GBPUSD'}},
  ];
  for (const c of changes) {
    const f = await fixture(t, {state: c.state, cfg: c.cfg});
    c.change?.(f.state);
    const r = await f.call('/v1/demo/orders', {method: 'POST', body: c.body || order, key: idempotency});
    assert.equal(r.data.status, 'rejected', JSON.stringify(c.body));
    assert.equal(writes(f.state).length, 0);
  }
});

test('a definite broker rejection is persisted and remote descriptions are hidden', async (t) => {
  const f = await fixture(t, {mode: 'reject'});
  const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
  assert.equal(r.status, 422);
  assert.equal(r.data.status, 'rejected');
  assert.equal(JSON.stringify(r.data).includes('fixture-sensitive-description'), false);
});

test('a disconnect after sending stays uncertain; replays never send, new entries block, reconciliation proves the fill', async (t) => {
  const f = await fixture(t, {mode: 'drop-after-fill'});
  const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'uncertain');
  assert.equal((await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency})).status, 202);
  assert.equal((await f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'test_order_key_0002'})).status, 409);
  const reconciled = await f.call(`/v1/demo/operations/${r.data.operationId}/reconcile`, {method: 'POST', body: {}});
  assert.equal(reconciled.data.status, 'completed');
  assert.equal(reconciled.data.result.reconciled, true);
  assert.equal(writes(f.state).length, 1);
});

test('acceptance alone and unverified protection never become completed', async (t) => {
  for (const mode of ['accepted-only', 'no-protection', 'wrong-protection', 'partial-then-reject']) {
    const f = await fixture(t, {mode});
    const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
    assert.equal(r.status, 202);
    assert.equal(r.data.status, 'uncertain');
  }
});

test('closing uses broker volume and verifies absence; foreign positions cannot be closed', async (t) => {
  const f = await fixture(t);
  await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
  const r = await f.call('/v1/demo/positions/71/close', {method: 'POST', body: {}, key: 'test_close_key_0001'});
  assert.equal(r.data.status, 'completed');
  assert.equal(r.data.result.positionClosed, true);
  assert.equal(writes(f.state)[1].payload.volume, 100000);
  f.state.positions = [{positionId: 99, tradeData: {volume: 100000, label: 'other-system'}}];
  const foreign = await f.call('/v1/demo/positions/99/close', {method: 'POST', body: {}, key: 'test_close_key_0002'});
  assert.equal(foreign.status, 404);
  assert.equal(writes(f.state).length, 2);
});

test('writes fail closed without durable storage or trading enablement', async () => {
  await assert.rejects(new TradingService(cfg).handle('open', {}, order, idempotency), /PERSISTENCE_REQUIRED/);
  await assert.rejects(new TradingService({...cfg, tradingEnabled: false}, {store: {}}).handle('open', {}, order, idempotency), /TRADING_DISABLED/);
});

test('expired stored tokens are renewed before queries and saved without leaking them', async (t) => {
  const f = await fixture(t);
  await f.store.setTokens({accessToken: 'fixture-old', refreshToken: 'fixture-old-refresh', expiresAt: Date.now() - 1});
  const r = await f.call('/v1/demo/positions');
  assert.equal(r.status, 200);
  assert.equal(f.state.calls.find((m) => m.payloadType === 2149).payload.accessToken, 'fixture-renewed');
  assert.equal(f.store.tokens.refreshToken, 'fixture-new-refresh');
  assert.equal(JSON.stringify(r.data).includes('fixture-renewed'), false);
});

test('transport refuses unknown message types', async () => {
  await assert.rejects(new DemoClient().request(9999, {}), /MESSAGE_NOT_ALLOWED/);
});

test('oversized and malformed HTTP bodies fail before contacting the broker', async (t) => {
  const f = await fixture(t);
  const headers = {authorization: `Bearer ${cfg.tradingKey}`, 'content-type': 'application/json'};
  for (const [body, status] of [['{', 400], [JSON.stringify({...order, padding: 'x'.repeat(9000)}), 413]]) {
    const r = await fetch(f.base + '/v1/demo/orders', {method: 'POST', headers, body});
    assert.equal(r.status, status);
  }
  assert.equal(f.state.calls.length, 0);
});

test('stale quotes and unsupported precision cannot send a command', async (t) => {
  for (const change of [(s) => { s.quoteOffset = -60000; }, (s) => { s.symbol.pipPosition = 6; }]) {
    const f = await fixture(t); change(f.state);
    const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
    assert.equal(r.data.status, 'rejected');
    assert.equal(writes(f.state).length, 0);
  }
});

test('a lost database confirmation after sending leaves the durable sent marker and blocks resubmission', async (t) => {
  const f = await fixture(t);
  const update = f.store.update.bind(f.store);
  let sent = false;
  f.store.update = async (...args) => {
    if (sent) throw new (await import('../src/errors.js')).ApiError('PERSISTENCE_UNAVAILABLE', 503);
    const result = await update(...args);
    if (args[1] === 'sent') sent = true;
    return result;
  };
  const r = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
  assert.equal(r.status, 503);
  assert.equal((await f.store.unresolved())[0].status, 'sent');
  const retry = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: idempotency});
  assert.equal(retry.status, 202);
  assert.equal(writes(f.state).length, 1);
});

test('bootstrap token invalidation renews authentication once and persists the replacement before any command', async (t) => {
  const f = await fixture(t, {state: {invalidAccess: true}});
  const r = await f.call('/v1/demo/positions');
  assert.equal(r.status, 200);
  assert.equal(f.state.calls.filter((m) => m.payloadType === 2173).length, 1);
  assert.equal(f.store.tokens.accessToken, 'fixture-renewed');
  assert.equal(writes(f.state).length, 0);
});
