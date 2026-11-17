import {createHash} from 'node:crypto';
import {DemoClient, authenticateDemo} from './ctrader.js';
import {requireValue} from './errors.js';

const reads = new Set([2121, 2124, 2114, 2116, 2112, 2133, 2175, 2137, 2139, 2187]);
const identity = (tokens) => createHash('sha256').update(JSON.stringify([tokens.accessToken, tokens.refreshToken, tokens.expiresAt ?? null])).digest('hex');

// One process-local, read-only session for one configured demo account. Tokens
// are checked under the existing account lock on every use; no store/connection
// from a completed request is retained. Business data is always queried afresh.
export class DemoReadSession {
  constructor(cfg, {factory = () => new DemoClient(), idleMs = 60000, maxAgeMs = 300000, timeoutMs = 80000} = {}) {
    Object.assign(this, {cfg, factory, idleMs, maxAgeMs, timeoutMs});
    this.current = null;
    this.busy = false;
    this.closed = false;
  }

  reset() {
    clearTimeout(this.idleTimer);
    this.current?.client.close();
    this.current = null;
  }

  close() { this.closed = true; this.reset(); }

  async withSession(action, {tokenStore = null} = {}) {
    requireValue(!this.closed, 'BROKER_SESSION_CLOSED', 503);
    requireValue(!this.busy, 'ACCOUNT_BUSY', 429);
    this.busy = true;
    clearTimeout(this.idleTimer);
    const deadline = setTimeout(() => this.current?.client.fail('TOTAL_TIMEOUT'), this.timeoutMs);
    try {
      const tokens = (tokenStore ? await tokenStore.getTokens() : null) || {
        accessToken: this.cfg.CTRADER_ACCESS_TOKEN, refreshToken: this.cfg.CTRADER_REFRESH_TOKEN,
      };
      requireValue(!this.closed, 'BROKER_SESSION_CLOSED', 503);
      const now = Date.now();
      if (!this.current?.session || !this.current.client.connected ||
        this.current.identity !== identity(tokens) || now - this.current.createdAt >= this.maxAgeMs ||
        (tokens.expiresAt && tokens.expiresAt < now + 120000)) {
        this.reset();
        const client = this.factory();
        this.current = {client, createdAt: now};
        const authenticated = await authenticateDemo(this.cfg, client, {tokenStore, tokens});
        requireValue(!this.closed && this.current?.client === client, 'BROKER_SESSION_CLOSED', 503);
        this.current = {...this.current, session: authenticated.session, identity: identity(authenticated.tokens)};
      }
      const session = this.current.session;
      const request = (type, payload) => {
        requireValue(reads.has(type), 'READ_ONLY_SESSION', 403);
        return session.request(type, payload);
      };
      return await action({accountId: session.accountId, permissionScope: session.permissionScope, request,
        client: {quote: (accountId, symbolId) => {
          requireValue(String(accountId) === String(session.accountId), 'ACCOUNT_MISMATCH', 502);
          return session.client.quote(accountId, symbolId);
        }}});
    } catch (error) {
      // Never retry the callback. A failed transport or authentication is replaced
      // only on a later request; trading commands cannot use this session.
      this.reset();
      throw error;
    } finally {
      clearTimeout(deadline);
      this.busy = false;
      if (!this.closed && this.current) {
        this.idleTimer = setTimeout(() => this.reset(), this.idleMs);
        this.idleTimer.unref();
      }
    }
  }
}
