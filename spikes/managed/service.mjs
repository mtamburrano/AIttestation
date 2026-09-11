import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, hash, b64, keys } from '../vault/format.mjs';
import { MANAGED_PROFILE, MANAGED_NETWORK, FEE_MICROALGOS, TOKEN_PATTERN, TRANSACTION_PATTERN,
  managedError, validateAnchorRequest } from './protocol.mjs';

export const DEFAULT_LIMITS = Object.freeze({ accounts: 1000, ledger: 100000,
  accountMonth: 1000, accountDay: 100, globalDay: 10000, accountMinute: 20, globalMinute: 600 });
const tokenHash = token => b64(hash('PAP/managed-account/v1\0', token));

/** One durable ledger owns reservations, including failed/ambiguous submissions. */
export class ManagedSponsorship {
  #db; #sponsor; #now; #limits; #running = new Set();
  constructor(directory, { sponsor, limits = DEFAULT_LIMITS, now = Date.now } = {}) {
    if (!isAbsolute(directory) || typeof sponsor?.prepare !== 'function' || typeof sponsor?.broadcast !== 'function') {
      throw Error('Explicit service storage and sponsor required');
    }
    keys(limits, Object.keys(DEFAULT_LIMITS));
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name]) throw Error('Invalid sponsorship limit');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw Error('Service directory must be owner-only');
    this.#sponsor = sponsor; this.#now = now; this.#limits = { ...limits };
    this.#db = new DatabaseSync(join(directory, 'sponsorship.sqlite'));
    try {
      chmodSync(join(directory, 'sponsorship.sqlite'), 0o600);
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meter (id INTEGER PRIMARY KEY CHECK(id=1), time INTEGER NOT NULL, minute INTEGER NOT NULL, hits INTEGER NOT NULL);
        INSERT OR IGNORE INTO meter VALUES (1,0,0,0);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
          paid_through INTEGER NOT NULL, minute INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS anchors (account TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL,
          month TEXT NOT NULL, day TEXT NOT NULL, prepared TEXT, broadcasts INTEGER NOT NULL DEFAULT 0,
          last_broadcast INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account,payload));
        CREATE INDEX IF NOT EXISTS account_month ON anchors(account,month);
        CREATE INDEX IF NOT EXISTS account_day ON anchors(account,day);
        CREATE INDEX IF NOT EXISTS global_day ON anchors(day);`);
      const config = canonical({ profile: MANAGED_PROFILE, limits });
      this.#db.prepare('INSERT OR IGNORE INTO config VALUES (1,?)').run(config);
      if (this.#db.prepare('SELECT value FROM config').get().value !== config) throw Error('Stored sponsorship policy mismatch');
    } catch (error) { this.#db.close(); throw error; }
  }
  #atomic(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  #time() {
    const time = this.#now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) throw managedError('SERVICE_UNAVAILABLE');
    // A backward clock adjustment cannot reopen an earlier allowance or subscription.
    const bounded = Math.max(time, this.#db.prepare('SELECT time FROM meter').get().time);
    this.#db.prepare('UPDATE meter SET time=? WHERE id=1').run(bounded);
    return bounded;
  }
  #count(where = '', ...args) { return this.#db.prepare(`SELECT count(*) AS n FROM anchors ${where}`).get(...args).n; }
  provision({ paidThrough }) {
    return this.#atomic(() => {
      if (this.#db.prepare('SELECT count(*) AS n FROM accounts').get().n >= this.#limits.accounts) throw Error('Account capacity exhausted');
      this.#expiry(paidThrough);
      const id = randomUUID(), accessCode = b64(randomBytes(32));
      this.#db.prepare('INSERT INTO accounts(id,token_hash,paid_through) VALUES (?,?,?)').run(id, tokenHash(accessCode), paidThrough);
      return { accountId: id, accessCode, paidThrough };
    });
  }
  #expiry(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw Error('Invalid subscription expiry'); }
  setSubscription(accountId, paidThrough) {
    this.#expiry(paidThrough);
    if (this.#db.prepare('UPDATE accounts SET paid_through=? WHERE id=?').run(paidThrough, accountId).changes !== 1) throw Error('Unknown account');
  }
  rotateAccessCode(accountId) {
    const accessCode = b64(randomBytes(32));
    if (this.#db.prepare('UPDATE accounts SET token_hash=? WHERE id=?').run(tokenHash(accessCode), accountId).changes !== 1) throw Error('Unknown account');
    return { accountId, accessCode };
  }
  #authenticate(token) {
    const result = this.#atomic(() => {
      const time = this.#time(), minute = Math.floor(time / 60000), meter = this.#db.prepare('SELECT * FROM meter').get();
      const hits = meter.minute === minute ? meter.hits + 1 : 1;
      this.#db.prepare('UPDATE meter SET minute=?,hits=? WHERE id=1').run(minute, Math.min(hits, this.#limits.globalMinute + 1));
      if (hits > this.#limits.globalMinute) return { error: 'RATE_LIMITED' };
      const account = TOKEN_PATTERN.test(token ?? '') ? this.#db.prepare('SELECT * FROM accounts WHERE token_hash=?').get(tokenHash(token)) : null;
      if (!account) return { error: 'ACCOUNT_REQUIRED' };
      const requests = account.minute === minute ? account.hits + 1 : 1;
      this.#db.prepare('UPDATE accounts SET minute=?,hits=? WHERE id=?').run(minute, Math.min(requests, this.#limits.accountMinute + 1), account.id);
      return requests > this.#limits.accountMinute ? { error: 'RATE_LIMITED' } : { account, time };
    });
    if (result.error) throw managedError(result.error);
    return result;
  }
  account(token) {
    const { account, time } = this.#authenticate(token), month = new Date(time).toISOString().slice(0, 7);
    return { profile: MANAGED_PROFILE, accountId: account.id, state: account.paid_through > time ? 'ACTIVE' : 'UNPAID',
      paidThrough: account.paid_through, month, remaining: Math.max(0, this.#limits.accountMonth - this.#count('WHERE account=? AND month=?', account.id, month)) };
  }
  async anchor(token, request) {
    const { account } = this.#authenticate(token);
    validateAnchorRequest(request);
    const payload = request.payload, key = `${account.id}:${payload}`;
    const reservation = this.#atomic(() => {
      const time = this.#time(), existing = this.#db.prepare('SELECT * FROM anchors WHERE account=? AND payload=?').get(account.id, payload);
      if (existing) return { row: existing, fresh: false };
      const current = this.#db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);
      if (current.paid_through <= time) throw managedError('UNPAID');
      const date = new Date(time).toISOString(), month = date.slice(0, 7), day = date.slice(0, 10);
      if (this.#count('WHERE account=? AND month=?', account.id, month) >= this.#limits.accountMonth
          || this.#count('WHERE account=? AND day=?', account.id, day) >= this.#limits.accountDay) throw managedError('QUOTA_EXHAUSTED');
      if (this.#count() >= this.#limits.ledger || this.#count('WHERE day=?', day) >= this.#limits.globalDay) throw managedError('SERVICE_UNAVAILABLE');
      this.#db.prepare('INSERT INTO anchors(account,payload,created,month,day) VALUES (?,?,?,?,?)').run(account.id, payload, time, month, day);
      return { row: { prepared: null }, fresh: true };
    });
    if (this.#running.has(key)) throw managedError('SERVICE_UNAVAILABLE');
    this.#running.add(key);
    try {
      let prepared;
      if (reservation.fresh) {
        // Preparation signs but cannot submit. Persist the exact signed bytes before any broadcast.
        prepared = await this.#sponsor.prepare(payload);
        keys(prepared, ['transactionId', 'signedTransaction', 'feeMicroAlgos', 'network']);
        if (!TRANSACTION_PATTERN.test(prepared.transactionId) || prepared.network !== MANAGED_NETWORK
            || prepared.feeMicroAlgos !== FEE_MICROALGOS || typeof prepared.signedTransaction !== 'string'
            || prepared.signedTransaction.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(prepared.signedTransaction)) {
          throw managedError('SERVICE_UNAVAILABLE');
        }
        this.#db.prepare('UPDATE anchors SET prepared=? WHERE account=? AND payload=?').run(canonical(prepared), account.id, payload);
      } else {
        if (!reservation.row.prepared) throw managedError('SUBMISSION_INTERRUPTED');
        prepared = JSON.parse(reservation.row.prepared);
      }
      const broadcast = this.#atomic(() => {
        const time = this.#time(), row = this.#db.prepare('SELECT * FROM anchors WHERE account=? AND payload=?').get(account.id, payload);
        if (row.broadcasts >= 3 || (row.broadcasts > 0 && time - row.last_broadcast < 10000)) return false;
        this.#db.prepare('UPDATE anchors SET broadcasts=broadcasts+1,last_broadcast=? WHERE account=? AND payload=?').run(time, account.id, payload);
        return true;
      });
      if (broadcast) {
        try { await this.#sponsor.broadcast(prepared); } catch { /* Ambiguous RPC success still has the same durable transaction ID. */ }
      }
      return { profile: MANAGED_PROFILE, network: MANAGED_NETWORK, payload, transactionId: prepared.transactionId,
        state: 'SUBMITTED_OR_UNKNOWN' };
    } catch (error) { throw managedError(error.code); }
    finally { this.#running.delete(key); }
  }
  close() { if (this.#running.size) throw Error('Drain sponsorship requests before closing'); this.#db.close(); }
}
