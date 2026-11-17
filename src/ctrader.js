import {randomUUID} from 'node:crypto';
import {ApiError, BrokerRejection, requireValue} from './errors.js';
import {normalizeCandles} from './candles.js';

export const DEMO_URL = 'wss://demo.ctraderapi.com:5036';
const responses = new Map([
  [2100, 2101], [2149, 2150], [2102, 2103], [2121, 2122], [2124, 2125],
  [2114, 2115], [2116, 2117], [2112, 2113], [2133, 2134], [2175, 2176],
  [2139, 2140], [2187, 2188], [2127, 2128], [2129, 2130], [2137, 2138], [2173, 2174],
  [2106, 2126], [2111, 2126],
]);
const isEnum = (value, name, number) => value === name || value === number;
export {isEnum};

function freshQuote(q) {
  const fresh = (ts) => Number.isFinite(ts) && Date.now() - ts >= -2000 && Date.now() - ts <= 10000;
  return q && fresh(q.bidTimestamp) && fresh(q.askTimestamp) && q.bid > 0 && q.ask >= q.bid;
}

function accountSession(client, accountId, permissionScope) {
  const request = async (type, payload = {}) => {
    const result = await client.request(type, {ctidTraderAccountId: accountId, ...payload});
    requireValue(String(result.ctidTraderAccountId) === String(accountId), 'ACCOUNT_MISMATCH', 502);
    return result;
  };
  return {client, request, accountId, permissionScope};
}

export function selectDemo(accounts, login) {
  requireValue(Array.isArray(accounts), 'INVALID_ACCOUNTS', 502);
  const matches = accounts.filter((a) => String(a.traderLogin) === login);
  requireValue(matches.length === 1 && matches[0].isLive === false, 'DEMO_ACCOUNT_NOT_VERIFIED', 502);
  const id = Number(matches[0].ctidTraderAccountId);
  requireValue(Number.isSafeInteger(id) && id > 0, 'INVALID_ACCOUNT_ID', 502);
  return id;
}

export class DemoClient {
  constructor({socketFactory = (url) => new WebSocket(url), timeoutMs = 15000, connectTimeoutMs = 10000} = {}) {
    this.socketFactory = socketFactory;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.pending = new Map();
    this.quotes = new Map();
    this.quoteSymbol = null;
    this.failed = false;
  }

  get connected() { return !this.failed && this.ws?.readyState === 1; }

  async connect() {
    this.ws = this.socketFactory(DEMO_URL);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (event) => this.receive(event.data));
    this.ws.addEventListener('error', () => this.fail('CONNECTION_FAILED'));
    this.ws.addEventListener('close', () => this.fail('CONNECTION_CLOSED'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail('CONNECT_TIMEOUT'); reject(new ApiError('CONNECT_TIMEOUT', 502)); }, this.connectTimeoutMs);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      for (const event of ['error', 'close']) this.ws.addEventListener(event, () => {
        clearTimeout(timer); reject(new ApiError('CONNECTION_FAILED', 502));
      }, {once: true});
    });
    this.heartbeat = setInterval(() => {
      try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({payloadType: 51, payload: {}})); }
      catch { this.fail('SEND_FAILED'); }
    }, 8000);
    this.heartbeat.unref();
  }

  receive(raw) {
    if (raw instanceof ArrayBuffer) {
      if (raw.byteLength > 2 * 1024 * 1024) return this.fail('INVALID_RESPONSE');
      try { raw = new TextDecoder('utf-8', {fatal: true}).decode(raw); }
      catch { return this.fail('INVALID_RESPONSE'); }
    }
    if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return this.fail('INVALID_RESPONSE');
    let message;
    try { message = JSON.parse(raw); } catch { return this.fail('INVALID_RESPONSE'); }
    if (!message || typeof message !== 'object') return this.fail('INVALID_RESPONSE');
    if ([2147, 2148, 2164].includes(message.payloadType)) return this.fail('SESSION_DISCONNECTED');
    if (message.payloadType === 2131) {
      const p = message.payload;
      if (p && String(p.ctidTraderAccountId) === String(this.accountId) && Number(p.symbolId) === this.quoteSymbol) {
        const key = String(p.symbolId);
        // Bid and ask may arrive in separate events. Keep their individual timestamps.
        const prior = this.quotes.get(key) || {};
        const q = {...prior, symbolId: p.symbolId};
        for (const side of ['bid', 'ask']) if (p[side] !== undefined) {
          q[side] = Number(p[side]) / 100000;
          q[`${side}Timestamp`] = Number(p.timestamp);
        }
        this.quotes.set(key, q);
        this.quoteSignal?.();
      }
      return;
    }
    const pending = this.pending.get(message.clientMsgId);
    if (!pending) return;
    // Empty protobuf messages are encoded without a payload by the JSON proxy.
    const p = message.payload ?? (message.payloadType === 2101 ? {} : null);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return this.fail('INVALID_RESPONSE');
    if (pending.accountId && p.ctidTraderAccountId !== undefined && String(p.ctidTraderAccountId) !== String(pending.accountId)) return this.fail('ACCOUNT_MISMATCH');
    if ([2142, 2132, 50].includes(message.payloadType)) {
      this.pending.delete(message.clientMsgId);
      clearTimeout(pending.timer);
      pending.reject(pending.sawPartial ? new ApiError('PARTIAL_EXECUTION_NOT_RECONCILED', 502)
        : new BrokerRejection(['OA_AUTH_TOKEN_EXPIRED', 'CH_ACCESS_TOKEN_INVALID'].includes(p.errorCode), pending.command));
      return;
    }
    if (message.payloadType !== pending.expected) return this.fail('INVALID_RESPONSE');
    if (pending.accountId && String(p.ctidTraderAccountId) !== String(pending.accountId)) return this.fail('ACCOUNT_MISMATCH');
    if (pending.command) {
      if (isEnum(p.executionType, 'ORDER_PARTIAL_FILL', 11)) { pending.sawPartial = true; return; }
      if (isEnum(p.executionType, 'ORDER_ACCEPTED', 2)) return;
      if (isEnum(p.executionType, 'ORDER_REJECTED', 7)) {
        this.pending.delete(message.clientMsgId);
        clearTimeout(pending.timer);
        pending.reject(pending.sawPartial ? new ApiError('PARTIAL_EXECUTION_NOT_RECONCILED', 502) : new BrokerRejection());
        return;
      }
      if (!isEnum(p.executionType, 'ORDER_FILLED', 3)) return;
    }
    this.pending.delete(message.clientMsgId);
    clearTimeout(pending.timer);
    pending.resolve(p);
  }

  request(type, payload) {
    if (!responses.has(type)) return Promise.reject(new ApiError('MESSAGE_NOT_ALLOWED', 400));
    if (!this.connected) return Promise.reject(new ApiError('NOT_CONNECTED', 502));
    const clientMsgId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('BROKER_TIMEOUT'), this.timeoutMs);
      this.pending.set(clientMsgId, {resolve, reject, timer, expected: responses.get(type),
        accountId: payload.ctidTraderAccountId, command: [2106, 2111].includes(type)});
      try { this.ws.send(JSON.stringify({clientMsgId, payloadType: type, payload})); }
      catch { this.fail('SEND_FAILED'); }
    });
  }

  async quote(accountId, symbolId) {
    const cached = this.quotes.get(String(symbolId));
    if (this.connected && this.quoteSymbol === symbolId && freshQuote(cached)) return {...cached, timestamp: Math.min(cached.bidTimestamp, cached.askTimestamp)};
    // Keep at most one live subscription. Refresh a stale subscription to obtain
    // a new two-sided snapshot, rather than weakening the freshness requirement.
    const previous = this.quoteSymbol;
    this.quoteSymbol = null;
    this.quotes.clear();
    if (previous !== null) await this.request(2129, {ctidTraderAccountId: accountId, symbolId: [previous]});
    this.quoteSymbol = symbolId;
    await this.request(2127, {ctidTraderAccountId: accountId, symbolId: [symbolId], subscribeToSpotTimestamp: true});
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.quoteSignal = null; this.quoteReject = null; };
      const check = () => {
        const q = this.quotes.get(String(symbolId));
        if (freshQuote(q)) {
          cleanup(); resolve({...q, timestamp: Math.min(q.bidTimestamp, q.askTimestamp)});
        }
      };
      const timer = setTimeout(() => { cleanup(); reject(new ApiError('FRESH_QUOTE_UNAVAILABLE', 502)); }, this.timeoutMs);
      this.quoteSignal = check;
      this.quoteReject = () => { cleanup(); reject(new ApiError('CONNECTION_CLOSED', 502)); };
      check();
    });
  }

  fail(code) {
    this.failed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ApiError(code, 502)); }
    this.pending.clear();
    this.quoteReject?.();
    this.quoteSymbol = null;
    this.quotes.clear();
    clearInterval(this.heartbeat);
    try { this.ws?.close(); } catch { /* Already closed. */ }
  }
  close() { this.fail('CLIENT_CLOSED'); }
}

export async function authenticateDemo(cfg, client, {tokenStore = null, tokens = null} = {}) {
  await client.connect();
  await client.request(2100, {clientId: cfg.CTRADER_CLIENT_ID, clientSecret: cfg.CTRADER_CLIENT_SECRET});
  tokens ||= tokenStore ? await tokenStore.getTokens() : null;
  tokens ||= {accessToken: cfg.CTRADER_ACCESS_TOKEN, refreshToken: cfg.CTRADER_REFRESH_TOKEN};
  // Refresh authentication only, never retry a trading command. Bootstrap
  // tokens have no trusted expiry until the broker issues their replacement.
  const renew = async () => {
    requireValue(tokenStore && tokens.refreshToken, 'TOKEN_RENEWAL_REQUIRED', 502);
    const refreshed = await client.request(2173, {refreshToken: tokens.refreshToken});
    requireValue(typeof refreshed.accessToken === 'string' && typeof refreshed.refreshToken === 'string' && Number(refreshed.expiresIn) > 0, 'INVALID_TOKEN_RESPONSE', 502);
    tokens = {accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + Number(refreshed.expiresIn) * 1000};
    await tokenStore.setTokens(tokens);
  };
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 120000) await renew();
  let list;
  try { list = await client.request(2149, {accessToken: tokens.accessToken}); }
  catch (error) {
    if (!(error instanceof BrokerRejection) || !error.tokenInvalid || !tokenStore || !tokens.refreshToken) throw error;
    await renew();
    list = await client.request(2149, {accessToken: tokens.accessToken});
  }
  const accountId = selectDemo(list.ctidTraderAccount, cfg.login);
  client.accountId = accountId;
  await client.request(2102, {ctidTraderAccountId: accountId, accessToken: tokens.accessToken});
  return {session: accountSession(client, accountId, list.permissionScope), tokens};
}

export async function withDemo(cfg, action, {factory = () => new DemoClient(), tokenStore = null} = {}) {
  const client = factory();
  const deadline = setTimeout(() => client.fail('TOTAL_TIMEOUT'), 80000);
  try {
    const {session} = await authenticateDemo(cfg, client, {tokenStore});
    return await action(session);
  } finally { clearTimeout(deadline); client.close(); }
}

export async function querySession(cfg, session, kind, args = {}) {
  const {request, client, accountId} = session;
  const meta = {environment: 'demo', accountLogin: cfg.login, accountId};
  if (kind === 'account') {
    const [{trader}, assets, pnl] = await Promise.all([request(2121), request(2112), request(2187)]);
    requireValue(trader && String(trader.ctidTraderAccountId) === String(accountId), 'INVALID_TRADER', 502);
    const digits = trader.moneyDigits ?? 2;
    const currency = (assets.asset || []).find((a) => String(a.assetId) === String(trader.depositAssetId));
    return {...meta, balanceRaw: trader.balance, moneyDigits: digits, depositAssetId: trader.depositAssetId,
      currency: currency?.name, broker: trader.brokerName, trader,
      unrealizedPnl: pnl.positionUnrealizedPnL || [], pnlMoneyDigits: pnl.moneyDigits};
  }
  if (kind === 'positions' || kind === 'orders') {
    const r = await request(2124);
    return {...meta, ...(kind === 'positions' ? {positions: r.position || []} : {}), orders: r.order || []};
  }
  if (kind === 'symbols') return {...meta, symbols: (await request(2114, {includeArchivedSymbols: false})).symbol || []};
  if (kind === 'symbol') return {...meta, symbols: (await request(2116, {symbolId: [args.symbolId]})).symbol || []};
  if (kind === 'quote') return {...meta, quote: await client.quote(accountId, args.symbolId)};
  if (kind === 'candles') {
    const {symbolId, periodId, fromTimestamp, toTimestamp, count} = args;
    const response = await request(2137, {symbolId, period: periodId, fromTimestamp, toTimestamp, count});
    return {...meta, ...normalizeCandles(response, args)};
  }
  if (kind === 'deals') {
    const r = await request(2133, args);
    return {...meta, deals: r.deal || [], hasMore: r.hasMore, range: args};
  }
  if (kind === 'order-history') {
    const r = await request(2175, args);
    return {...meta, orders: r.order || [], hasMore: r.hasMore, range: args};
  }
  throw new ApiError('INVALID_QUERY', 400);
}

export async function queryDemo(cfg, kind = 'account', factory = () => new DemoClient(), args = {}) {
  return withDemo(cfg, (session) => querySession(cfg, session, kind, args), {factory});
}
