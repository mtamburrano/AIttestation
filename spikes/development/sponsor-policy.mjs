import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonical } from '../vault/format.mjs';
import { MANAGED_PROFILE } from '../managed/protocol.mjs';
import { assertReleasePath } from '../distribution/release-inputs.mjs';
import { exists, ownerDirectory } from './environment.mjs';

export const PRIVATE_SPONSOR_LIMITS = Object.freeze({ accounts: 1, ledger: 1000, accountMonth: 1000, accountDay: 100,
  globalDay: 1000, accountMinute: 20, globalMinute: 30 });
const historical = canonical({ profile: MANAGED_PROFILE, limits: { accounts: 1, ledger: 10, accountMonth: 10, accountDay: 10,
  globalDay: 10, accountMinute: 20, globalMinute: 30 } });
const current = canonical({ profile: MANAGED_PROFILE, limits: PRIVATE_SPONSOR_LIMITS });
const fail = () => Error('PRIVATE_SPONSOR_POLICY_MISMATCH');

async function ledgerPath(directory) {
  await ownerDirectory(directory);
  await ownerDirectory(join(directory, 'ledger'));
  const path = join(directory, 'ledger/sponsorship.sqlite');
  await assertReleasePath(path, { privateFile: true });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (await exists(path + suffix)) await assertReleasePath(path + suffix, { privateFile: true });
  }
  return path;
}

function policy(db) {
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type != 'index' ORDER BY name").all();
  // Do not let an unexpected trigger, view or replacement table turn this
  // single-row policy update into a mutation of account or anchor history.
  if (schema.length !== 4 || schema.some(row => row.type !== 'table')
      || schema.map(row => row.name).join(',') !== 'accounts,anchors,config,meter'
      || schema.find(row => row.name === 'config').sql !== 'CREATE TABLE config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)') throw fail();
  const rows = db.prepare('SELECT id,value FROM config').all();
  if (rows.length !== 1 || rows[0].id !== 1 || ![historical, current].includes(rows[0].value)) throw fail();
  return rows[0].value;
}

export async function checkPrivateSponsorPolicy(directory) {
  const db = new DatabaseSync(await ledgerPath(directory), { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    if (policy(db) !== current) throw Error('PRIVATE_SPONSOR_POLICY_MIGRATION_REQUIRED');
    return { maxTransactions: PRIVATE_SPONSOR_LIMITS.ledger, accountMonth: PRIVATE_SPONSOR_LIMITS.accountMonth,
      accountDay: PRIVATE_SPONSOR_LIMITS.accountDay };
  } finally { db.close(); }
}

export async function migratePrivateSponsorPolicy(directory, { beforeCommit = () => {} } = {}) {
  const path = await ledgerPath(directory);
  const probe = new DatabaseSync(path, { readOnly: true });
  try {
    probe.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    if (policy(probe) === current) return { migrated: false, maxTransactions: PRIVATE_SPONSOR_LIMITS.ledger, externalCalls: 0 };
  } finally { probe.close(); }
  // Revalidate under the write lock: concurrent migrations cannot reset quota
  // or silently accept a policy changed between inspection and mutation.
  const db = new DatabaseSync(await ledgerPath(directory));
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    if (policy(db) === current) {
      db.exec('ROLLBACK');
      return { migrated: false, maxTransactions: PRIVATE_SPONSOR_LIMITS.ledger, externalCalls: 0 };
    }
    if (db.prepare('UPDATE config SET value=? WHERE id=1 AND value=?').run(current, historical).changes !== 1) throw fail();
    beforeCommit();
    db.exec('COMMIT');
    return { migrated: true, maxTransactions: PRIVATE_SPONSOR_LIMITS.ledger, externalCalls: 0 };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}
