import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, readdir, rm, writeFile, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { LocalDiagnostics, DIAGNOSTIC_LIMITS, emit } from '../spikes/release/diagnostics.mjs';
import { PRODUCT_SCENARIOS, SYNTHETIC_CANARY } from '../spikes/development/product-fixtures.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { checkSponsor } from '../spikes/development/sponsor.mjs';
import { readReleaseFile } from '../spikes/distribution/release-inputs.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';

async function isolated(t) {
  const root = await realpath(await mkdtemp('/private/tmp/attestamp-diagnostics-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('diagnostics reject arbitrary data and pseudonymize identifiers without exporting a reusable key', () => {
  const log = new LocalDiagnostics(), other = new LocalDiagnostics();
  const canaries = [SYNTHETIC_CANARY, 'secret-api-key', 'a'.repeat(64), '<div>private DOM</div>', 'https://example.invalid/?token=secret'];
  for (const canary of canaries) {
    assert.throws(() => log.record(canary), /INVALID_DIAGNOSTIC/);
    for (const field of ['text', 'message', 'reason', 'error', 'stack', 'url', 'digest', 'key', 'token', 'dom']) {
      assert.throws(() => log.record('ENGINE_STARTED', { [field]: canary }), /INVALID_DIAGNOSTIC/);
    }
    log.record('OPERATION_FROZEN', { operationId: canary });
    assert.equal(log.id('operationId', canary), log.id('operationId', canary));
    assert.notEqual(log.id('operationId', canary), other.id('operationId', canary));
    assert.notEqual(log.id('operationId', canary), log.id('captureId', canary));
  }
  for (const durationMs of [NaN, Infinity, -1, 'SECRET']) assert.throws(() => log.record('ENGINE_STARTED', { durationMs }));
  for (const operationId of [null, 42, {}, 'x'.repeat(257)]) assert.throws(() => log.record('OPERATION_FROZEN', { operationId }));
  let accessed = false;
  assert.throws(() => log.record('ENGINE_STARTED', { get operationId() { accessed = true; return 'secret'; } }));
  assert.equal(accessed, false);
  const preview = log.preview(), content = log.export(preview.previewId);
  assert.equal(content, JSON.stringify(preview.report));
  assert.ok(canaries.every(canary => !content.includes(canary)));
  assert.doesNotThrow(() => emit({ record() { throw Error(SYNTHETIC_CANARY); } }, 'ENGINE_STARTED'));
  assert.equal(preview.report.events.length, canaries.length);
});

test('bounded records, expiry and one-use previews retain only the exact selected snapshot', () => {
  let now = 0;
  const log = new LocalDiagnostics({ limits: { events: 3, bytes: 1024, ageMs: 1000 }, now: () => now });
  const scoped = log.scope({ epochId: 'runtime' });
  for (let index = 0; index < 5; index++) scoped.record('OPERATION_FROZEN', { operationId: String(index), durationMs: 1 });
  assert.equal(log.selection().retainedEvents, 3);
  const id = log.id('operationId', '4'), preview = log.preview({ operationIds: [id], components: ['engine'] });
  assert.equal(preview.report.droppedEvents, 2); assert.equal(preview.report.events.length, 1);
  assert.equal(preview.report.events[0].epochId, log.id('epochId', 'runtime'));
  scoped.record('ENGINE_CLOSED');
  preview.report.events[0].code = 'MUTATED_PREVIEW';
  const saved = JSON.parse(log.export(preview.previewId));
  assert.equal(saved.events[0].code, 'OPERATION_FROZEN');
  assert.throws(() => log.export(preview.previewId));
  now = 900; const expires = log.preview(); now = 1000;
  assert.equal(log.selection().retainedEvents, 0);
  assert.throws(() => log.export(expires.previewId), 'a new preview must not extend the oldest selected event retention');
  const first = log.preview();
  for (let index = 0; index < DIAGNOSTIC_LIMITS.previews; index++) log.preview();
  assert.throws(() => log.export(first.previewId));
  assert.throws(() => log.preview({ operationIds: [SYNTHETIC_CANARY] }));
  assert.throws(() => log.preview({ components: [SYNTHETIC_CANARY] }));
  assert.throws(() => log.preview({ includeEvidence: true }));
  assert.throws(() => new LocalDiagnostics({ limits: { events: 513 } }));
  const byteBounded = new LocalDiagnostics({ limits: { bytes: 1024 } });
  for (let index = 0; index < 30; index++) byteBounded.record('VAULT_CAPTURED', {
    operationId: String(index), epochId: 'epoch', bridgeId: 'bridge', captureId: String(index) });
  const bounded = byteBounded.preview();
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.report.events)) <= 1026);
  assert.ok(bounded.report.droppedEvents > 0);
});

test('detailed traces require explicit synthetic mode and fixture authorities cannot enter product packages', () => {
  assert.throws(() => new LocalDiagnostics({ detailed: true }));
  assert.throws(() => new LocalDiagnostics({ mode: 'live', detailed: true }));
  for (const [detailed, expected] of [[false, 0], [true, 1]]) {
    const log = new LocalDiagnostics({ mode: 'SYNTHETIC_FIXTURE', detailed });
    log.record('BRIDGE_STATE', { bridgeId: 'synthetic-peer' });
    assert.equal(log.preview().report.events.length, expected);
  }
  assert.equal(copyApplicationResource('spikes/development/product-fixtures.mjs'), false);
  assert.equal(copyApplicationResource('spikes/development/product-test-worker.mjs'), false);
  assert.equal(copyApplicationResource('spikes/release/diagnostics.mjs'), true);
});

test('fixture networking refuses external and unregistered local destinations before connecting', async t => {
  const root = await isolated(t), guard = restrictFixtureNetwork(root);
  try {
    assert.throws(() => createConnection({ host: 'provider.invalid', port: 443 }), /FIXTURE_NETWORK_FORBIDDEN/);
    assert.throws(() => createConnection({ host: '127.0.0.1', port: 37461 }), /FIXTURE_NETWORK_FORBIDDEN/);
    assert.throws(() => createConnection(join(root, 'unregistered.sock')), /FIXTURE_NETWORK_FORBIDDEN/);
    await assert.rejects(fetch('https://provider.invalid/'), /FIXTURE_NETWORK_FORBIDDEN/);
    assert.throws(() => guard.allowRuntime({ socketPath: '/unrelated/socket', composerURL: 'http://127.0.0.1:1/#synthetic' }));
  } finally { guard.restore(); }
});

test('fresh sponsor creates private files under umask 000 and the existing permission gate still rejects weak keys', async t => {
  const root = await isolated(t), sponsor = join(root, 'sponsor');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import {initializeSponsor} from "./spikes/development/sponsor.mjs"; process.umask(0); await initializeSponsor(process.argv[1], 37461);', sponsor],
  { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, 'fresh isolated sponsor initialization failed');
  for (const file of ['account.seed', 'tls-key.pem', 'tls-cert.pem', 'tls.cnf', 'sponsor.json', 'access.json']) {
    assert.equal((await lstat(join(sponsor, file))).mode & 0o777, 0o600, file);
  }
  const check = await checkSponsor(sponsor);
  assert.equal(check.externalCalls, 0); assert.ok(check.checks.includes('TLS_CERTIFICATE_MATCH'));
  await chmod(join(sponsor, 'tls-key.pem'), 0o644);
  await assert.rejects(checkSponsor(sponsor), /Unsafe release input permissions/);
  await assert.rejects(readReleaseFile(join(sponsor, 'tls-key.pem'), { privateFile: true }), /Unsafe release input permissions/);
  assert.equal((await lstat(join(sponsor, 'tls-key.pem'))).mode & 0o777, 0o644, 'self-check never repairs existing files');
});

test('documented runner exercises real components with correlated bounded reports and no inherited resources', async t => {
  const root = await isolated(t), output = join(root, 'report');
  const sentinel = join(root, 'do-not-touch'); await writeFile(sentinel, 'retained synthetic state');
  const result = spawnSync(process.execPath, ['spikes/development/product-test.mjs', '--output', output, '--trace-synthetic'], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: sentinel, PROVENANCE_VAULT: sentinel,
      PAP_SPONSOR_ORIGIN: 'https://unrelated.invalid', HTTPS_PROXY: 'https://unrelated.invalid', NODE_EXTRA_CA_CERTS: sentinel },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(await readFile(sentinel, 'utf8'), 'retained synthetic state');
  assert.deepEqual((await readdir(output)).sort(), ['diagnostics.json', 'report.html', 'result.json']);
  const report = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  assert.equal(report.liveEvidence, 'NOT_TESTED'); assert.equal(report.mode, 'SYNTHETIC_FIXTURE');
  assert.deepEqual(report.scenarios.map(value => value.scenario), PRODUCT_SCENARIOS);
  const events = report.diagnostics.events;
  assert.ok(events.some(event => event.code === 'BRIDGE_STATE'));
  assert.ok(events.length <= DIAGNOSTIC_LIMITS.events);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, 'PASS');
    const correlated = events.filter(event => event.operationId === scenario.operationId);
    assert.ok(correlated.length > 0 && correlated.every(event => event.epochId === scenario.epochId));
    assert.ok(correlated.some(event => event.code === scenario.observed));
    assert.ok(correlated.some(event => event.code === 'VAULT_CAPTURED' && event.captureId));
    if (scenario.providerAttempts) {
      const dispatch = correlated.find(event => event.code === 'DISPATCH_AUTHORIZATION_CONSUMED');
      const bridge = correlated.find(event => event.code === 'BRIDGE_DISPATCH');
      assert.ok(dispatch && bridge && bridge.bridgeId && dispatch.dispatchId === bridge.dispatchId);
      assert.ok(dispatch.sequence < bridge.sequence);
    }
    if (scenario.scenario !== 'account-disconnected') {
      const confirmation = correlated.filter(event => event.confirmationId);
      assert.ok(confirmation.length >= 2 && new Set(confirmation.map(event => event.confirmationId)).size === 1);
      if (scenario.scenario === 'sealed-delayed-confirmation') {
        assert.equal(confirmation.filter(event => event.code === 'ALGOD_NOT_YET_OBSERVABLE').length, 1);
        assert.equal(confirmation.filter(event => event.code === 'ALGOD_NOT_YET_CONFIRMED').length, 2);
        assert.equal(confirmation.at(-1).code, 'CONFIRMATION_ACCEPTED');
      }
      if (scenario.scenario === 'confirmation-unavailable') {
        assert.ok(confirmation.some(event => event.code === 'CONFIRMATION_BUDGET_EXPIRED'));
        assert.ok(confirmation.some(event => event.code === 'CONFIRMATION_PENDING'));
      }
    }
  }
  assert.deepEqual(JSON.parse(await readFile(join(output, 'diagnostics.json'), 'utf8')), report.diagnostics);
  for (const file of ['result.json', 'diagnostics.json', 'report.html']) {
    const bytes = await readFile(join(output, file));
    assert.ok(bytes.length < 512 * 1024); assert.equal((await lstat(join(output, file))).mode & 0o777, 0o600);
    assert.ok(!bytes.includes(Buffer.from(SYNTHETIC_CANARY)));
    assert.doesNotMatch(bytes.toString(), /SECRET_CANARY|PRIVATE_DOM|synthetic-private-conversation|https:\/\//);
  }
  const existing = spawnSync(process.execPath, ['spikes/development/product-test.mjs', '--output', output], { env: {}, encoding: 'utf8' });
  assert.equal(existing.status, 2, 'an existing report cannot be adopted or overwritten');
  const live = spawnSync(process.execPath, ['spikes/development/product-test.mjs', '--live'], { env: {}, encoding: 'utf8' });
  assert.equal(live.status, 2);
  assert.equal(JSON.parse(live.stdout).reason, 'INVALID_OPTIONS_OR_OUTPUT');
});
