import {config} from '../src/config.js';
import {DemoClient} from '../src/ctrader.js';
import {MysqlStore} from '../src/store.js';
let store;
let client;
try {
  const cfg = config();
  if (!cfg.database || !cfg.encryptionKey) throw new Error('missing');
  store = new MysqlStore(cfg);
  await store.withLock(async (scope) => {
    const prior = await scope.getTokens();
    const refreshToken = prior?.refreshToken || cfg.CTRADER_REFRESH_TOKEN;
    if (!refreshToken) throw new Error('missing');
    client = new DemoClient();
    await client.connect();
    await client.request(2100, {clientId: cfg.CTRADER_CLIENT_ID, clientSecret: cfg.CTRADER_CLIENT_SECRET});
    const next = await client.request(2173, {refreshToken});
    if (typeof next.accessToken !== 'string' || typeof next.refreshToken !== 'string' || !(Number(next.expiresIn) > 0)) throw new Error('invalid');
    await scope.setTokens({accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: Date.now() + Number(next.expiresIn) * 1000});
  });
  console.log('OAuth tokens renewed and encrypted in MySQL. No token values printed.');
} catch { console.error('Token renewal could not be verified. Do not repeat after an uncertain response; reconcile OAuth access first.'); process.exitCode = 1; }
finally { client?.close(); await store?.close(); }
