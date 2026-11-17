import {config} from '../src/config.js';
import {TradingService} from '../src/trading.js';
import {MysqlStore} from '../src/store.js';
let store;
try {
  const cfg = config();
  store = cfg.database ? new MysqlStore(cfg) : null;
  const service = new TradingService(cfg, {store});
  const result = await service.handle('ready');
  console.log(JSON.stringify(result.data, null, 2));
} catch (error) {
  console.error(JSON.stringify({connection: 'failed', code: error.code || 'CHECK_FAILED'}));
  process.exitCode = 1;
} finally { await store?.close(); }
