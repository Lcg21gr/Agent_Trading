export function config(env = process.env) {
  const values = {};
  for (const key of ['API_KEY', 'CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_ACCESS_TOKEN']) {
    const value = env[key];
    if (typeof value !== 'string' || !value || /\s/.test(value)) throw new Error(`CONFIG_${key}_INVALID`);
    values[key] = value;
  }
  const secret = (value) => typeof value === 'string' && value.length >= 32 && !value.startsWith('REPLACE_') && !/\s/.test(value);
  if (!secret(values.API_KEY)) throw new Error('CONFIG_API_KEY_WEAK');
  if (env.CTRADER_ENV && env.CTRADER_ENV !== 'demo') throw new Error('DEMO_ONLY');
  const login = env.CTRADER_ACCOUNT_LOGIN || '5371977';
  if (!/^[1-9]\d{0,14}$/.test(login)) throw new Error('CONFIG_ACCOUNT_INVALID');
  const integer = (key, fallback, min, max) => {
    const value = String(env[key] ?? fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`CONFIG_${key}_INVALID`);
    return Number(value);
  };
  const enabled = env.TRADING_ENABLED || 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('CONFIG_TRADING_ENABLED_INVALID');
  const tradingKey = env.TRADING_API_KEY || '';
  if (tradingKey && (!secret(tradingKey) || tradingKey === values.API_KEY)) throw new Error('CONFIG_TRADING_API_KEY_INVALID');
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY || '';
  if (encryptionKey && (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32)) throw new Error('CONFIG_TOKEN_ENCRYPTION_KEY_INVALID');
  const database = env.MYSQL_HOST ? {
    host: env.MYSQL_HOST, port: integer('MYSQL_PORT', 3306, 1, 65535),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE,
    ...(env.MYSQL_SSL_CA ? {ssl: {ca: env.MYSQL_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true}} : {}),
  } : null;
  if (database && ['user', 'password', 'database'].some((k) => !database[k])) throw new Error('CONFIG_DATABASE_INVALID');
  if (database && !encryptionKey) throw new Error('CONFIG_DATABASE_REQUIRES_ENCRYPTION_KEY');
  if (env.CTRADER_REFRESH_TOKEN && (typeof env.CTRADER_REFRESH_TOKEN !== 'string' || /\s/.test(env.CTRADER_REFRESH_TOKEN))) throw new Error('CONFIG_REFRESH_TOKEN_INVALID');
  if (enabled === 'true' && (!tradingKey || !database || !encryptionKey)) throw new Error('CONFIG_TRADING_REQUIRES_DATABASE_AND_KEYS');
  const symbols = (env.ALLOWED_SYMBOLS || 'EURUSD').split(',');
  if (!symbols.length || symbols.some((s) => !/^[A-Z0-9._-]{1,32}$/.test(s)) || new Set(symbols).size !== symbols.length) throw new Error('CONFIG_SYMBOLS_INVALID');
  const label = env.ORDER_LABEL || 'agent-trading-api';
  if (!/^[a-zA-Z0-9_-]{3,50}$/.test(label)) throw new Error('CONFIG_ORDER_LABEL_INVALID');
  const origins = (env.CORS_ORIGINS || '').split(',').filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'https:') throw new Error('CONFIG_CORS_INVALID');
  }
  return {
    ...values, CTRADER_REFRESH_TOKEN: env.CTRADER_REFRESH_TOKEN || '',
    login, port: integer('PORT', 3000, 1, 65535), host: env.HOST || '0.0.0.0',
    tradingEnabled: enabled === 'true', tradingKey, encryptionKey, database, label, symbols, origins,
    maxVolume: integer('MAX_VOLUME_UNITS', 1000, 1, 1000000) * 100,
    maxPositions: integer('MAX_OPEN_POSITIONS', 1, 1, 20),
    maxSpreadPips: integer('MAX_SPREAD_PIPS', 3, 1, 100),
    maxStopPips: integer('MAX_STOP_LOSS_PIPS', 100, 1, 10000),
    marginReservePercent: integer('MARGIN_RESERVE_PERCENT', 50, 1, 95),
    requestIntervalMs: 1000,
  };
}
