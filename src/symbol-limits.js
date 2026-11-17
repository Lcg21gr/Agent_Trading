export const DEFAULT_ALLOWED_SYMBOLS = Object.freeze(['*']);

const fiat = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'CNH', 'CNY', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'MXN', 'BRL', 'RUB', 'ILS', 'THB']);

export function validSymbolName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

export function symbolAllowed(cfg, symbol) {
  return cfg.symbols.includes('*') || cfg.symbols.includes(symbol);
}

function isForex(symbol) {
  const match = /^([A-Z]{3})([A-Z]{3})(?:[._-].*)?$/.exec(symbol);
  return !!match && fiat.has(match[1]) && fiat.has(match[2]);
}

export function parseSymbolLimits(raw) {
  if (!raw) return {};
  let values;
  try { values = JSON.parse(raw); } catch { throw new Error('CONFIG_SYMBOL_LIMITS_INVALID'); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('CONFIG_SYMBOL_LIMITS_INVALID');
  const result = Object.create(null);
  for (const [symbol, limits] of Object.entries(values)) {
    if (!validSymbolName(symbol) || symbol === '*' || !limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('CONFIG_SYMBOL_LIMITS_INVALID');
    const parsed = {};
    for (const [key, value] of Object.entries(limits)) {
      if (!['maxSpreadPips', 'maxStopLossPips', 'maxSpreadBps'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000) throw new Error('CONFIG_SYMBOL_LIMITS_INVALID');
      parsed[key] = value;
    }
    result[symbol] = parsed;
  }
  return result;
}

export function symbolLimits(cfg, symbol) {
  const forex = isForex(symbol);
  return {
    maxVolumeUnits: cfg.maxVolume / 100,
    ...(forex ? {maxSpreadPips: cfg.maxSpreadPips, maxStopLossPips: cfg.maxStopPips} : {maxSpreadBps: cfg.maxSpreadBps ?? 300}),
    ...cfg.symbolLimits?.[symbol],
  };
}
