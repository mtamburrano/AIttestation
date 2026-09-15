import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir, lstat, chmod, symlink, link, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { OwnerDebugSession, DEBUG_SESSION_LIMITS, DEBUG_STORAGE_LIMITS } from '../spikes/development/debug-session.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';
import { productFixture, SYNTHETIC_CANARY } from '../spikes/development/product-fixtures.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';
import { publishRuntimeState, RUNTIME_STATE_PROFILE } from '../spikes/development/runtime-state.mjs';

async function isolated(t) {
  const root = await realpath(await mkdtemp('/private/tmp/pap-debug-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const events = content => JSON.parse(content).segments.flatMap(segment => segment.events);
function record(session, code = 'ENGINE_STARTED', data = {}) {
  session.diagnostics.record(code, { epochId: 'synthetic-epoch', ...data });
}
async function bytes(root) {
  const files = {};
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await lstat(path);
    if (info.isFile()) files[name] = await readFile(path);
  }
  return files;
}
function child(root, mode) {
  return spawnSync(process.execPath, ['test/debug-session-child.mjs', root, mode], {
    env: { PATH: '/usr/bin:/bin', PROVENANCE_VAULT: '/forbidden-inherited-vault',
      PAP_SPONSOR_ORIGIN: 'https://forbidden.invalid' }, encoding: 'utf8', timeout: 15000,
  });
}

test('recording requires explicit opt-in, persists stop/resume and exports an immutable whole-session snapshot', async t => {
  const root = await isolated(t);
  let session = new OwnerDebugSession(root); t.after(() => session.close());
  record(session); assert.equal(session.status().state, 'STOPPED');
  assert.deepEqual(await readdir(root), []); assert.throws(() => session.export());
  session.setEnabled(true); record(session);
  const original = session.export(), id = session.status().sessionId;
  record(session, 'BRIDGE_TIMEOUT');
  assert.equal(events(original).length, 1); assert.equal(events(session.export()).length, 2);
  session.setEnabled(false); record(session, 'ENGINE_CLOSED'); session.close();
  session = new OwnerDebugSession(root); assert.equal(session.status().state, 'STOPPED');
  record(session); assert.equal(events(session.export()).length, 2);
  session.setEnabled(true); record(session, 'ENGINE_STARTED');
  assert.equal(session.status().sessionId, id); assert.equal(session.status().segments, 2);
  assert.notEqual(events(session.export())[0].epochId, events(session.export()).at(-1).epochId);
  const contender = new OwnerDebugSession(root); assert.equal(contender.status().state, 'UNAVAILABLE'); contender.close();
  assert.equal(session.status().state, 'RECORDING');
  session.close(); session = new OwnerDebugSession(root);
  assert.equal(session.status().state, 'RECORDING'); assert.equal(events(session.export()).length, 3);
});

test('a deterministic SIGKILL after WAL commit retains both events and starts a fresh diagnostic epoch', async t => {
  const root = await isolated(t), result = child(root, 'wal-crash');
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  const directory = join(root, 'debug-session');
  assert.ok((await lstat(join(directory, 'journal.sqlite-wal'))).size > 32);
  for (const [name, content] of Object.entries(await bytes(directory))) {
    assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o600);
    assert.ok(content.length <= (name.endsWith('-wal') ? DEBUG_STORAGE_LIMITS.walBytes : DEBUG_STORAGE_LIMITS.databaseBytes));
  }
  // Model a process exit while the read-only inspection is opening its index.
  await chmod(join(directory, 'journal.sqlite-shm'), 0o400);
  const session = new OwnerDebugSession(root); t.after(() => session.close());
  assert.equal(session.status().state, 'RECORDING');
  assert.deepEqual(events(session.export()).map(event => event.code), ['ENGINE_STARTED', 'BRIDGE_DISCONNECTED']);
  record(session);
  assert.equal(session.status().segments, 2); assert.equal(events(session.export()).length, 3);
});

test('a crashed real engine retains diagnostics and evidence with fresh sources on restart', async t => {
  const root = await isolated(t), crash = child(root, 'runtime-crash');
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);
  const oldLocator = await readFile(join(root, 'runtime.json'), 'utf8');
  const restart = child(root, 'runtime-restart'); assert.equal(restart.status, 0, restart.stderr);
  assert.notEqual(await readFile(join(root, 'runtime.json'), 'utf8'), oldLocator);
  const session = new OwnerDebugSession(root); t.after(() => session.close());
  const recorded = events(session.export());
  assert.equal(recorded.filter(event => event.code === 'ENGINE_STARTED').length, 2);
  assert.equal(new Set(recorded.map(event => event.epochId)).size, 2);
  assert.equal(recorded.filter(event => event.code === 'DISPATCH_STARTED').length, 0);
  assert.ok(!session.export().includes('CRASH_PROMPT_CANARY'));
});

test('private restart refuses unsafe or unrecognized existing runtime locators', async t => {
  const root = await isolated(t), path = join(root, 'runtime.json');
  const runtime = { runtimeEpoch: 'synthetic', dashboardURL: `http://127.0.0.1:12345/dashboard#${'a'.repeat(43)}`,
    engine: { state: () => ({ available: true, runtimeEpoch: 'synthetic' }) } };
  const valid = { profile: RUNTIME_STATE_PROFILE, dashboardURL: runtime.dashboardURL };
  for (const invalid of [{ ...valid, text: 'SECRET' }, { ...valid, dashboardURL: 'https://external.invalid/' },
    { ...valid, profile: 'other' }, { ...valid, dashboardURL: runtime.dashboardURL.replace('12345', '80') }]) {
    const content = JSON.stringify(invalid); await writeFile(path, content, { mode: 0o600 });
    await assert.rejects(publishRuntimeState(root, runtime)); assert.equal(await readFile(path, 'utf8'), content);
  }
  await writeFile(path, JSON.stringify(valid)); await chmod(path, 0o644);
  await assert.rejects(publishRuntimeState(root, runtime)); assert.equal((await lstat(path)).mode & 0o777, 0o644);
  await rm(path); await symlink(join(root, 'unrelated'), path);
  await assert.rejects(publishRuntimeState(root, runtime)); assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(copyApplicationResource('spikes/development/runtime-state.mjs'), false);
});

test('incomplete WAL appends preserve the committed prefix; complete corrupt frames are left untouched', async t => {
  for (const mutation of ['incomplete', 'checksum', 'salt', 'header']) await t.test(mutation, async t => {
    const root = await isolated(t); assert.equal(child(root, 'wal-crash').signal, 'SIGKILL');
    const directory = join(root, 'debug-session'), path = join(directory, 'journal.sqlite-wal');
    const wal = await readFile(path);
    if (mutation === 'incomplete') await writeFile(path, wal.subarray(0, wal.length - 1));
    else { wal[mutation === 'header' ? 24 : mutation === 'salt' ? 40 : 60] ^= 1; await writeFile(path, wal); }
    const before = await bytes(directory), session = new OwnerDebugSession(root); t.after(() => session.close());
    if (mutation === 'incomplete') {
      assert.equal(session.status().state, 'RECORDING');
      assert.deepEqual(events(session.export()).map(event => event.code), ['ENGINE_STARTED']);
      record(session); assert.equal(session.status().retainedEvents, 2);
    } else {
      assert.equal(session.status().state, 'UNAVAILABLE'); assert.throws(() => session.export());
      assert.deepEqual(await bytes(directory), before);
    }
  });
});

test('a malformed session in a valid WAL is refused without checkpointing or changing any journal file', async t => {
  const root = await isolated(t), crash = child(root, 'malformed-wal'); assert.equal(crash.signal, 'SIGKILL', crash.stderr);
  const directory = join(root, 'debug-session'), before = await bytes(directory);
  const indexMode = (await lstat(join(directory, 'journal.sqlite-shm'))).mode;
  const session = new OwnerDebugSession(root); t.after(() => session.close());
  assert.equal(session.status().state, 'UNAVAILABLE'); assert.throws(() => session.export());
  session.close(); assert.deepEqual(await bytes(directory), before);
  assert.equal((await lstat(join(directory, 'journal.sqlite-shm'))).mode, indexMode);
});

test('rotation enforces event, segment, logical byte and physical byte ceilings', async t => {
  for (const limits of [{ events: 5, segmentEvents: 2 }, { segments: 2, segmentEvents: 2 },
    { bytes: 2048, segmentBytes: 1024 }, { segmentBytes: 1024 }]) {
    const root = await isolated(t), session = new OwnerDebugSession(root, { limits }); t.after(() => session.close());
    session.setEnabled(true);
    for (let i = 0; i < 36; i++) record(session, 'OPERATION_FROZEN', {
      operationId: String(i), bridgeId: 'bridge', captureId: 'capture', confirmationId: 'confirmation', dispatchId: 'dispatch' });
    const report = JSON.parse(session.export()), bound = { ...DEBUG_SESSION_LIMITS, ...limits };
    assert.equal(session.status().state, 'RECORDING'); assert.ok(report.droppedEvents > 0 || limits.segmentBytes);
    assert.ok(events(session.export()).length <= bound.events); assert.ok(report.segments.length <= bound.segments);
    assert.ok(report.segments.every(segment => Buffer.byteLength(JSON.stringify(segment)) <= bound.segmentBytes
      && segment.events.length <= bound.segmentEvents));
    const { limits: _limits, ...stored } = report;
    assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= bound.bytes);
    assert.ok(Buffer.byteLength(session.export()) <= DEBUG_STORAGE_LIMITS.exportBytes);
    const directory = join(root, 'debug-session');
    for (const [name, content] of Object.entries(await bytes(directory))) {
      assert.ok(content.length <= (name.endsWith('-wal') ? DEBUG_STORAGE_LIMITS.walBytes : DEBUG_STORAGE_LIMITS.databaseBytes));
      assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o600);
    }
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  }
});

test('age pruning runs on status/export and reopening, removes stale disk bytes, and rejects clock rollback', async t => {
  const root = await isolated(t); let now = 1000;
  let session = new OwnerDebugSession(root, { now: () => now, limits: { ageMs: 100 } }); t.after(() => session.close());
  session.setEnabled(true); record(session);
  const expired = events(session.export())[0].epochId;
  now = 1099; assert.equal(session.status().retainedEvents, 1);
  now = 1100; assert.equal(session.status().retainedEvents, 0);
  assert.ok(Object.values(await bytes(join(root, 'debug-session'))).every(value => !value.includes(expired)));
  record(session); session.close(); now = 1200;
  session = new OwnerDebugSession(root, { now: () => now, limits: { ageMs: 100 } });
  assert.equal(session.status().retainedEvents, 0); assert.equal(session.status().droppedEvents, 2);
  now = 1199; assert.equal(session.status().state, 'UNAVAILABLE'); assert.throws(() => session.export());
});

test('default-size sessions keep recording through repeated full-journal rotations', async t => {
  const root = await isolated(t), session = new OwnerDebugSession(root); t.after(() => session.close());
  session.setEnabled(true);
  for (let i = 0; i < 2600; i++) record(session, 'OPERATION_FROZEN', {
    operationId: String(i), bridgeId: 'bridge', captureId: 'capture', confirmationId: 'confirm', dispatchId: 'dispatch', durationMs: 86400000 });
  assert.equal(session.status().state, 'RECORDING');
  assert.ok(session.status().droppedEvents > 0);
  assert.equal(events(session.export()).at(-1).sequence, 2600);
  for (const [name, content] of Object.entries(await bytes(join(root, 'debug-session')))) {
    assert.ok(content.length <= (name.endsWith('-wal') ? DEBUG_STORAGE_LIMITS.walBytes : DEBUG_STORAGE_LIMITS.databaseBytes));
  }
  const directory = join(root, 'full'); await mkdir(directory, { mode: 0o700 });
  const network = restrictFixtureNetwork(root);
  try {
    const result = await productFixture(directory, 'recording-normal-send', session.diagnostics, network);
    assert.equal(result.observed, 'NORMAL_PROMPT_SAVED'); assert.equal(result.providerAttempts, 0);
    assert.equal(session.status().state, 'RECORDING');
  } finally { network.restore(); }
});

test('the shared allowlist rejects privacy canaries before persistence and pseudonymizes correlation fields', async t => {
  const root = await isolated(t), session = new OwnerDebugSession(root); t.after(() => session.close());
  session.setEnabled(true);
  const canaries = [SYNTHETIC_CANARY, 'ACCESS_CODE_CANARY', 'RECOVERY_KEY_CANARY', 'BEARER_TOKEN_CANARY',
    'ACCOUNT_SECRET_CANARY', 'PROVIDER_RESPONSE_CANARY', 'd'.repeat(64), '<div>DOM_ERROR_CANARY</div>'];
  for (const value of canaries) {
    for (const field of ['prompt', 'text', 'url', 'digest', 'error', 'dom', 'accessCode', 'recoveryKey', 'token', 'response']) {
      assert.throws(() => record(session, 'ENGINE_STARTED', { [field]: value }));
    }
    assert.throws(() => record(session, value)); record(session, 'OPERATION_FROZEN', { operationId: value });
  }
  let invoked = false;
  assert.throws(() => session.diagnostics.record('ENGINE_STARTED', { get epochId() { invoked = true; return 'SECRET'; } }));
  assert.equal(invoked, false);
  const content = session.export();
  assert.equal(events(content).length, canaries.length);
  const disk = Object.values(await bytes(join(root, 'debug-session')));
  for (const canary of canaries) {
    assert.ok(!content.includes(canary)); assert.ok(disk.every(value => !value.includes(Buffer.from(canary))));
  }
  assert.equal(session.status().state, 'RECORDING');
});

test('unsafe and malformed existing resources fail closed without adoption or repair', async t => {
  const mutations = {
    'weak directory': async (root, directory) => chmod(directory, 0o755),
    'weak file': async (_root, _directory, path) => chmod(path, 0o644),
    'linked file': async (root, _directory, path) => link(path, join(root, 'unrelated')),
    'symlink file': async (root, _directory, path) => { await rm(path); await writeFile(join(root, 'unrelated'), 'UNRELATED'); await symlink(join(root, 'unrelated'), path); },
    'foreign file': async (_root, directory) => writeFile(join(directory, 'unrelated'), 'UNRELATED'),
    'malformed database': async (_root, _directory, path) => writeFile(path, 'MALFORMED_CANARY'),
    'oversized database': async (_root, _directory, path) => writeFile(path, Buffer.alloc(DEBUG_STORAGE_LIMITS.databaseBytes + 1)),
    'malformed WAL': async (_root, _directory, path) => writeFile(`${path}-wal`, 'WAL_CANARY', { mode: 0o600 }),
    'symlink WAL': async (root, _directory, path) => { await writeFile(join(root, 'unrelated'), 'UNRELATED'); await symlink(join(root, 'unrelated'), `${path}-wal`); },
    'weak index marker': async (_root, _directory, path) => chmod(`${path}-shm`, 0o644),
    'arbitrary index': async (_root, _directory, path) => { await chmod(`${path}-shm`, 0o600); await writeFile(`${path}-shm`, 'INDEX_CANARY'); await chmod(`${path}-shm`, 0o400); },
    'unexpected schema': async (_root, _directory, path) => { const db = new DatabaseSync(path); db.exec('PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE unexpected (secret TEXT)'); db.close(); },
    'unrecognized metadata': async (_root, _directory, path) => { const db = new DatabaseSync(path); db.exec('PRAGMA locking_mode=EXCLUSIVE');
      const state = JSON.parse(db.prepare('SELECT payload FROM journal').get().payload); state.url = 'https://metadata.invalid';
      db.prepare('UPDATE journal SET payload=?').run(JSON.stringify(state)); db.close(); },
    'unrecognized event': async (_root, _directory, path) => { const db = new DatabaseSync(path); db.exec('PRAGMA locking_mode=EXCLUSIVE');
      const state = JSON.parse(db.prepare('SELECT payload FROM journal').get().payload); state.segments[0].events[0].error = 'ERROR_CANARY';
      db.prepare('UPDATE journal SET payload=?').run(JSON.stringify(state)); db.close(); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const root = await isolated(t), directory = join(root, 'debug-session'), path = join(directory, 'journal.sqlite');
    let session = new OwnerDebugSession(root); session.setEnabled(true); record(session); session.close();
    await mutate(root, directory, path);
    const before = await bytes(directory), mode = (await lstat(path)).mode;
    session = new OwnerDebugSession(root);
    assert.equal(session.status().state, 'UNAVAILABLE'); assert.throws(() => session.setEnabled(true));
    assert.throws(() => session.export()); record(session); session.close();
    assert.deepEqual(await bytes(directory), before); assert.equal((await lstat(path)).mode, mode);
  });
  const root = await isolated(t); await mkdir(join(root, 'debug-session'), { mode: 0o700 });
  const empty = new OwnerDebugSession(root); assert.equal(empty.status().state, 'UNAVAILABLE'); empty.close();
  assert.deepEqual(await readdir(join(root, 'debug-session')), []);
  const alias = join(root, 'alias'); await symlink(root, alias);
  const noncanonical = new OwnerDebugSession(alias); assert.equal(noncanonical.status().state, 'UNAVAILABLE'); noncanonical.close();
});

test('dashboard recording/export obey local authentication and cannot change engine or integration authority', async t => {
  const root = await isolated(t), session = new OwnerDebugSession(root); t.after(() => session.close());
  const network = restrictFixtureNetwork(root); let f;
  t.after(async () => { await f?.close(); network.restore(); });
  f = await recordingFixture(root, { diagnostics: session.diagnostics, debugSession: session, network });
  const api = async (path, body = {}, credentials = true) => {
    const url = new URL(f.runtime.dashboardURL);
    const response = await fetch(new URL(path, url), { method: 'POST',
      headers: { Origin: url.origin, Authorization: credentials ? `Bearer ${url.hash.slice(1)}` : 'Bearer invalid' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const baseline = f.runtime.engine.state(), durable = f.runtime.session.vault.inspect();
  assert.equal((await api('/debug-session/recording', { enabled: true }, false)).status, 400);
  assert.equal(session.status().state, 'STOPPED');
  assert.equal((await api('/debug-session/recording', { enabled: true })).status, 200);
  assert.equal((await api('/dashboard/state')).value.debugSession.state, 'RECORDING');
  assert.deepEqual(f.runtime.engine.state(), baseline); assert.deepEqual(f.runtime.session.vault.inspect(), durable);
  for (const body of [{ enabled: 'true' }, { enabled: true, token: 'SECRET' }, {}]) {
    assert.equal((await api('/debug-session/recording', body)).status, 400);
  }
  await f.recording(true); f.send(SYNTHETIC_CANARY);
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const saved = await api('/debug-session/export'); assert.equal(saved.status, 200);
  assert.ok(events(saved.value.content).some(event => event.code === 'NORMAL_PROMPT_SAVED'));
  assert.equal((await api('/debug-session/export', { includeEvidence: true })).status, 400);
  assert.equal((await api('/debug-session/export', {}, false)).status, 400);
  f.disconnect(); await until(() => f.runtime.browserState() === null);
  assert.ok(events(session.export()).some(event => event.code === 'BRIDGE_DISCONNECTED'));
  assert.equal(session.status().state, 'RECORDING');
  assert.equal(f.releases.length, 0); assert.equal(f.anchorCalls, 1); assert.equal(f.confirmed, 1);
});

test('debug recording preserves ON/OFF outcomes, anchor counts and bounded retries', async t => {
  const root = await isolated(t), network = restrictFixtureNetwork(root); t.after(() => network.restore());
  for (const scenario of ['recording-normal-send', 'recording-storage-gap', 'recording-connection-gap', 'panel-recording']) {
    const outcomes = [];
    for (const enabled of [false, true, 'failed']) {
      const directory = join(root, `s${outcomes.length}`); await mkdir(directory, { mode: 0o700 });
      const session = enabled ? new OwnerDebugSession(directory, { afterCommit: () => {
        if (enabled === 'failed') throw Error('SYNTHETIC_JOURNAL_WRITE_FAILURE_CANARY');
      } }) : null;
      try {
        session?.setEnabled(true);
        const result = await productFixture(directory, scenario, session?.diagnostics ?? new LocalDiagnostics(), network);
        const { operationId: _operation, epochId: _epoch, ...outcome } = result; outcomes.push(outcome);
        if (session && enabled !== 'failed') { assert.equal(session.status().state, 'RECORDING'); assert.ok(events(session.export()).length > 0); }
        if (enabled === 'failed') assert.equal(session.status().state, 'UNAVAILABLE');
      } finally { session?.close(); await rm(directory, { recursive: true, force: true }); }
    }
    assert.deepEqual(outcomes[1], outcomes[0], scenario);
    assert.deepEqual(outcomes[2], outcomes[0], `${scenario} with unavailable recording`);
  }
  assert.equal(copyApplicationResource('spikes/development/debug-session.mjs'), false);
});
