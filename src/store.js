import mysql from 'mysql2/promise';
import {createHash, createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {ApiError, requireValue} from './errors.js';
import {setTimeout as delay} from 'node:timers/promises';

export const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trading_api_operations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    namespace CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fingerprint CHAR(64) CHARACTER SET ascii NOT NULL,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    body_json LONGTEXT NOT NULL,
    result_json LONGTEXT NULL,
    created_ms BIGINT NOT NULL,
    updated_ms BIGINT NOT NULL,
    UNIQUE KEY operation_key (namespace, idempotency_key),
    KEY operation_status (namespace, status),
    KEY operation_time (namespace, created_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS trading_api_tokens (
    namespace CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    encrypted_tokens TEXT NOT NULL,
    updated_ms BIGINT NOT NULL
  ) ENGINE=InnoDB`,
];

const databaseErrors = new Map([
  ['ER_ACCESS_DENIED_ERROR', 'DB_ACCESS_DENIED'],
  ['ER_DBACCESS_DENIED_ERROR', 'DB_ACCESS_DENIED'],
  ['ER_BAD_DB_ERROR', 'DB_DATABASE_NOT_FOUND'],
  ['ER_NO_SUCH_TABLE', 'DB_SCHEMA_NOT_INITIALIZED'],
  ['ECONNREFUSED', 'DB_CONNECTION_REFUSED'],
  ['ENOTFOUND', 'DB_HOST_NOT_FOUND'],
  ['ETIMEDOUT', 'DB_CONNECTION_TIMEOUT'],
  ['PROTOCOL_SEQUENCE_TIMEOUT', 'DB_CONNECTION_TIMEOUT'],
  ['HANDSHAKE_SSL_ERROR', 'DB_TLS_VERIFICATION_FAILED'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DB_TLS_VERIFICATION_FAILED'],
  ['CERT_HAS_EXPIRED', 'DB_TLS_VERIFICATION_FAILED'],
]);

export function sealTokens(tokens, key, namespace) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(namespace));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openTokens(value, key, namespace) {
  const buffer = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), buffer.subarray(0, 12));
  decipher.setAAD(Buffer.from(namespace));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8'));
}

function decode(row) {
  return row ? {id: row.id, kind: row.kind, status: row.status, fingerprint: row.fingerprint,
    body: JSON.parse(row.body_json), result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: Number(row.created_ms), updatedAt: Number(row.updated_ms)} : null;
}

export class MysqlStore {
  constructor(cfg) {
    this.namespace = createHash('sha256').update(`demo:${cfg.CTRADER_CLIENT_ID}:${cfg.login}`).digest('hex');
    this.lockName = `trading:${this.namespace.slice(0, 56)}`;
    this.key = cfg.encryptionKey;
    this.minimumLockMs = cfg.requestIntervalMs;
    this.pool = mysql.createPool({...cfg.database, connectionLimit: 3, maxIdle: 2,
      waitForConnections: false, connectTimeout: 8000, supportBigNumbers: true, bigNumberStrings: true,
      multipleStatements: false, enableKeepAlive: true});
  }

  async migrate() {
    for (const sql of MYSQL_SCHEMA) await this.pool.query({sql, timeout: 10000});
  }

  async withLock(action) {
    let connection;
    let acquired = false;
    let started = 0;
    try {
      connection = await this.pool.getConnection();
      const run = async (sql, values = []) => (await connection.query({sql, timeout: 8000}, values))[0];
      const rows = await run('SELECT GET_LOCK(?, 0) AS acquired', [this.lockName]);
      requireValue(Number(rows[0].acquired) === 1, 'ACCOUNT_BUSY', 429);
      acquired = true;
      started = Date.now();
      const ns = this.namespace;
      const scoped = {
        findByKey: async (key) => decode((await run('SELECT * FROM trading_api_operations WHERE namespace=? AND idempotency_key=?', [ns, key]))[0]),
        get: async (id) => decode((await run('SELECT * FROM trading_api_operations WHERE namespace=? AND id=?', [ns, id]))[0]),
        list: async (limit = 50) => (await run('SELECT * FROM trading_api_operations WHERE namespace=? ORDER BY created_ms DESC LIMIT ?', [ns, limit])).map(decode),
        unresolved: async () => (await run("SELECT * FROM trading_api_operations WHERE namespace=? AND status IN ('reserved','sent','uncertain') ORDER BY created_ms", [ns])).map(decode),
        insert: async (op) => {
          await run('INSERT INTO trading_api_operations (id,namespace,idempotency_key,fingerprint,kind,status,body_json,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?,?)',
            [op.id, ns, op.key, op.fingerprint, op.kind, op.status, JSON.stringify(op.body), op.createdAt, op.createdAt]);
          return op;
        },
        update: async (id, status, result) => {
          const r = await run('UPDATE trading_api_operations SET status=?,result_json=?,updated_ms=? WHERE namespace=? AND id=?', [status, JSON.stringify(result), Date.now(), ns, id]);
          requireValue(r.affectedRows === 1, 'OPERATION_STORE_INCONSISTENT', 503);
          return scoped.get(id);
        },
        getTokens: async () => {
          const row = (await run('SELECT encrypted_tokens FROM trading_api_tokens WHERE namespace=?', [ns]))[0];
          return row ? openTokens(row.encrypted_tokens, this.key, ns) : null;
        },
        setTokens: async (tokens) => {
          requireValue(this.key, 'TOKEN_ENCRYPTION_KEY_REQUIRED', 503);
          await run('INSERT INTO trading_api_tokens(namespace,encrypted_tokens,updated_ms) VALUES (?,?,?) ON DUPLICATE KEY UPDATE encrypted_tokens=VALUES(encrypted_tokens),updated_ms=VALUES(updated_ms)',
            [ns, sealTokens(tokens, this.key, ns), Date.now()]);
        },
        check: async () => {
          await run('SELECT id FROM trading_api_operations WHERE namespace=? LIMIT 1', [ns]);
          await run('SELECT namespace FROM trading_api_tokens WHERE namespace=? LIMIT 1', [ns]);
        },
      };
      return await action(scoped);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Expose only a fixed diagnostic code, never a driver message, SQL text,
      // hostname, username, password or decrypted token.
      throw new ApiError(databaseErrors.get(error?.code) || 'PERSISTENCE_UNAVAILABLE', 503);
    } finally {
      if (connection) {
        if (acquired) {
          await delay(Math.max(0, this.minimumLockMs - (Date.now() - started)));
          try { await connection.query({sql: 'SELECT RELEASE_LOCK(?)', timeout: 3000}, [this.lockName]); connection.release(); }
          catch { connection.destroy(); }
        } else connection.release();
      }
    }
  }

  close() { return this.closing ||= this.pool.end(); }
}
