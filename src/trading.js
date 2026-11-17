import {createHash, randomUUID} from 'node:crypto';
import {ApiError, BrokerRejection, requireValue} from './errors.js';
import {withDemo, querySession, isEnum} from './ctrader.js';
import {fixed, orderBody} from './validation.js';

const safeInteger = (value) => Number.isSafeInteger(Number(value));
const publicOperation = (op) => ({operationId: op.id, kind: op.kind, status: op.status,
  createdAt: op.createdAt, updatedAt: op.updatedAt, result: op.result});
const uncertain = (op) => ['reserved', 'sent', 'uncertain'].includes(op.status);

function protectionsMatch(position, side, preview) {
  if (!preview || !Number.isFinite(Number(position.price)) || Number(position.price) <= 0 ||
    !isEnum(position.tradeData?.tradeSide, side, side === 'BUY' ? 1 : 2)) return false;
  const direction = side === 'BUY' ? 1 : -1;
  const expectedStop = Number(position.price) - direction * preview.relativeStopLoss / 100000;
  const expectedTarget = Number(position.price) + direction * preview.relativeTakeProfit / 100000;
  const tolerance = (preview.priceStep || 1 / 100000) + 1e-10;
  return Number(position.stopLoss) > 0 && Number(position.takeProfit) > 0 &&
    Math.abs(Number(position.stopLoss) - expectedStop) <= tolerance &&
    Math.abs(Number(position.takeProfit) - expectedTarget) <= tolerance;
}

export function fingerprint(kind, body) {
  const canonical = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({kind, body: canonical})).digest('hex');
}

function money(raw, digits) {
  requireValue(safeInteger(raw) && Number.isInteger(digits) && digits >= 0 && digits <= 8, 'INVALID_MONEY_RESPONSE', 502);
  return Number(raw) / 10 ** digits;
}

function marketIsOpen(symbol, now) {
  requireValue(Array.isArray(symbol.schedule) && symbol.schedule.length && symbol.scheduleTimeZone, 'MARKET_SCHEDULE_UNAVAILABLE');
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: symbol.scheduleTimeZone,
      weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(now).map((p) => [p.type, p.value]));
  } catch { throw new ApiError('MARKET_SCHEDULE_UNAVAILABLE'); }
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const second = day * 86400 + Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  requireValue(symbol.schedule.some((s) => Number(s.startSecond) <= second && second < Number(s.endSecond)), 'MARKET_CLOSED');
  // Holiday calendars can contain irregular sessions. Reject the entire matching
  // holiday rather than inventing opening times; closing remains possible.
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: symbol.scheduleTimeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  const annual = date.slice(5);
  for (const holiday of symbol.holiday || []) {
    const d = new Date(Number(holiday.holidayDate) * 86400000).toISOString().slice(0, 10);
    requireValue(holiday.isRecurring ? annual !== d.slice(5) : date !== d, 'MARKET_HOLIDAY');
  }
}

export async function previewOrder(cfg, session, body, now = new Date()) {
  orderBody(body);
  requireValue(cfg.symbols.includes(body.symbol), 'SYMBOL_NOT_ALLOWED');
  requireValue(isEnum(session.permissionScope, 'SCOPE_TRADE', 1), 'TOKEN_HAS_NO_TRADING_PERMISSION', 403);
  const {trader} = await session.request(2121);
  requireValue(trader && String(trader.ctidTraderAccountId) === String(session.accountId), 'ACCOUNT_MISMATCH', 502);
  requireValue(isEnum(trader.accessRights ?? 0, 'FULL_ACCESS', 0), 'ACCOUNT_TRADING_NOT_ALLOWED');
  requireValue(isEnum(trader.accountType ?? 0, 'HEDGED', 0) && !trader.isLimitedRisk, 'ACCOUNT_TYPE_NOT_SUPPORTED');
  const symbols = (await session.request(2114, {includeArchivedSymbols: false})).symbol || [];
  const matches = symbols.filter((s) => s.symbolName === body.symbol && s.enabled === true);
  requireValue(matches.length === 1 && safeInteger(matches[0].symbolId), 'SYMBOL_NOT_AVAILABLE');
  const symbolId = Number(matches[0].symbolId);
  const details = (await session.request(2116, {symbolId: [symbolId]})).symbol || [];
  const symbol = details.find((s) => Number(s.symbolId) === symbolId);
  requireValue(symbol && isEnum(symbol.tradingMode ?? 0, 'ENABLED', 0), 'SYMBOL_TRADING_DISABLED');
  requireValue(body.side !== 'SELL' || symbol.enableShortSelling === true, 'SHORT_SELLING_NOT_ALLOWED');
  marketIsOpen(symbol, now);
  const volume = fixed(body.volume, 2);
  requireValue(['minVolume', 'maxVolume', 'stepVolume'].every((k) => safeInteger(symbol[k]) && Number(symbol[k]) > 0), 'INVALID_SYMBOL_LIMITS', 502);
  requireValue(volume >= Number(symbol.minVolume) && volume <= Number(symbol.maxVolume) && volume % Number(symbol.stepVolume) === 0, 'INVALID_SYMBOL_VOLUME');
  requireValue(volume <= cfg.maxVolume, 'MAX_VOLUME_EXCEEDED');
  requireValue(fixed(body.stopLossPips, 2) <= cfg.maxStopPips * 100, 'MAX_STOP_LOSS_EXCEEDED');
  requireValue(Number.isInteger(symbol.pipPosition) && symbol.pipPosition >= 0 && symbol.pipPosition <= 5 && Number.isInteger(symbol.digits) && symbol.digits >= 0 && symbol.digits <= 5, 'UNSUPPORTED_SYMBOL_PRECISION');
  const relative = (value) => {
    const raw = fixed(value, 2) * 10 ** (5 - symbol.pipPosition) / 100;
    requireValue(Number.isSafeInteger(raw) && raw > 0 && raw % (10 ** (5 - symbol.digits)) === 0, 'INVALID_PROTECTION_PRECISION');
    return raw;
  };
  const relativeStopLoss = relative(body.stopLossPips);
  const relativeTakeProfit = relative(body.takeProfitPips);
  const state = await session.request(2124);
  requireValue((state.order || []).length === 0, 'PENDING_ORDERS_BLOCK_ENTRY');
  requireValue((state.position || []).length < cfg.maxPositions, 'MAX_POSITIONS_REACHED');
  const pnl = await session.request(2187);
  const expected = await session.request(2139, {symbolId, volume: [volume]});
  const margin = (expected.margin || []).find((m) => Number(m.volume) === volume);
  requireValue(margin, 'MARGIN_UNAVAILABLE', 502);
  const requiredMargin = money(body.side === 'BUY' ? margin.buyMargin : margin.sellMargin, expected.moneyDigits ?? 2);
  requireValue(requiredMargin > 0, 'MARGIN_UNAVAILABLE', 502);
  const netPnl = (pnl.positionUnrealizedPnL || []).reduce((sum, p) => sum + money(p.netUnrealizedPnL, pnl.moneyDigits), 0);
  const usedMargin = (state.position || []).reduce((sum, p) => sum + money(p.usedMargin, p.moneyDigits ?? 2), 0);
  const freeMargin = money(trader.balance, trader.moneyDigits ?? 2) + netPnl - usedMargin;
  requireValue(requiredMargin <= freeMargin * (1 - cfg.marginReservePercent / 100), 'INSUFFICIENT_FREE_MARGIN');
  // Quote is obtained last: validations and DB writes must not consume its age.
  const quote = await session.client.quote(session.accountId, symbolId);
  const spreadPips = (quote.ask - quote.bid) * 10 ** symbol.pipPosition;
  requireValue(spreadPips <= cfg.maxSpreadPips + 1e-8, 'SPREAD_TOO_HIGH');
  const entry = body.side === 'BUY' ? quote.ask : quote.bid;
  for (const [rawDistance, minimum] of [[relativeStopLoss, symbol.slDistance], [relativeTakeProfit, symbol.tpDistance]]) {
    requireValue(safeInteger(minimum ?? 0), 'INVALID_SYMBOL_LIMITS', 502);
    const minPrice = isEnum(symbol.distanceSetIn ?? 1, 'SYMBOL_DISTANCE_IN_POINTS', 1)
      ? Number(minimum || 0) * 10 ** -symbol.digits
      : isEnum(symbol.distanceSetIn, 'SYMBOL_DISTANCE_IN_PERCENTAGE', 2) ? entry * Number(minimum || 0) / 100 : NaN;
    // SL is checked against the closing side of the spread, conservatively.
    requireValue(rawDistance / 100000 >= minPrice + (quote.ask - quote.bid), 'PROTECTION_TOO_CLOSE');
  }
  requireValue(entry - relativeStopLoss / 100000 > 0 && entry - relativeTakeProfit / 100000 > 0, 'INVALID_PROTECTION_PRICE');
  return {symbolId, volume, relativeStopLoss, relativeTakeProfit, quote, spreadPips, requiredMargin, freeMargin,
    priceStep: 10 ** -symbol.digits, marginReservePercent: cfg.marginReservePercent, estimatedAt: Date.now(), moneyCurrencyAssetId: trader.depositAssetId};
}

export class TradingService {
  constructor(cfg, {store = null, session = withDemo} = {}) { this.cfg = cfg; this.store = store; this.session = session; }

  async handle(kind, args = {}, body = null, key = null) {
    const action = async (store) => {
      const session = (fn) => this.session(this.cfg, fn, {tokenStore: store});
      if (kind === 'operations') return {data: {operations: (await store.list(args.limit)).map(publicOperation)}};
      if (kind === 'operation') {
        const op = await store.get(args.id);
        requireValue(op, 'OPERATION_NOT_FOUND', 404);
        return {data: publicOperation(op)};
      }
      if (kind === 'open' || kind === 'close') return this.execute(store, session, kind, args, body, key);
      if (kind === 'reconcile') return this.reconcile(store, session, args.id);
      return session(async (s) => {
        if (kind === 'ready') {
          if (store) await store.check();
          const result = await querySession(this.cfg, s, 'positions');
          return {data: {status: 'ready', environment: 'demo', accountId: result.accountId,
            brokerConnection: 'verified', persistence: store ? 'verified' : 'not_configured',
            tradingEnabled: this.cfg.tradingEnabled, tokenTradingPermission: isEnum(s.permissionScope, 'SCOPE_TRADE', 1)}};
        }
        if (kind === 'preview') return {data: await previewOrder(this.cfg, s, body)};
        return {data: await querySession(this.cfg, s, kind, args)};
      });
    };
    const needsStore = ['open', 'close', 'reconcile', 'operations', 'operation'].includes(kind);
    requireValue(!needsStore || this.store, 'PERSISTENCE_REQUIRED', 503);
    if (['open', 'close'].includes(kind)) requireValue(this.cfg.tradingEnabled, 'TRADING_DISABLED', 403);
    if (this.store) return this.store.withLock(action);
    return action(null);
  }

  async execute(store, session, kind, args, body, key) {
    requireValue(typeof key === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', 400);
    const commandBody = kind === 'close' ? {positionId: args.positionId} : body;
    const fp = fingerprint(kind, commandBody);
    const existing = await store.findByKey(key);
    if (existing) {
      requireValue(existing.fingerprint === fp, 'IDEMPOTENCY_CONFLICT', 409);
      return {httpStatus: uncertain(existing) ? 202 : existing.status === 'rejected' ? 422 : 200, data: publicOperation(existing)};
    }
    const pending = await store.unresolved();
    requireValue(kind !== 'open' || pending.length === 0, 'UNRESOLVED_OPERATION_BLOCKS_ENTRY', 409);
    requireValue(kind !== 'close' || !pending.some((p) => p.kind === 'close' && p.body.positionId === args.positionId), 'POSITION_CLOSE_UNRESOLVED', 409);
    const op = {id: randomUUID(), key, fingerprint: fp, kind, body: commandBody, status: 'reserved', createdAt: Date.now()};
    await store.insert(op);
    let sent = false;
    let filled = false;
    let evidence = null;
    try {
      const result = await session(async (s) => {
        requireValue(isEnum(s.permissionScope, 'SCOPE_TRADE', 1), 'TOKEN_HAS_NO_TRADING_PERMISSION', 403);
        let payload;
        if (kind === 'open') {
          const preview = await previewOrder(this.cfg, s, body);
          payload = {symbolId: preview.symbolId, volume: preview.volume, orderType: 1,
            tradeSide: body.side === 'BUY' ? 1 : 2, relativeStopLoss: preview.relativeStopLoss,
            relativeTakeProfit: preview.relativeTakeProfit, label: this.cfg.label, clientOrderId: op.id};
          evidence = {preview};
        } else {
          const state = await s.request(2124);
          const position = (state.position || []).find((p) => String(p.positionId) === String(args.positionId));
          requireValue(position && position.tradeData?.label === this.cfg.label, 'OWN_POSITION_NOT_FOUND', 404);
          requireValue(safeInteger(position.tradeData.volume) && Number(position.tradeData.volume) > 0, 'INVALID_POSITION_VOLUME', 502);
          payload = {positionId: args.positionId, volume: Number(position.tradeData.volume)};
          evidence = {positionId: args.positionId, requestedVolume: payload.volume};
        }
        // The durable marker precedes the socket write. A process crash at any
        // point after this commit blocks resubmission, including from another host.
        await store.update(op.id, 'sent', evidence);
        sent = true;
        if (kind === 'open') requireValue(Date.now() - evidence.preview.quote.timestamp <= 10000, 'QUOTE_EXPIRED');
        const event = await s.request(kind === 'open' ? 2106 : 2111, payload);
        filled = true;
        const positionId = kind === 'open' ? event.position?.positionId ?? event.order?.positionId : args.positionId;
        requireValue(positionId && safeInteger(positionId), 'EXECUTION_WITHOUT_POSITION', 502);
        evidence = {...evidence, positionId, orderId: event.order?.orderId, dealId: event.deal?.dealId};
        const state = await s.request(2124);
        const position = (state.position || []).find((p) => String(p.positionId) === String(positionId));
        if (kind === 'open') {
          requireValue(position && position.tradeData?.label === this.cfg.label && Number(position.tradeData.symbolId) === payload.symbolId && Number(position.tradeData.volume) === payload.volume,
            'POSITION_NOT_VERIFIED', 502);
          requireValue(protectionsMatch(position, body.side, evidence.preview), 'PROTECTIONS_NOT_VERIFIED', 502);
          const buy = body.side === 'BUY';
          requireValue(buy ? position.stopLoss < position.price && position.takeProfit > position.price : position.stopLoss > position.price && position.takeProfit < position.price,
            'PROTECTIONS_NOT_VERIFIED', 502);
          return {...evidence, position, verified: true};
        }
        requireValue(!position, 'POSITION_CLOSE_NOT_VERIFIED', 502);
        return {...evidence, positionClosed: true, verified: true};
      });
      const saved = await store.update(op.id, 'completed', result);
      return {httpStatus: 201, data: publicOperation(saved)};
    } catch (error) {
      const definite = !sent || (!filled && error instanceof BrokerRejection);
      const status = definite ? 'rejected' : 'uncertain';
      const code = error instanceof ApiError ? error.code : 'EXECUTION_NOT_VERIFIED';
      const saved = await store.update(op.id, status, {...evidence, error: code});
      return {httpStatus: definite ? (error instanceof ApiError ? error.status : 502) : 202, data: publicOperation(saved)};
    }
  }

  async reconcile(store, session, id) {
    const op = await store.get(id);
    requireValue(op, 'OPERATION_NOT_FOUND', 404);
    if (!uncertain(op)) return {data: publicOperation(op)};
    // No resubmission. Missing history is never proof that a timed-out order failed.
    const resolution = await session(async (s) => {
      const state = await s.request(2124);
      if (op.kind === 'close') {
        const present = (state.position || []).some((p) => String(p.positionId) === String(op.body.positionId));
        return present ? null : {positionId: op.body.positionId, positionClosed: true, reconciled: true,
          attribution: 'Position is closed; this does not attribute the closing deal to this request.'};
      }
      requireValue(Date.now() - op.createdAt <= 7 * 86400000, 'RECONCILIATION_REQUIRES_MANUAL_HISTORY', 409);
      const history = await s.request(2175, {fromTimestamp: Math.max(0, op.createdAt - 60000), toTimestamp: Date.now()});
      const matches = [...(history.order || []), ...(state.order || [])].filter((o) => o.clientOrderId === op.id);
      const unique = [...new Map(matches.map((o) => [String(o.orderId), o])).values()];
      if (unique.length !== 1) return null;
      const order = unique[0];
      if (isEnum(order.orderStatus, 'ORDER_STATUS_REJECTED', 3) && Number(order.executedVolume || 0) === 0) return {rejected: true, orderId: order.orderId, reconciled: true};
      if (!isEnum(order.orderStatus, 'ORDER_STATUS_FILLED', 2)) return null;
      if (!safeInteger(order.positionId) || Number(order.positionId) <= 0 || order.tradeData?.label !== this.cfg.label || Number(order.executedVolume) !== fixed(op.body.volume, 2)) return null;
      const position = (state.position || []).find((p) => String(p.positionId) === String(order.positionId));
      if (position && (position.tradeData?.label !== this.cfg.label || !protectionsMatch(position, op.body.side, op.result?.preview))) return null;
      return {orderId: order.orderId, positionId: order.positionId, position: position || null,
        positionClosed: !position, reconciled: true, verified: true};
    });
    if (!resolution) return {httpStatus: 202, data: publicOperation(op)};
    const saved = await store.update(id, resolution.rejected ? 'rejected' : 'completed', resolution);
    return {data: publicOperation(saved)};
  }
}
