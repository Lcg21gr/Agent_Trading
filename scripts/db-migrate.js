import {config} from '../src/config.js';
import {MysqlStore} from '../src/store.js';
let store;
try {
  const cfg = config();
  if (!cfg.database) throw new Error('missing');
  store = new MysqlStore(cfg);
  await store.migrate();
  console.log('Database schema ready. Existing operations and tokens were preserved.');
} catch { console.error('Database migration failed. Check MYSQL_* variables and database permissions.'); process.exitCode = 1; }
finally { await store?.close(); }
