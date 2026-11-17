import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MysqlStore} from '../src/store.js';
import {TradingService} from '../src/trading.js';
import {cfg, order, fixture} from './support/fixtures.js';

const enabled = !!process.env.TEST_MYSQL_PORT;
const options = {skip: enabled ? false : 'Set TEST_MYSQL_PORT to an isolated local MySQL instance.'};
const make = () => new MysqlStore({...cfg, CTRADER_CLIENT_ID: randomUUID(), database: {
  host: '127.0.0.1', port: Number(process.env.TEST_MYSQL_PORT), user: 'root', password: '', database: 'agent_trading_test',
}});

test('MySQL schema is repeatable; account locks exclude another process connection; history and encrypted tokens survive reconnect', options, async () => {
  const store = make();
  const second = make();
  second.namespace = store.namespace;
  second.lockName = store.lockName;
  try {
    await store.migrate();
    await store.migrate();
    const id = randomUUID();
    await store.withLock(async (s) => {
      await s.check();
      await assert.rejects(second.withLock(() => {}), /ACCOUNT_BUSY/);
      await s.insert({id, key: 'mysql_case_sensitive_KEY', fingerprint: 'a'.repeat(64), kind: 'open', status: 'reserved', body: order, createdAt: Date.now()});
      assert.equal((await s.unresolved()).length, 1);
      await s.setTokens({accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 9999999999999});
    });
    await store.close();
    await second.withLock(async (s) => {
      assert.equal((await s.get(id)).status, 'reserved');
      assert.equal((await s.findByKey('mysql_case_sensitive_key')), null);
      assert.equal((await s.getTokens()).refreshToken, 'test-refresh');
      await s.update(id, 'completed', {positionId: 71});
      assert.equal((await s.unresolved()).length, 0);
      assert.equal((await s.list(10))[0].result.positionId, 71);
    });
    const [rows] = await second.pool.query('SELECT encrypted_tokens FROM trading_api_tokens WHERE namespace=?', [second.namespace]);
    assert.ok(!rows[0].encrypted_tokens.includes('test-access'));
  } finally { await store.close(); await second.close(); }
});

test('HTTP to real MySQL and WebSocket broker preserves uncertainty and idempotency across application restart', options, async (t) => {
  const store = make();
  await store.migrate();
  t.after(() => store.close());
  const f = await fixture(t, {mode: 'drop-after-fill', store, reuseReadSession: true});
  assert.equal((await f.call('/v1/demo/positions')).status, 200);
  const first = await f.call('/v1/demo/orders', {method: 'POST', body: order, key: 'mysql_test_order_001'});
  assert.equal(first.status, 202);
  const restartedStore = make();
  restartedStore.namespace = store.namespace;
  restartedStore.lockName = store.lockName;
  t.after(() => restartedStore.close());
  const restarted = new TradingService(cfg, {store: restartedStore, session: () => { throw Error('must not send'); }});
  const repeated = await restarted.handle('open', {}, order, 'mysql_test_order_001');
  assert.equal(repeated.data.operationId, first.data.operationId);
  assert.equal(repeated.data.status, 'uncertain');
  await assert.rejects(restarted.handle('open', {}, order, 'mysql_test_order_002'), /UNRESOLVED_OPERATION_BLOCKS_ENTRY/);
  const reconciled = await f.call(`/v1/demo/operations/${first.data.operationId}/reconcile`, {method: 'POST', body: {}});
  assert.equal(reconciled.data.status, 'completed');
  assert.equal(f.state.calls.filter((m) => m.payloadType === 2106).length, 1);
});

test('MySQL minimum account lock outlives a fast response and shutdown waits for its release', options, async () => {
  const store = make();
  const second = make();
  second.namespace = store.namespace;
  second.lockName = store.lockName;
  store.minimumLockMs = 1000;
  try {
    await store.migrate();
    const started = Date.now();
    assert.equal(await store.withLock(async (s) => { await s.check(); return 'ready'; }), 'ready');
    assert.ok(Date.now() - started < 900, 'Response must not wait for the one-second lock floor');
    await assert.rejects(second.withLock(() => {}), /ACCOUNT_BUSY/);
    await store.close();
    assert.ok(Date.now() - started >= 1000, 'Shutdown must wait for the held account lock');
    assert.equal(await second.withLock(async () => 'released'), 'released');
  } finally { await store.close(); await second.close(); }
});

test('agent JSON state persists across MySQL reconnect, separates agents and accounts, and atomically rejects stale versions', options, async () => {
  const store = make();
  const restarted = make();
  const otherAccount = make();
  restarted.namespace = store.namespace;
  restarted.lockName = store.lockName;
  try {
    await store.migrate();
    await store.withLock(async s => {
      const state = {risk: {chosenByCaller: true}, intent: {idempotencyKey: 'agent_a_intent_001'}, custom: [1, 'two'], note: 'Análisis 📈'};
      assert.deepEqual((await s.saveAgentState('agent-a', 0, state)).state, state);
      await s.saveAgentState('Agent-a', 0, {distinct: true});
      await assert.rejects(s.saveAgentState('agent-a', 0, {}), /AGENT_STATE_VERSION_CONFLICT/);
    });
    await store.close();
    await restarted.withLock(async s => {
      assert.equal((await s.getAgentState('agent-a')).state.intent.idempotencyKey, 'agent_a_intent_001');
      assert.deepEqual((await s.getAgentState('Agent-a')).state, {distinct: true});
      const results = await Promise.allSettled([1, 2].map(n => s.saveAgentState('agent-a', 1, {n})));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.match(results.find(r => r.status === 'rejected').reason.message, /AGENT_STATE_VERSION_CONFLICT/);
      assert.equal((await s.getAgentState('agent-a')).version, 2);
    });
    assert.equal(await otherAccount.withLock(s => s.getAgentState('agent-a')), null);
  } finally { await store.close(); await restarted.close(); await otherAccount.close(); }
});
