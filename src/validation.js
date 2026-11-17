import {ApiError, requireValue} from './errors.js';

export function positiveId(value) {
  requireValue(typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)), 'INVALID_ID', 400);
  return Number(value);
}

export function exactFields(value, fields) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every((f) => Object.hasOwn(value, f)), 'INVALID_BODY_FIELDS', 400);
}

export function fixed(value, digits, code = 'INVALID_DECIMAL') {
  requireValue(typeof value === 'string' && new RegExp(`^(0|[1-9]\\d{0,8})(?:\\.\\d{1,${digits}})?$`).test(value), code, 400);
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0'));
  requireValue(Number.isSafeInteger(result) && result > 0, code, 400);
  return result;
}

export function orderBody(body) {
  exactFields(body, ['symbol', 'side', 'volume', 'stopLossPips', 'takeProfitPips']);
  requireValue(typeof body.symbol === 'string' && /^[A-Z0-9._-]{1,32}$/.test(body.symbol), 'INVALID_SYMBOL', 400);
  requireValue(['BUY', 'SELL'].includes(body.side), 'INVALID_SIDE', 400);
  fixed(body.volume, 2, 'INVALID_VOLUME');
  fixed(body.stopLossPips, 2, 'INVALID_STOP_LOSS');
  fixed(body.takeProfitPips, 2, 'INVALID_TAKE_PROFIT');
  return body;
}

export function historyParams(search, kind, now = Date.now()) {
  const allowed = kind === 'deals' ? ['from', 'to', 'limit'] : ['from', 'to'];
  for (const [key] of search) requireValue(allowed.includes(key) && search.getAll(key).length === 1, 'INVALID_QUERY', 400);
  const time = (key, fallback) => {
    const value = search.get(key) ?? String(fallback);
    requireValue(/^\d{1,13}$/.test(value) && Number.isSafeInteger(Number(value)), 'INVALID_HISTORY_RANGE', 400);
    return Number(value);
  };
  const toTimestamp = time('to', now);
  const fromTimestamp = time('from', toTimestamp - 86400000);
  requireValue(fromTimestamp >= 0 && fromTimestamp < toTimestamp && toTimestamp <= now && toTimestamp - fromTimestamp <= 7 * 86400000, 'INVALID_HISTORY_RANGE', 400);
  const result = {fromTimestamp, toTimestamp};
  if (kind === 'deals') {
    const limit = search.get('limit') ?? '100';
    requireValue(/^[1-9]\d{0,3}$/.test(limit) && Number(limit) <= 1000, 'INVALID_LIMIT', 400);
    result.maxRows = Number(limit);
  }
  return result;
}

export async function readJson(req) {
  requireValue(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || ''), 'JSON_REQUIRED', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) { req.resume(); throw new ApiError('BODY_TOO_LARGE', 413); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('INVALID_JSON', 400); }
}
