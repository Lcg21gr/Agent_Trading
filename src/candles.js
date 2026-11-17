import {requireValue} from './errors.js';

// Enum values are defined by Spotware's ProtoOATrendbarPeriod, not durations.
export const CANDLE_PERIODS = Object.freeze({M1: 1, M2: 2, M3: 3, M4: 4, M5: 5, M10: 6, M15: 7, M30: 8, H1: 9, H4: 10, H12: 11, D1: 12, W1: 13, MN1: 14});
const minutes = {M1: 1, M2: 2, M3: 3, M4: 4, M5: 5, M10: 10, M15: 15, M30: 30, H1: 60, H4: 240, H12: 720, D1: 1440, W1: 10080, MN1: 44640};
const maxRange = 3660 * 86400000;

export function candleParams(search, now = Date.now()) {
  for (const [key] of search) requireValue(['period', 'from', 'to', 'limit'].includes(key) && search.getAll(key).length === 1, 'INVALID_QUERY', 400);
  const period = search.get('period') ?? 'M1';
  requireValue(Object.hasOwn(CANDLE_PERIODS, period), 'INVALID_CANDLE_PERIOD', 400);
  const limit = search.get('limit') ?? '200';
  requireValue(/^[1-9]\d{0,3}$/.test(limit) && Number(limit) <= 1000, 'INVALID_LIMIT', 400);
  const timestamp = (key, fallback) => {
    const value = search.get(key) ?? String(fallback);
    requireValue(/^\d{1,13}$/.test(value) && Number.isSafeInteger(Number(value)), 'INVALID_HISTORY_RANGE', 400);
    return Number(value);
  };
  const toTimestamp = timestamp('to', now);
  const lookback = Math.min(maxRange, Math.max(7 * 86400000, minutes[period] * Number(limit) * 120000));
  const fromTimestamp = timestamp('from', Math.max(0, toTimestamp - lookback));
  requireValue(fromTimestamp >= 0 && fromTimestamp < toTimestamp && toTimestamp <= Math.min(now, 2147483646000) && toTimestamp - fromTimestamp <= maxRange, 'INVALID_HISTORY_RANGE', 400);
  return {period, periodId: CANDLE_PERIODS[period], fromTimestamp, toTimestamp, count: Number(limit)};
}

function integer(value, signed = false) {
  requireValue((typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^-?(0|[1-9]\d{0,19})$/.test(value)), 'INVALID_CANDLE_RESPONSE', 502);
  const result = BigInt(value);
  requireValue(result >= (signed ? -(1n << 63n) : 0n) && result <= (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n), 'INVALID_CANDLE_RESPONSE', 502);
  return result;
}

function price(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100000n}.${String(abs % 100000n).padStart(5, '0')}`;
}

export function normalizeCandles(response, args) {
  requireValue(response.period === args.period || response.period === args.periodId, 'INVALID_CANDLE_RESPONSE', 502);
  requireValue(response.symbolId === undefined || String(response.symbolId) === String(args.symbolId), 'INVALID_CANDLE_RESPONSE', 502);
  requireValue(response.hasMore === undefined || typeof response.hasMore === 'boolean', 'INVALID_CANDLE_RESPONSE', 502);
  const bars = response.trendbar === undefined ? [] : response.trendbar;
  requireValue(Array.isArray(bars) && bars.length <= 10000, 'INVALID_CANDLE_RESPONSE', 502);
  const timestamps = new Set();
  const candles = bars.map((bar) => {
    requireValue(bar && typeof bar === 'object' && !Array.isArray(bar), 'INVALID_CANDLE_RESPONSE', 502);
    requireValue(bar.period === undefined || bar.period === args.period || bar.period === args.periodId, 'INVALID_CANDLE_RESPONSE', 502);
    const rawTime = bar.utcTimestampInMinutes;
    const time = Number(rawTime);
    requireValue(((typeof rawTime === 'number' && Number.isSafeInteger(rawTime)) || (typeof rawTime === 'string' && /^\d{1,10}$/.test(rawTime))) && time >= 0 && time <= 4294967295 && !timestamps.has(time), 'INVALID_CANDLE_RESPONSE', 502);
    timestamps.add(time);
    const low = integer(bar.low ?? 0, true);
    const open = integer(bar.deltaOpen ?? 0);
    const close = integer(bar.deltaClose ?? 0);
    const high = integer(bar.deltaHigh ?? 0);
    requireValue(high >= open && high >= close, 'INVALID_CANDLE_RESPONSE', 502);
    const volume = integer(bar.volume);
    requireValue(volume <= (1n << 63n) - 1n, 'INVALID_CANDLE_RESPONSE', 502);
    return {openTime: time * 60000, open: price(low + open), high: price(low + high), low: price(low), close: price(low + close), tickVolume: String(volume)};
  }).filter(bar => bar.openTime >= args.fromTimestamp && bar.openTime <= args.toTimestamp).sort((a, b) => a.openTime - b.openTime);
  const selected = candles.slice(-args.count);
  const mayHaveMore = response.hasMore === true || bars.length >= args.count;
  const nextTo = mayHaveMore && selected.length && selected[0].openTime > args.fromTimestamp ? selected[0].openTime - 1 : null;
  return {symbolId: args.symbolId, period: args.period, range: {from: args.fromTimestamp, to: args.toTimestamp}, limit: args.count,
    candles: selected, brokerHasMore: response.hasMore ?? null, mayHaveMore, nextTo};
}
