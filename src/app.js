import http from 'node:http';
import {createHash, timingSafeEqual, randomUUID} from 'node:crypto';
import {TradingService} from './trading.js';
import {ApiError, requireValue} from './errors.js';
import {exactFields, orderBody, positiveId, historyParams, readJson} from './validation.js';

const hash = (x) => createHash('sha256').update(x).digest();
const matchesKey = (header, key) => key && timingSafeEqual(hash(header || ''), hash(`Bearer ${key}`));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function route(method, url) {
  const path = url.pathname;
  if (method === 'GET') {
    const simple = {'/ready': 'ready', '/v1/demo/capabilities': 'capabilities', '/v1/demo/account': 'account', '/v1/demo/positions': 'positions',
      '/v1/demo/orders': 'orders', '/v1/demo/symbols': 'symbols', '/v1/demo/deals': 'deals',
      '/v1/demo/order-history': 'order-history', '/v1/demo/operations': 'operations'};
    if (simple[path]) return {kind: simple[path], args: {}};
    const symbol = path.match(/^\/v1\/demo\/symbols\/(\d+)(\/quote)?$/);
    if (symbol) return {kind: symbol[2] ? 'quote' : 'symbol', args: {symbolId: positiveId(symbol[1])}};
    const op = path.match(new RegExp(`^/v1/demo/operations/(${uuid})$`));
    if (op) return {kind: 'operation', args: {id: op[1]}};
  }
  if (method === 'POST') {
    if (path === '/v1/demo/orders') return {kind: 'open', args: {}, trade: true};
    if (path === '/v1/demo/orders/preview') return {kind: 'preview', args: {}};
    const close = path.match(/^\/v1\/demo\/positions\/(\d+)\/close$/);
    if (close) return {kind: 'close', args: {positionId: positiveId(close[1])}, trade: true};
    const op = path.match(new RegExp(`^/v1/demo/operations/(${uuid})/reconcile$`));
    if (op) return {kind: 'reconcile', args: {id: op[1]}, trade: true};
  }
  throw new ApiError('NOT_FOUND', 404);
}

export function createServer(cfg, service = new TradingService(cfg)) {
  let busy = false;
  let last = 0;
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const origin = req.headers.origin;
    const cors = origin && cfg.origins.includes(origin) ? {'access-control-allow-origin': origin, vary: 'Origin'} : {};
    const send = (status, data) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-request-id': requestId, ...cors,
        ...(status === 401 ? {'www-authenticate': 'Bearer'} : {}),
        ...(status === 429 ? {'retry-after': '1'} : {})});
      res.end(JSON.stringify(data));
    };
    try {
      requireValue(req.url.length <= 2048, 'URL_TOO_LONG', 414);
      if (req.method === 'GET' && req.url === '/health') return send(200, {status: 'up', environment: 'demo', brokerConnection: 'not_checked'});
      requireValue(!origin || cfg.origins.includes(origin), 'ORIGIN_NOT_ALLOWED', 403);
      if (req.method === 'OPTIONS') {
        requireValue(origin && cfg.origins.includes(origin), 'ORIGIN_NOT_ALLOWED', 403);
        res.writeHead(204, {...cors, 'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key', 'access-control-max-age': '600'});
        res.end(); return;
      }
      const tradeAuth = matchesKey(req.headers.authorization, cfg.tradingKey);
      requireValue(tradeAuth || matchesKey(req.headers.authorization, cfg.API_KEY), 'UNAUTHORIZED', 401);
      const url = new URL(req.url, 'http://localhost');
      const selected = route(req.method, url);
      requireValue(!selected.trade || tradeAuth, 'TRADING_KEY_REQUIRED', 403);
      if (['deals', 'order-history'].includes(selected.kind)) selected.args = historyParams(url.searchParams, selected.kind);
      else if (selected.kind === 'operations') {
        const limit = url.searchParams.get('limit') || '50';
        requireValue([...url.searchParams.keys()].every((k) => k === 'limit') && url.searchParams.getAll('limit').length <= 1 && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 100, 'INVALID_LIMIT', 400);
        selected.args.limit = Number(limit);
      } else requireValue(!url.search, 'INVALID_QUERY', 400);
      requireValue(!busy && Date.now() - last >= cfg.requestIntervalMs, 'BUSY_OR_RATE_LIMITED', 429);
      // Reserve before reading the body to prevent concurrent submissions in this process.
      busy = true;
      last = Date.now();
      try {
        let body = null;
        if (req.method === 'POST') {
          body = await readJson(req);
          if (['open', 'preview'].includes(selected.kind)) orderBody(body);
          else exactFields(body, []);
        }
        const result = await service.handle(selected.kind, selected.args, body, req.headers['idempotency-key']);
        send(result.httpStatus || 200, result.data);
      } finally { busy = false; }
    } catch (error) {
      req.resume();
      const known = error instanceof ApiError;
      send(known ? error.status : 500, {error: known ? error.code : 'INTERNAL_ERROR', requestId});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  server.timeout = 95000;
  return server;
}
