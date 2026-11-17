import test from 'node:test';
import assert from 'node:assert/strict';
import {MysqlStore} from '../src/store.js';
import {cfg, fixture} from './support/fixtures.js';

test('database failures return actionable 503 codes without SQL, connection details or credentials', async (t) => {
  const cases = [
    ['ER_ACCESS_DENIED_ERROR', 'DB_ACCESS_DENIED'],
    ['ER_BAD_DB_ERROR', 'DB_DATABASE_NOT_FOUND'],
    ['ER_NO_SUCH_TABLE', 'DB_SCHEMA_NOT_INITIALIZED'],
    ['ECONNREFUSED', 'DB_CONNECTION_REFUSED'],
    ['ENOTFOUND', 'DB_HOST_NOT_FOUND'],
    ['ETIMEDOUT', 'DB_CONNECTION_TIMEOUT'],
    ['HANDSHAKE_SSL_ERROR', 'DB_TLS_VERIFICATION_FAILED'],
    ['UNKNOWN_DRIVER_ERROR', 'PERSISTENCE_UNAVAILABLE'],
  ];
  for (const [driverCode, expectedCode] of cases) {
    const store = new MysqlStore({...cfg, database: {host: 'fixture.invalid', user: 'fixture-user', password: 'fixture-private', database: 'fixture'}});
    t.after(() => store.close());
    store.pool.getConnection = async () => { throw Object.assign(new Error('fixture-private SELECT tokens FROM fixture at fixture.invalid'), {code: driverCode}); };
    const f = await fixture(t, {store});
    const r = await f.call('/ready');
    assert.equal(r.status, 503);
    assert.equal(r.data.error, expectedCode);
    assert.ok(r.data.requestId);
    for (const value of ['fixture-private', 'fixture.invalid', 'SELECT tokens', 'fixture-user']) assert.ok(!JSON.stringify(r.data).includes(value));
    assert.equal(f.state.calls.length, 0, 'Database failure must prevent broker requests');
  }
});
