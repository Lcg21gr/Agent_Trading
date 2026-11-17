import {loadEnvFile} from 'node:process';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';
import {createServer} from './app.js';
import {TradingService} from './trading.js';
import {MysqlStore} from './store.js';

function reportFailure(error) {
  const value = error?.code || error?.message || '';
  const code = /^(CONFIG_[A-Z0-9_]+|DEMO_ONLY|EADDRINUSE|EACCES|EADDRNOTAVAIL)$/.test(value)
    ? value : 'STARTUP_FAILED';
  console.error(JSON.stringify({event: 'api_start_failed', code}));
  process.exitCode = 1;
}

let store;
let service;
try {
  // A hosting loader can import this entry instead of invoking `npm start`.
  // Load .env explicitly and preserve variables already supplied by the host.
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const cfg = config();
  store = cfg.database ? new MysqlStore(cfg) : null;
  service = new TradingService(cfg, {store});
  const server = createServer(cfg, service);
  server.once('error', (error) => {
    reportFailure(error);
    service.close();
    store?.close().catch(() => {});
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(JSON.stringify({event: 'api_listening', environment: 'demo', tradingEnabled: cfg.tradingEnabled}));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(async () => {
      service.close();
      try { await store?.close(); process.exit(0); }
      catch { console.error(JSON.stringify({event: 'api_shutdown_failed'})); process.exit(1); }
    });
    setTimeout(() => process.exit(1), 90000).unref();
  });
} catch (error) {
  reportFailure(error);
  service?.close();
  store?.close().catch(() => {});
}
