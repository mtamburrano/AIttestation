import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, copyFile, chmod, link } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { assertPlatform, initializeAccount, testAccount, validateAccount, newDirectory } from '../spikes/development/environment.mjs';
import { validateDevelopmentConfig, validateDevelopmentSigner } from '../spikes/development/prepare.mjs';
import { registerNativeHost, removeNativeHost, command } from '../spikes/development/cli.mjs';
import { chromeApplicationFiles, checkPlatform } from '../spikes/development/chrome.mjs';
import { algorandAddress, initializeSponsor, serveSponsor } from '../spikes/development/sponsor.mjs';
import { localTLSRequest } from '../spikes/development/tls.mjs';
import { ManagedSponsorship } from '../spikes/managed/service.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';
import { startManagedServer } from '../spikes/managed/http.mjs';
import { DurableVault, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { backupDevelopment, restoreDevelopment } from '../spikes/development/recovery.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { releaseBuildPlan } from '../spikes/distribution/release-inputs.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';
import { verifyFastConfirmation } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { developmentCommandFailure, startupFailure, readStartupFailure } from '../spikes/development/startup.mjs';

async function isolated(t) {
  const root = await realpath(await mkdtemp('/private/tmp/attestamp-private-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('private startup diagnostics expose fixed failure labels without echoing runtime data', () => {
  const locked = startupFailure(Error('macOS Keychain is locked'));
  assert.equal(locked, 'PRIVATE_DEVELOPMENT_START_FAILED:KEYCHAIN_LOCKED');
  assert.equal(readStartupFailure(`an unrelated runtime warning\n${locked}\n`), locked);
  assert.equal(developmentCommandFailure(Error(locked)), locked);
  assert.equal(developmentCommandFailure(Error('DEDICATED_MACOS_TEST_USER_REQUIRED')), 'DEDICATED_MACOS_TEST_USER_REQUIRED');
  const sensitive = '/private/test/secret-file?token=synthetic-secret';
  assert.equal(startupFailure(Object.assign(Error(sensitive), { code: sensitive })),
    'PRIVATE_DEVELOPMENT_START_FAILED:UNKNOWN');
  for (const output of [sensitive, `${locked}:${sensitive}`, `PRIVATE_DEVELOPMENT_START_FAILED:${sensitive}`,
    `${'x'.repeat(4096)}\n${locked}`]) {
    assert.equal(readStartupFailure(output), 'PRIVATE_APP_START_NOT_CONFIRMED');
  }
  for (const output of [sensitive, `${locked}:${sensitive}`, `${locked}\n${sensitive}`,
    `${sensitive}\n${locked}`, 'PRIVATE_DEVELOPMENT_START_FAILED:UNRECOGNIZED']) {
    assert.equal(developmentCommandFailure(Error(output)), 'PRIVATE_DEVELOPMENT_COMMAND_FAILED');
  }
  assert.equal(developmentCommandFailure(null), 'PRIVATE_DEVELOPMENT_COMMAND_FAILED');
});

test('private preparation requires the exact profile-authorized signing certificate', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = await isolated(t), certFile = join(root, 'synthetic-signing-cert.pem');
  const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=private-development-certificate-fixture', '-keyout', join(root, 'synthetic-signing-key.pem'), '-out', certFile],
  { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr);
  const certificate = new X509Certificate(await readFile(certFile));
  const identity = certificate.fingerprint.replaceAll(':', '');
  const profile = `<plist version="1.0"><dict><key>DeveloperCertificates</key><array><data>${certificate.raw.toString('base64')}</data></array></dict></plist>`;
  assert.doesNotThrow(() => validateDevelopmentSigner(profile, identity));
  assert.throws(() => validateDevelopmentSigner(profile, '0'.repeat(40)), /SIGNING_CERTIFICATE_MISMATCH/);
  assert.throws(() => validateDevelopmentSigner(profile.replace(/<data>.*<\/data>/, ''), identity), /INVALID_PRIVATE_HELPER_CERTIFICATES/);
});

test('private development rejects ordinary accounts, unsupported Chrome and production promotion', async () => {
  assert.throws(() => testAccount({ username: 'owner', uid: 501, homedir: '/Users/owner' }), /TEST_USER/);
  assert.throws(() => testAccount({ username: 'attestamp-test', uid: 501, homedir: '/Users/owner' }), /TEST_USER/);
  const baseline = { platform: 'darwin', arch: 'arm64', osVersion: '15.7.9', chromeVersion: '153.0.0.0' };
  assert.doesNotThrow(() => assertPlatform(baseline));
  for (const chromeVersion of ['152.0.7977.83', '154.0.0.0', '153.invalid']) {
    assert.throws(() => assertPlatform({ ...baseline, chromeVersion }), /CHROME_153_REQUIRED/);
  }
  assert.throws(() => assertPlatform({ ...baseline, osVersion: '15.6.9' }), /SUPPORTED_APPLE/);
  assert.throws(() => releaseBuildPlan({ releaseChannel: 'private-development' }), /release/i);
  assert.equal(copyApplicationResource('spikes/development/runtime.mjs'), false);
  const config = { profile: 'pap-private-development/1', teamId: 'TESTTEAM01', signingIdentity: 'A'.repeat(40),
    helperProvisioningProfile: '/private/test/profile', sponsor: null };
  assert.doesNotThrow(() => validateDevelopmentConfig(config));
  assert.throws(() => validateDevelopmentConfig({ ...config, allowFakeConfirmation: true }), /INVALID_PRIVATE/);
  assert.throws(() => validateDevelopmentConfig({ ...config, sponsor: {
    origin: 'http://127.0.0.1:37461', certificateFile: '/private/test/cert' } }), /TLS_SPONSOR/);
  await assert.rejects(command(['start', '/unused', '--chrome-app', '/unused.app', '--offline']), /LIVE_TEST_OPT_IN/);
  await assert.rejects(command(['start', '/unused', '--live-chatgpt-testnet']), /USAGE/);
  await assert.rejects(command(['doctor']), /USAGE/);
  await assert.rejects(serveSponsor('/unused', '--fixture'), /LIVE_TESTNET_OPT_IN/);
});

test('private Chrome selection requires an explicit separate owned copy and rejects aliases and shared files', async t => {
  const root = await isolated(t), application = join(root, 'Google Chrome.app');
  const paths = { home: root, control: join(root, 'control'), support: join(root, 'vault'), chrome: join(root, 'chrome-data') };
  const executable = join(application, 'Contents/MacOS/Google Chrome');
  const infoPlist = join(application, 'Contents/Info.plist');
  await mkdir(join(application, 'Contents/MacOS'), { recursive: true });
  await writeFile(executable, 'synthetic executable'); await writeFile(infoPlist, 'synthetic metadata');
  assert.deepEqual(await chromeApplicationFiles(application, paths), { application, executable, infoPlist });
  for (const candidate of [undefined, '/Applications/Google Chrome.app', 'Google Chrome.app', `${root}/../Google Chrome.app`]) {
    await assert.rejects(chromeApplicationFiles(candidate, paths), /EXPLICIT_TEST_USER_CHROME_COPY/);
  }
  await assert.rejects(chromeApplicationFiles(join(paths.chrome, 'Google Chrome.app'), paths), /MUST_BE_SEPARATE/);
  const alias = join(root, 'Alias.app'); await symlink(application, alias);
  await assert.rejects(chromeApplicationFiles(alias, paths), /UNSAFE_PRIVATE_CHROME_COPY/);
  await chmod(application, 0o777);
  await assert.rejects(chromeApplicationFiles(application, paths), /UNSAFE_PRIVATE_CHROME_COPY/);
  await chmod(application, 0o755);
  const shared = join(root, 'shared-executable'); await link(executable, shared);
  await assert.rejects(chromeApplicationFiles(application, paths), /UNSAFE_PRIVATE_CHROME_COPY/);
  await rm(shared);
  await rm(executable); await symlink(infoPlist, executable);
  await assert.rejects(chromeApplicationFiles(application, paths), /UNSAFE_PRIVATE_CHROME_COPY/);
});

test('relocating a browser never substitutes an ad hoc signature for Google identity', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await isolated(t), application = join(root, 'Google Chrome.app');
  const paths = { home: root, control: join(root, 'control'), support: join(root, 'vault'), chrome: join(root, 'chrome-data') };
  await mkdir(join(application, 'Contents/MacOS'), { recursive: true });
  await copyFile('/usr/bin/true', join(application, 'Contents/MacOS/Google Chrome'));
  await writeFile(join(application, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Google Chrome</string><key>CFBundleIdentifier</key><string>com.google.Chrome</string><key>CFBundleShortVersionString</key><string>153.0.0.0</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', application], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(signed.status, 0, signed.stderr);
  await assert.rejects(checkPlatform(application, paths), /CHROME_SIGNATURE_REJECTED/);
});

test('account setup refuses existing state and registration cleanup is ownership safe across restarts', async t => {
  const root = await isolated(t);
  const paths = { home: root, control: join(root, 'control'), support: join(root, 'vault'), chrome: join(root, 'chrome') };
  await initializeAccount(paths); await validateAccount(paths);
  await assert.rejects(initializeAccount(paths), /ALREADY_HAS_STATE/);
  const target = join(paths.chrome, 'NativeMessagingHosts/ai.provenance.consumer.json');
  await registerNativeHost(paths, join(root, 'signed-browser-host'));
  const installed = await readFile(target, 'utf8');
  await assert.rejects(registerNativeHost(paths, join(root, 'replacement')), /ALREADY_EXISTS/);
  await writeFile(target, '{}');
  await assert.rejects(removeNativeHost(paths), /REGISTRATION_CHANGED/);
  assert.equal(await readFile(target, 'utf8'), '{}');
  await writeFile(target, installed); await removeNativeHost(paths);
  await registerNativeHost(paths, join(root, 'rebuilt-browser-host')); await removeNativeHost(paths);
  const marker = JSON.parse(await readFile(join(paths.control, 'account.json')));
  assert.equal(marker.uid, process.getuid());
  const alias = join(root, 'alias'); await symlink(root, alias);
  await assert.rejects(newDirectory(join(alias, 'must-not-be-created')), /CANONICAL/);
  await mkdir(join(root, '.git'));
  await assert.rejects(newDirectory(join(root, 'secrets-in-checkout')), /OUTSIDE_REPOSITORIES/);
});

test('local TLS sponsorship keeps explicit certificate trust and cannot supply release confirmation', async t => {
  const root = await isolated(t), sponsorDirectory = join(root, 'sponsor');
  const setup = await initializeSponsor(sponsorDirectory, 37461);
  assert.equal(setup.externalCalls, 0); assert.equal(setup.maxTransactions, 1000);
  assert.equal(setup.network, 'testnet-v1.0'); assert.match(setup.address, /^[A-Z2-7]{58}$/);
  assert.equal(algorandAddress(Buffer.alloc(32)), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ');
  await assert.rejects(initializeSponsor(sponsorDirectory, 37461), { code: 'EEXIST' });
  const service = new ManagedSponsorship(join(root, 'offline-fixture-ledger'), { sponsor: {
    async prepare() { return { transactionId: 'A'.repeat(52), signedTransaction: Buffer.from('isolated TLS fixture').toString('base64'),
      feeMicroAlgos: 1000, network: 'testnet-v1.0' }; }, async broadcast() {},
  } });
  const cert = await readFile(join(sponsorDirectory, 'tls-cert.pem'));
  const server = await startManagedServer(service, { tls: { cert, key: await readFile(join(sponsorDirectory, 'tls-key.pem')) } });
  t.after(async () => { await server.close(); service.close(); });
  const account = service.provision({ paidThrough: Date.now() + 60000 });
  const transport = localTLSRequest(cert, server.origin);
  const client = new ManagedAnchoringClient({ origin: server.origin, keyStore: new MemoryKeyStore(), request: transport });
  assert.equal((await client.connect(account.accessCode)).state, 'ACTIVE');
  const payload = Buffer.concat([Buffer.from('PAP\x01'), randomBytes(32)]).toString('base64url');
  const submission = await client.submit(payload);
  assert.equal(submission.state, 'SUBMITTED_OR_UNKNOWN');
  assert.throws(() => verifyFastConfirmation(submission, { profile: 'PAP_ALGORAND_FAST_CONFIRM_V1' }, payload),
    /not authorized/);
  await assert.rejects(transport(server.origin, '/outside', account.accessCode), /unavailable/);
  const untrusted = new ManagedAnchoringClient({ origin: server.origin, keyStore: new MemoryKeyStore() });
  await assert.rejects(untrusted.connect(account.accessCode), /unavailable/);
  assert.equal((await client.status()).state, 'ACTIVE', 'failed trust does not alter the account');
});

test('private recovery reopens fresh keys and exports historical receipts without replacing send authority', async t => {
  const root = await isolated(t), paths = { home: root, control: join(root, 'control'),
    support: join(root, 'support'), chrome: join(root, 'chrome') };
  await initializeAccount(paths);
  const keyStore = new MemoryKeyStore(), vault = DurableVault.create(join(paths.support, 'vault'), { keyStore });
  const sourceIdentity = vault.status();
  const text = vault.capture(Buffer.from('synthetic recovery text e\u0301'));
  vault.capture(Buffer.from(canonical({ profile: 'pap-chatgpt-observation/1', kind: 'frozen-text-version',
    mode: 'Sealed', textRecord: text.manifest.eventId, textObject: text.manifest.evidence[0].objectDigest })), { type: 'observation' });
  vault.close();
  const backup = await backupDevelopment(paths, join(root, 'backup'), keyStore);
  // Snapshot creation durably reserves encryption nonces; restoration must not
  // change the source after that legitimate write.
  const sourceDatabase = createHash('sha256').update(await readFile(join(paths.support, 'vault/vault.sqlite'))).digest('hex');
  assert.equal(backup.keyIncludedInPackage, false);
  assert.ok(backup.recoverySecretFile.startsWith(paths.control));
  const packageFile = join(root, 'backup/encrypted-recovery.json');
  const restored = await restoreDevelopment(paths, join(root, 'restore'), packageFile, backup.recoverySecretFile, keyStore);
  assert.equal(restored.snapshot, 'COMPLETE'); assert.equal(restored.historicalSendAuthorization, 'NONE');
  assert.equal(restored.activeVaultReplaced, false); assert.equal(restored.exportedReceipts, 1);
  const reopened = DurableVault.open(join(root, 'restore/restored-vault'), { keyStore });
  try {
    assert.notEqual(reopened.status().signingPublicKey, sourceIdentity.signingPublicKey);
    assert.notEqual(reopened.status().vaultKeyId, sourceIdentity.vaultKeyId);
    assert.equal(reopened.inspect().records[0].recordDigest, text.recordDigest);
  } finally { reopened.close(); }
  assert.equal(createHash('sha256').update(await readFile(join(paths.support, 'vault/vault.sqlite'))).digest('hex'), sourceDatabase);
  const report = verifyPortable(await readFile(join(root, 'restore/receipt-0001.json')));
  assert.equal(report.records.length, 2);
  assert.equal(report.records[0].integrity, 'VALID');
  const wrongSecret = join(root, 'wrong.key'); await writeFile(wrongSecret, randomBytes(32), { mode: 0o600 });
  const accounts = keyStore.accounts();
  await assert.rejects(restoreDevelopment(paths, join(root, 'rejected-restore'), packageFile, wrongSecret, keyStore));
  assert.deepEqual(keyStore.accounts(), accounts);
  await assert.rejects(readFile(join(root, 'rejected-restore/recovery-report.json')), { code: 'ENOENT' });
  await assert.rejects(backupDevelopment(paths, join(paths.control, 'recovery-secrets'), keyStore), /OUTPUT_MUST_BE_SEPARATE/);
});

test('native private host rejects the ordinary OS account before running bundled code', {
  skip: process.platform !== 'darwin' || userInfo().username === 'attestamp-test',
}, async t => {
  const root = await isolated(t), app = join(root, 'Private test.app'), contents = join(app, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources/spikes/development'), { recursive: true });
  await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>provenance-app-host</string><key>CFBundleIdentifier</key><string>ai.provenance.consumer.host</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const sentinel = join(root, 'runtime-ran');
  await writeFile(join(contents, 'Resources/spikes/development/runtime.mjs'),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'unexpected');`);
  await copyFile(process.execPath, join(contents, 'MacOS/node'));
  const run = (binary, args) => {
    const result = spawnSync(binary, args, { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr); return result;
  };
  run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'swift-cache'), '-O',
    '-D', 'PRODUCT_CHATGPT', '-D', 'PRODUCT_RELEASE', '-D', 'PRIVATE_DEVELOPMENT',
    '-framework', 'Security', new URL('../spikes/vault/native/macos-app-host.swift', import.meta.url).pathname,
    '-o', join(contents, 'MacOS/provenance-app-host')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', join(contents, 'MacOS/node')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const rejected = spawnSync(join(contents, 'MacOS/provenance-app-host'), [], { env: {}, timeout: 5000 });
  assert.equal(rejected.status, 1);
  await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
});
