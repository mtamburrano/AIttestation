import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, chmod, link, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeSponsor, checkSponsor, migrateSponsor } from '../spikes/development/sponsor.mjs';
import { PRIVATE_SPONSOR_LIMITS, migratePrivateSponsorPolicy } from '../spikes/development/sponsor-policy.mjs';
import { ManagedSponsorship, DEFAULT_LIMITS } from '../spikes/managed/service.mjs';
import { MANAGED_PROFILE } from '../spikes/managed/protocol.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { privateJSON } from '../spikes/development/environment.mjs';
import { fileInventory } from '../spikes/distribution/inventory.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';

const oldLimits = { accounts: 1, ledger: 10, accountMonth: 10, accountDay: 10, globalDay: 10, accountMinute: 20, globalMinute: 30 };
const oldPolicy = canonical({ profile: MANAGED_PROFILE, limits: oldLimits });
const currentPolicy = canonical({ profile: MANAGED_PROFILE, limits: PRIVATE_SPONSOR_LIMITS });
const localSponsor = { async prepare(payload) { return { transactionId: 'A'.repeat(52),
  signedTransaction: Buffer.from(`fixture:${payload}`).toString('base64'), feeMicroAlgos: 1000, network: 'testnet-v1.0' }; },
async broadcast() {} };
const database = directory => join(directory, 'ledger/sponsorship.sqlite');
function mutate(directory, action) {
  const db = new DatabaseSync(database(directory));
  try { return action(db); } finally { db.close(); }
}
function rows(directory) {
  const db = new DatabaseSync(database(directory), { readOnly: true });
  try { return Object.fromEntries(['config', 'accounts', 'anchors', 'meter'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
async function fixture(t, { old = true } = {}) {
  const root = await realpath(await mkdtemp('/private/tmp/sponsor-policy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'synthetic-sponsor'), network = restrictFixtureNetwork(root);
  let service;
  try {
    const initialized = await initializeSponsor(directory, 37461);
    assert.equal(initialized.maxTransactions, 1000); assert.equal(initialized.externalCalls, 0);
    if (old) mutate(directory, db => db.prepare('UPDATE config SET value=?').run(oldPolicy));
    const account = await privateJSON(join(directory, 'access.json'));
    service = new ManagedSponsorship(join(directory, 'ledger'), { sponsor: localSponsor, limits: old ? oldLimits : PRIVATE_SPONSOR_LIMITS });
    for (let i = 0; i < 5; i++) await service.anchor(account.accessCode,
      { profile: MANAGED_PROFILE, payload: Buffer.concat([Buffer.from('PAP\x01'), randomBytes(32)]).toString('base64url') });
  } finally { service?.close(); network.restore(); }
  return { root, directory, baseline: rows(directory), files: (await fileInventory(directory)).filter(file => !file.path.startsWith('ledger/')) };
}

test('exact historical private policy migrates atomically with all five historical reservations and identities unchanged', async t => {
  const f = await fixture(t);
  assert.equal(f.baseline.anchors.length, 5);
  assert.ok(f.baseline.anchors.every(row => row.prepared !== null && row.broadcasts === 1));
  assert.throws(() => new ManagedSponsorship(join(f.directory, 'ledger'), {
    sponsor: localSponsor, limits: PRIVATE_SPONSOR_LIMITS }), /Stored sponsorship policy mismatch/);
  await assert.rejects(checkSponsor(f.directory), /POLICY_MIGRATION_REQUIRED/);
  const network = restrictFixtureNetwork(f.root);
  try {
    assert.deepEqual(await migrateSponsor(f.directory), { profile: 'pap-private-development/1',
      migrated: true, maxTransactions: 1000, externalCalls: 0 });
    const after = rows(f.directory);
    assert.equal(after.config[0].value, currentPolicy);
    for (const table of ['accounts', 'anchors', 'meter']) assert.deepEqual(after[table], f.baseline[table]);
    assert.deepEqual((await fileInventory(f.directory)).filter(file => !file.path.startsWith('ledger/')), f.files);
    const checked = await checkSponsor(f.directory);
    assert.equal(checked.externalCalls, 0); assert.equal(checked.maxTransactions, 1000);
    assert.equal(checked.accountMonth, 1000); assert.equal(checked.accountDay, 100);
    assert.ok(checked.checks.includes('SPONSOR_POLICY_CURRENT'));
    const service = new ManagedSponsorship(join(f.directory, 'ledger'), { sponsor: localSponsor, limits: PRIVATE_SPONSOR_LIMITS });
    service.close();
  } finally { network.restore(); }
  assert.deepEqual(DEFAULT_LIMITS, { accounts: 1000, ledger: 100000, accountMonth: 1000, accountDay: 100,
    globalDay: 10000, accountMinute: 20, globalMinute: 600 });
});

test('an already-current policy is a byte-preserving no-op, including repeated migration', async t => {
  const f = await fixture(t, { old: false });
  const baseline = await fileInventory(f.directory);
  for (let i = 0; i < 2; i++) {
    const report = await migrateSponsor(f.directory);
    assert.equal(report.migrated, false); assert.equal(report.externalCalls, 0);
    assert.deepEqual(rows(f.directory), f.baseline);
    assert.deepEqual(await fileInventory(f.directory), baseline);
  }
});

test('unknown or modified policies fail without touching existing rows or resetting generic mismatch protection', async t => {
  const f = await fixture(t);
  for (const value of [canonical({ profile: MANAGED_PROFILE, limits: DEFAULT_LIMITS }),
    canonical({ profile: MANAGED_PROFILE, limits: { ...oldLimits, ledger: 11 } }),
    canonical({ profile: MANAGED_PROFILE, limits: { ...PRIVATE_SPONSOR_LIMITS, accountDay: 1000 } }),
    canonical({ profile: MANAGED_PROFILE, limits: { ...oldLimits, extra: true } }), 'invalid json', `${oldPolicy}\n`]) {
    mutate(f.directory, db => db.prepare('UPDATE config SET value=?').run(value));
    const baseline = rows(f.directory), bytes = await readFile(database(f.directory));
    await assert.rejects(migrateSponsor(f.directory), /POLICY_MISMATCH/);
    assert.deepEqual(rows(f.directory), baseline);
    assert.deepEqual(await readFile(database(f.directory)), bytes);
  }
});

test('an interrupted precommit update rolls back exactly and a later explicit retry preserves history', async t => {
  const f = await fixture(t);
  await assert.rejects(migratePrivateSponsorPolicy(f.directory, { beforeCommit() { throw Error('SYNTHETIC_INTERRUPTION'); } }), /SYNTHETIC_INTERRUPTION/);
  assert.deepEqual(rows(f.directory), f.baseline);
  assert.equal((await migrateSponsor(f.directory)).migrated, true);
  assert.deepEqual(rows(f.directory).anchors, f.baseline.anchors);
});

test('unexpected triggers cannot turn the policy migration into account or anchor mutations', async t => {
  const f = await fixture(t);
  mutate(f.directory, db => db.exec('CREATE TRIGGER unexpected AFTER UPDATE ON config BEGIN DELETE FROM anchors; END'));
  const baseline = rows(f.directory), bytes = await readFile(database(f.directory));
  await assert.rejects(migrateSponsor(f.directory), /POLICY_MISMATCH/);
  assert.deepEqual(rows(f.directory), baseline);
  assert.deepEqual(await readFile(database(f.directory)), bytes);
});

test('missing, linked or weakly protected ledger files fail before SQLite can create, adopt or migrate them', async t => {
  const f = await fixture(t), path = database(f.directory), saved = join(f.root, 'original.sqlite');
  await rename(path, saved);
  await assert.rejects(migratePrivateSponsorPolicy(f.directory));
  await symlink(saved, path); await assert.rejects(migratePrivateSponsorPolicy(f.directory)); await rm(path);
  await link(saved, path); await assert.rejects(migratePrivateSponsorPolicy(f.directory)); await rm(path);
  await rename(saved, path); await chmod(path, 0o644);
  await assert.rejects(migratePrivateSponsorPolicy(f.directory)); await chmod(path, 0o600);
  assert.deepEqual(rows(f.directory), f.baseline);
});
