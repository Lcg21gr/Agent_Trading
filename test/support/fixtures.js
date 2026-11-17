import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {config} from '../../src/config.js';
import {DemoClient, withDemo} from '../../src/ctrader.js';
import {TradingService} from '../../src/trading.js';
import {createServer} from '../../src/server.js';
import {ApiError} from '../../src/errors.js';

export const env = {API_KEY: 'r'.repeat(40), TRADING_API_KEY: 'w'.repeat(40),
  CTRADER_CLIENT_ID: 'fixture-client', CTRADER_CLIENT_SECRET: 'fixture-secret', CTRADER_ACCESS_TOKEN: 'fixture-token',
  CTRADER_REFRESH_TOKEN: 'fixture-refresh', TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64')};
export const cfg = {...config(env), tradingEnabled: true, requestIntervalMs: 0};
export const order = {symbol: 'EURUSD', side: 'BUY', volume: '1000', stopLossPips: '10', takeProfitPips: '20'};
export const symbol = {symbolId: 1, minVolume: 100000, maxVolume: 100000000, stepVolume: 100000,
  digits: 5, pipPosition: 4, enableShortSelling: true, slDistance: 0, tpDistance: 0,
  tradingMode: 0, scheduleTimeZone: 'UTC', schedule: [{startSecond: 0, endSecond: 604800}]};

// Deliberately test-only. Production writes always require MySQL.
export class MemoryStore {
  constructor() { this.ops = new Map(); this.tokens = null; this.busy = false; }
  async withLock(fn) {
    if (this.busy) throw new ApiError('ACCOUNT_BUSY', 429);
    this.busy = true;
    try { return await fn(this); } finally { this.busy = false; }
  }
  async findByKey(key) { return [...this.ops.values()].find((o) => o.key === key); }
  async get(id) { return this.ops.get(id); }
  async list(limit = 50) { return [...this.ops.values()].reverse().slice(0, limit); }
  async unresolved() { return [...this.ops.values()].filter((o) => ['sent', 'uncertain', 'reserved'].includes(o.status)); }
  async insert(op) { this.ops.set(op.id, structuredClone(op)); return op; }
  async update(id, status, result) { const op = {...this.ops.get(id), status, result: structuredClone(result), updatedAt: Date.now()}; this.ops.set(id, op); return op; }
  async getTokens() { return this.tokens; }
  async setTokens(tokens) { this.tokens = tokens; }
  async check() {}
}

export async function fixture(t, options = {}) {
  const state = {positions: [], history: [], calls: [], mode: options.mode || 'normal',
    live: options.live || false, scope: options.scope ?? 1, symbol: structuredClone(symbol),
    trader: {ctidTraderAccountId: 12, balance: 1000000, moneyDigits: 2, depositAssetId: 1, accessRights: 0, accountType: 0},
    quoteOffset: 0, spread: 0.0001, ...options.state};
  const brokerHttp = http.createServer();
  const wss = new WebSocketServer({server: brokerHttp});
  wss.on('connection', (ws) => ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    const p = m.payload;
    if (m.payloadType === 51) return;
    state.calls.push(structuredClone(m));
    const send = (type, payload, binary = false) => ws.send(JSON.stringify({clientMsgId: m.clientMsgId, payloadType: type, ...(payload === undefined ? {} : {payload})}), {binary});
    const wrap = (payload) => ({ctidTraderAccountId: 12, ...payload});
    switch (m.payloadType) {
      case 2100: return send(2101); // Real cTrader omits the empty payload.
      case 2149:
        if (state.invalidAccess && p.accessToken !== 'fixture-renewed') return send(2142, {errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'fixture-sensitive-description'});
        return send(2150, {permissionScope: state.scope, ctidTraderAccount: [{traderLogin: 5371977, isLive: state.live, ctidTraderAccountId: 12}]});
      case 2102: return send(2103, wrap({}));
      case 2121: return send(2122, wrap({trader: state.trader}));
      case 2112: return send(2113, wrap({asset: [{assetId: 1, name: 'USD'}]}));
      case 2187: return send(2188, wrap({moneyDigits: 2, positionUnrealizedPnL: []}));
      case 2124: return send(2125, wrap({position: state.positions, order: []}), true);
      case 2114: return send(2115, wrap({symbol: [{symbolId: 1, symbolName: 'EURUSD', enabled: true}]}));
      case 2116: return send(2117, wrap({symbol: [state.symbol]}));
      case 2139: return send(2140, wrap({moneyDigits: 2, margin: [{volume: p.volume[0], buyMargin: 300, sellMargin: 300}]}));
      case 2127: {
        send(2128, wrap({}));
        const ts = Date.now() + state.quoteOffset;
        ws.send(JSON.stringify({payloadType: 2131, payload: wrap({symbolId: 1, bid: 110000, timestamp: ts})}));
        ws.send(JSON.stringify({payloadType: 2131, payload: wrap({symbolId: 1, ask: Math.round((1.1 + state.spread) * 100000), timestamp: ts})}));
        return;
      }
      case 2106: {
        if (state.mode === 'reject') return send(2132, wrap({errorCode: 'NOT_ENOUGH_MONEY', description: 'fixture-sensitive-description'}));
        const position = {positionId: 71, positionStatus: 1, price: 1.1001,
          tradeData: {symbolId: p.symbolId, volume: p.volume, tradeSide: p.tradeSide, label: p.label},
          stopLoss: p.tradeSide === 1 ? 1.0991 : 1.1011, takeProfit: p.tradeSide === 1 ? 1.1021 : 1.0981, usedMargin: 300, moneyDigits: 2};
        if (state.mode === 'no-protection') delete position.stopLoss;
        if (state.mode === 'wrong-protection') position.stopLoss -= 0.005;
        state.positions = [position];
        const o = {orderId: 81, positionId: 71, clientOrderId: p.clientOrderId, orderStatus: 2, executedVolume: p.volume, tradeData: position.tradeData};
        state.history.push(o);
        if (state.mode === 'partial-then-reject') {
          position.tradeData.volume = p.volume / 2;
          o.executedVolume = p.volume / 2;
          o.orderStatus = 5;
          send(2126, wrap({executionType: 11, order: o, position}));
          return setTimeout(() => send(2132, wrap({errorCode: 'TRADING_BAD_VOLUME'})), 5);
        }
        send(2126, wrap({executionType: 2, order: o}));
        if (state.mode === 'drop-after-fill') return setTimeout(() => ws.close(), 10);
        if (state.mode === 'accepted-only') return;
        return setTimeout(() => send(2126, wrap({executionType: 3, order: o, position, deal: {dealId: 91}})), 5);
      }
      case 2111: {
        state.positions = state.positions.filter((position) => Number(position.positionId) !== p.positionId);
        return send(2126, wrap({executionType: 3, order: {orderId: 82}, deal: {dealId: 92}}));
      }
      case 2175: return send(2176, wrap({order: state.history, hasMore: false}));
      case 2133: return send(2134, wrap({deal: [], hasMore: false}));
      case 2173: return send(2174, {accessToken: 'fixture-renewed', refreshToken: 'fixture-new-refresh', expiresIn: 3600, tokenType: 'bearer'});
      default: throw new Error(`Unexpected fixture message ${m.payloadType}`);
    }
  }));
  await new Promise((r) => brokerHttp.listen(0, '127.0.0.1', r));
  const factory = () => new DemoClient({socketFactory: () => new WebSocket(`ws://127.0.0.1:${brokerHttp.address().port}`), timeoutMs: 200, connectTimeoutMs: 500});
  const store = options.store || new MemoryStore();
  const session = (c, action, opts) => withDemo(c, action, {...opts, factory});
  const service = new TradingService({...cfg, ...options.cfg}, {store, session});
  const api = createServer({...cfg, ...options.cfg}, service);
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => brokerHttp.close(r));
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
  });
  const call = async (path, {method = 'GET', body, key, read = false, headers = {}} = {}) => {
    const r = await fetch(base + path, {method, headers: {authorization: `Bearer ${read ? cfg.API_KEY : cfg.tradingKey}`,
      ...(body === undefined ? {} : {'content-type': 'application/json'}), ...(key ? {'idempotency-key': key} : {}), ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: r.status, data: await r.json()};
  };
  return {state, factory, store, service, call, base};
}
