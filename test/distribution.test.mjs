import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { InstallationLifecycle } from '../spikes/distribution/lifecycle.mjs';
import { DesktopUpdater } from '../spikes/distribution/updater.mjs';
import { RELEASE_PROFILE, sha256, verifyRelease } from '../spikes/distribution/release.mjs';
import { createChromeWebStoreUpload, releaseArtifactContract, releaseBuildPlan, validateBuildConfig } from '../spikes/distribution/build-macos.mjs';
import { dependencyInventory, validateDependencyApproval } from '../spikes/distribution/inventory.mjs';
import { codeSignatureCheckArguments } from '../spikes/distribution/local.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { Vault } from '../spikes/vault/vault.mjs';
import { identity, verifyDisclosure } from '../spikes/vault/records.mjs';
import { ChatGPTChromeAdapter, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT, CHATGPT_RELEASE_PROTOCOL } from '../spikes/browser/chatgpt/adapter.mjs';
import { startProductComposer } from '../spikes/browser/chatgpt/product-server.mjs';
import { RELEASE_CANDIDATE_PROFILE, RELEASE_CHANNELS, validateInstalledRelease, validateReleaseCandidate } from '../spikes/distribution/config.mjs';

async function temporary(t) {
  const root = await realpath(await mkdtemp('/private/tmp/provenance-distribution-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const installation = (root, sequence = 2) => new InstallationLifecycle({ supportDirectory: join(root, 'support'),
  chromeSupportDirectory: join(root, 'chrome-test-only'), browserHost: join(root, 'Test.app/Contents/MacOS/provenance-browser-host'), sequence });

test('macOS signature checks accept inline identity requirements and reject wrong identities and tampering',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = await temporary(t), executable = join(root, 'signature-fixture');
    await copyFile('/usr/bin/true', executable);
    const options = { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000 };
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'signature-fixture', executable], options);
    assert.equal(signed.status, 0, signed.stderr);
    const check = requirement => spawnSync('/usr/bin/codesign', codeSignatureCheckArguments(executable, requirement), options);
    const accepted = check('identifier "signature-fixture"');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.notEqual(check('identifier "different-fixture"').status, 0);
    assert.notEqual(check('anchor apple generic and certificate leaf[subject.OU] = "TESTTEAM01"').status, 0);
    const bytes = await readFile(executable); bytes[1024] ^= 1; await writeFile(executable, bytes);
    assert.notEqual(check('identifier "signature-fixture"').status, 0);
  });

function releaseFixture(overrides = {}) {
  const key = generateKeyPairSync('ed25519'), bytes = Buffer.from('synthetic signed disk image bytes');
  const release = { profile: RELEASE_PROFILE, sequence: 3, version: '1.2.0', platform: 'darwin-arm64',
    publishedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    readerVersion: 3, maximumSchema: 3, artifact: { name: 'Private-Provenance-1.2.0-3.dmg', bytes: bytes.length, sha256: sha256(bytes) },
    provenanceDigest: '1'.repeat(64), dependencyDigest: '2'.repeat(64), ...overrides };
  const encode = (value = release) => canonical({ release: value, signature: sign(null, Buffer.from(canonical(value)), key.privateKey).toString('base64url') });
  const publicKey = key.publicKey.export({ format: 'jwk' }).x;
  return { key, bytes, release, encode, publicKey,
    policy: { publicKey, installedSequence: 2, highestSeen: 2, schema: { writerVersion: 3, minimumReader: 1 } } };
}

test('release metadata authenticates exact artifact, provenance, schema and freshness before update admission', () => {
  const f = releaseFixture(); assert.deepEqual(verifyRelease(f.encode(), f.policy), f.release);
  const tampered = JSON.parse(f.encode()); tampered.release.artifact.sha256 = '0'.repeat(64);
  assert.throws(() => verifyRelease(canonical(tampered), f.policy), /SIGNATURE_REJECTED/);
  const other = releaseFixture(); assert.throws(() => verifyRelease(other.encode(), f.policy), /SIGNATURE_REJECTED/);
  assert.throws(() => verifyRelease(f.encode(), { ...f.policy, installedSequence: 3 }), /ROLLBACK/);
  assert.throws(() => verifyRelease(f.encode(), { ...f.policy, highestSeen: 4 }), /ROLLBACK/);
  assert.throws(() => verifyRelease(f.encode(), { ...f.policy, schema: { writerVersion: 4, minimumReader: 1 } }), /SCHEMA/);
  assert.throws(() => verifyRelease(f.encode(), { ...f.policy, schema: { writerVersion: 4, minimumReader: 4 } }), /SCHEMA/);
  assert.throws(() => verifyRelease(f.encode(), { ...f.policy, now: Date.now() + 86400_001 }), /EXPIRED/);
  assert.throws(() => verifyRelease(f.encode({ ...f.release, artifact: { ...f.release.artifact, name: '../escape.dmg' } }), f.policy), /SIGNATURE_REJECTED/);
  assert.throws(() => verifyRelease(`${f.encode()} `, f.policy), /SIGNATURE_REJECTED/);
  assert.throws(() => verifyRelease('x'.repeat(16 * 1024 + 1), f.policy), /SIGNATURE_REJECTED/);
});

test('consented integration is reversible, idempotent, export-aware, and preserves evidence and unrelated registrations', async t => {
  const root = await temporary(t), lifecycle = await installation(root).init();
  const evidence = randomBytes(256), evidencePath = join(root, 'support/acknowledged-proof'); await writeFile(evidencePath, evidence);
  assert.equal((await lifecycle.status()).integration, 'DISABLED');
  assert.equal((await lifecycle.enable()).integration, 'ENABLED');
  assert.equal((await lifecycle.enable()).integration, 'ENABLED');
  const unrelated = join(root, 'chrome-test-only/NativeMessagingHosts/unrelated.json'); await writeFile(unrelated, 'untouched');
  const manifest = JSON.parse(await readFile(lifecycle.manifestPath));
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/']);
  await assert.rejects(lifecycle.remove({ exportDecision: 'keep-local' }), /EXPORT_OPPORTUNITY/);
  await lifecycle.record('exportOffered');
  assert.deepEqual(await lifecycle.remove({ exportDecision: 'keep-local' }), { integration: 'DISABLED', evidence: 'RETAINED', keys: 'RETAINED' });
  assert.equal(await readFile(unrelated, 'utf8'), 'untouched'); assert.deepEqual(await readFile(evidencePath), evidence);
  await lifecycle.enable(); const reopened = await installation(root).init();
  await assert.rejects(reopened.remove({ exportDecision: 'keep-local' }), /EXPORT_OPPORTUNITY/);
  const restored = JSON.parse(await readFile(lifecycle.manifestPath)); restored.path = '/unrelated/app';
  await writeFile(lifecycle.manifestPath, JSON.stringify(restored));
  await assert.rejects(reopened.enable(), /CONFLICT/); await reopened.record('exportOffered');
  await assert.rejects(reopened.remove({ exportDecision: 'exported' }), /CONFLICT/);
  assert.deepEqual(JSON.parse(await readFile(lifecycle.manifestPath)), restored);
});

test('redirected integration directories and files are rejected without modifying the target', async t => {
  for (const kind of ['directory', 'file']) {
    const root = await temporary(t), lifecycle = await installation(root).init();
    await mkdir(join(root, 'other')); await writeFile(join(root, 'other/marker'), 'untouched');
    if (kind === 'directory') await symlink(join(root, 'other'), join(root, 'chrome-test-only'));
    else {
      await mkdir(join(root, 'chrome-test-only/NativeMessagingHosts'), { recursive: true });
      await symlink(join(root, 'other/marker'), lifecycle.manifestPath);
    }
    await assert.rejects(lifecycle.enable(), /UNSAFE/);
    assert.equal(await readFile(join(root, 'other/marker'), 'utf8'), 'untouched');
  }
});

test('restart preserves rollback floor and diagnostics cannot echo evidence, URLs, identifiers or error text', async t => {
  const root = await temporary(t), lifecycle = await installation(root).init();
  await lifecycle.rememberRelease(4);
  const reopened = await installation(root).init(); assert.equal(reopened.highestSeen, 4);
  await assert.rejects(installation(root, 1).init(), /APPLICATION_ROLLBACK/);
  const report = reopened.diagnostics({ paired: 'secret-evidence', update: '/Users/name/private.txt', error: 'evidence' });
  assert.equal(report.pairing, 'UNPAIRED'); assert.equal(report.update, 'REJECTED');
  assert.doesNotMatch(JSON.stringify(report), /Users|private\.txt|secret-evidence|https:|integrationPath|highestSeen/);
  assert.deepEqual(report.externalMeasurements, { osPermissionSteps: null, storePermissionSteps: null, installedPairingMs: null });
});

test('verified downloads require both signatures, reject partial/tampered artifacts, and keep the current app usable', async t => {
  for (const mode of ['valid', 'tampered', 'interrupted', 'apple-rejected', 'oversized']) {
    const root = await temporary(t), lifecycle = await installation(root).init(), f = releaseFixture();
    let appleCalls = 0;
    const updater = new DesktopUpdater({ config: { updateOrigin: 'https://updates.example', updatePublicKey: f.publicKey,
      teamId: 'TESTTEAM01', sequence: 2 }, lifecycle, schema: () => f.policy.schema, directory: join(root, 'updates'),
    get: async (url, limit, consume) => {
      assert.equal(url.origin, 'https://updates.example');
      if (url.pathname === '/desktop/stable.json') { await consume(Buffer.from(f.encode())); return; }
      assert.equal(limit, f.bytes.length);
      if (mode === 'interrupted') { await consume(f.bytes.subarray(0, 4)); throw Error('private filename'); }
      await consume(mode === 'tampered' ? Buffer.alloc(f.bytes.length) : mode === 'oversized' ? Buffer.alloc(f.bytes.length + 1) : f.bytes);
    }, apple: async (path, team) => {
      appleCalls++; assert.equal(team, 'TESTTEAM01'); assert.deepEqual(await readFile(path), f.bytes);
      if (mode === 'apple-rejected') throw Error('OS path must stay private');
    } });
    assert.equal((await updater.check()).state, 'AVAILABLE');
    if (mode === 'valid') {
      const downloaded = await updater.download(); assert.equal(downloaded.state, 'DOWNLOADED');
      assert.deepEqual(await readFile(downloaded.path), f.bytes); assert.equal(appleCalls, 1);
    } else {
      await assert.rejects(updater.download(), /^Error: UPDATE_REJECTED$/);
      assert.deepEqual(await readdir(join(root, 'updates')), []);
      assert.equal(appleCalls, mode === 'apple-rejected' ? 1 : 0);
    }
    assert.equal((await installation(root).init()).highestSeen, 3, 'failed updates do not prevent the current app from reopening');
  }
});

test('migration process death preserves exact acknowledged proofs before and after commit for compatible readers', async t => {
  for (const phase of ['migration-after-ddl', 'migration-before-commit', 'migration-after-commit']) {
    const root = await temporary(t), path = join(root, 'vault'), vmk = randomBytes(32), signer = identity();
    const vault = new Vault(path, vmk, signer, { create: true });
    const record = vault.capture(Buffer.from('synthetic migration baseline e\u0301\r\n☕'));
    const event = record.manifest.eventId, baseline = vault.exportDisclosure([event]); vault.close();
    const db = new DatabaseSync(join(path, 'vault.sqlite'));
    db.exec('DROP TABLE key_retirements; DROP TABLE vault_schema; PRAGMA user_version=1;'); db.close();
    const keyPath = join(root, 'test-only-vmk'); await writeFile(keyPath, vmk, { mode: 0o600 });
    const child = spawnSync(process.execPath, [join(import.meta.dirname, 'vault-migration-child.mjs'), path, keyPath, phase],
      { env: {}, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    for (const readerVersion of [1, 3]) {
      const reopened = new Vault(path, vmk, signer, { readerVersion });
      assert.equal(reopened.verifyAll().count, 1);
      assert.deepEqual(reopened.exportDisclosure([event]), baseline); reopened.close();
    }
    assert.equal(verifyDisclosure(baseline).records[0].integrity, 'VALID');
  }
});

test('missing or incompatible migration metadata fails closed before newer or older app writes', async t => {
  for (const sql of ['DROP TABLE vault_schema', 'UPDATE vault_schema SET minimum_reader=4', 'UPDATE vault_schema SET minimum_reader=0', 'PRAGMA user_version=99']) {
    const root = await temporary(t), path = join(root, 'vault'), key = randomBytes(32);
    new Vault(path, key, undefined, { create: true }).close();
    const db = new DatabaseSync(join(path, 'vault.sqlite')); db.exec(sql); db.close();
    await assert.rejects(Promise.resolve().then(() => new Vault(path, key)), /schema/i);
  }
});

test('current, previous, and future compatibility fixtures do not broaden the pinned protected path', async () => {
  const matrix = JSON.parse(await readFile(new URL('../spikes/distribution/fixtures/compatibility.json', import.meta.url)));
  for (const fixture of matrix.cases) {
    const adapter = new ChatGPTChromeAdapter(() => {}, { extensionId: 'medilhopfckldjgdnchfkpmfmfnkadca' });
    const pair = () => adapter.pair({ extensionId: 'medilhopfckldjgdnchfkpmfmfnkadca', adapterProfile: fixture.adapterProfile,
      releaseProtocol: CHATGPT_RELEASE_PROTOCOL, pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'test-browser-session',
      browser: { product: 'Google Chrome', channel: 'stable', major: fixture.chromeMajor },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.9' },
      permissionState: 'granted', permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*' });
    if (fixture.supported) assert.doesNotThrow(pair, fixture.name); else assert.throws(pair, /UNSUPPORTED_PATH/, fixture.name);
  }
  assert.equal(matrix.cases[0].adapterProfile, CHATGPT_ADAPTER_PROFILE);
});

test('Chrome Web Store upload strips only the development key and includes validated icons', { skip: process.platform !== 'darwin' }, async t => {
  const root = await temporary(t);
  const archive = await createChromeWebStoreUpload(root);
  const sourcePath = join(import.meta.dirname, '../spikes/browser/chatgpt/extension/manifest.json');
  const sourceManifest = JSON.parse(await readFile(sourcePath, 'utf8'));
  const listing = spawnSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const uploadManifestResult = spawnSync('/usr/bin/unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' });
  assert.equal(uploadManifestResult.status, 0, uploadManifestResult.stderr);
  const uploadManifest = JSON.parse(uploadManifestResult.stdout);
  assert.equal(typeof sourceManifest.key, 'string');
  assert.equal(uploadManifest.key, undefined);
  assert.deepEqual(uploadManifest.icons, sourceManifest.icons);
  assert.deepEqual(uploadManifest.permissions, ['nativeMessaging', 'sidePanel']);
  for (const file of ['sidepanel.html', 'sidepanel.js', 'sidepanel-model.js', 'sidepanel.css']) {
    const uploaded = spawnSync('/usr/bin/unzip', ['-p', archive, file]);
    assert.equal(uploaded.status, 0);
    assert.deepEqual(uploaded.stdout, await readFile(join(import.meta.dirname, '../spikes/browser/chatgpt/extension', file)));
  }
  assert.deepEqual(uploadManifest.host_permissions, ['https://chatgpt.com/*']);
  for (const icon of Object.values(sourceManifest.icons)) {
    assert.match(listing.stdout, new RegExp(`(?:^|\\n)${icon.replaceAll('.', '\\.')}(?:\\n|$)`));
    const sourceIcon = await readFile(join(import.meta.dirname, '../spikes/browser/chatgpt/extension', icon));
    const uploadIcon = spawnSync('/usr/bin/unzip', ['-p', archive, icon]);
    assert.equal(uploadIcon.status, 0, uploadIcon.stderr?.toString());
    assert.deepEqual(uploadIcon.stdout, sourceIcon);
  }
  const unchangedSource = JSON.parse(await readFile(sourcePath, 'utf8'));
  assert.deepEqual(unchangedSource, sourceManifest);
});

test('release placeholders cannot produce a production configuration and inventory pins all direct and transitive Go dependencies', async () => {
  const config = JSON.parse(await readFile(new URL('../spikes/distribution/release-config.example.json', import.meta.url)));
  assert.equal(config.notaryProfile, 'private-provenance-notary'); assert.throws(() => validateBuildConfig(config), /PROVISIONING/);
  const inventory = await dependencyInventory(join(import.meta.dirname, '..'));
  assert.equal(inventory.modules.length, 9); assert.deepEqual(inventory.javascriptPackages, []);
  assert.ok(inventory.modules.every(module => module.checksum.startsWith('h1:')));
  assert.ok(Object.hasOwn(inventory.node.components, 'openssl')); assert.ok(Object.hasOwn(inventory.node.components, 'sqlite'));
});

async function syntheticGoToolchain(directory) {
  const contents = {
    'bin/go': '#!/bin/sh\ncase "$1 $2" in\n"version ") printf "go version test-only darwin/arm64\\n";;\n"env GOROOT") /usr/bin/dirname "$(/usr/bin/dirname "$0")";;\n*) exit 1;;\nesac\n',
    LICENSE: 'synthetic Go license', PATENTS: 'synthetic Go patent grant',
    VERSION: 'test-only', 'go.env': 'synthetic toolchain defaults',
    'src/runtime/runtime.go': 'package runtime\n', 'pkg/include/textflag.h': 'synthetic assembler headers',
    'lib/time/zoneinfo.zip': 'synthetic embedded time data',
    ...Object.fromEntries(['compile', 'link', 'asm', 'cgo'].map(name => [`pkg/tool/darwin_arm64/${name}`, `synthetic ${name}`])),
  };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(join(directory, path), content, { mode: 0o700 });
  }
  return join(directory, 'bin/go');
}

function syntheticApproval(inventory) {
  return { inventoryDigest: sha256(canonical(inventory)), reviewer: 'synthetic-test-only',
    securityApproved: true, licensesApproved: true, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

async function dependencyFixture(t) {
  const directory = await temporary(t), root = join(directory, 'source'), goRoot = join(directory, 'go');
  const moduleRoot = join(root, 'spikes/anchor/algorand');
  await mkdir(join(moduleRoot, 'cmd/verify'), { recursive: true });
  await mkdir(join(root, 'spikes/distribution'), { recursive: true });
  for (const path of ['package.json', 'spikes/anchor/algorand/go.mod', 'spikes/anchor/algorand/go.sum',
    'spikes/distribution/THIRD_PARTY_NOTICES.md']) {
    await copyFile(join(import.meta.dirname, '..', path), join(root, path));
  }
  const source = join(moduleRoot, 'cmd/verify/main.go');
  await writeFile(source, 'package main\nimport "fmt"\nfunc main() { fmt.Println("synthetic") }\n');
  const goExecutable = await syntheticGoToolchain(goRoot);
  return { directory, root, goRoot, goExecutable, moduleRoot, source,
    inventory: () => dependencyInventory(root, { goExecutable }) };
}

test('runtime notice changes invalidate exact inventory approval even when binaries and module pins are unchanged', async t => {
  const root = await temporary(t), nodeDirectory = join(root, 'node'), goDirectory = join(root, 'go');
  await mkdir(join(nodeDirectory, 'bin'), { recursive: true });
  const node = join(nodeDirectory, 'bin/node'), go = await syntheticGoToolchain(goDirectory);
  await copyFile(process.execPath, node);
  await copyFile(resolve(process.execPath, '../../LICENSE'), join(nodeDirectory, 'LICENSE'));
  let sequence = 0;
  const inventory = async () => {
    const path = join(root, `inventory-${sequence++}.json`);
    const result = spawnSync(node, [join(import.meta.dirname, '../spikes/distribution/build-macos.mjs'), '--inventory', go, path],
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(path), value = JSON.parse(bytes);
    assert.equal(result.stdout.trim(), sha256(bytes));
    return { digest: sha256(bytes), value };
  };
  const baseline = await inventory();
  const approval = syntheticApproval(baseline.value);
  validateDependencyApproval(approval, baseline.value);
  for (const path of [join(nodeDirectory, 'LICENSE'), join(goDirectory, 'LICENSE'), join(goDirectory, 'PATENTS')]) {
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('\nchanged test notice')]));
    const changed = await inventory();
    assert.notEqual(changed.digest, baseline.digest);
    assert.throws(() => validateDependencyApproval(approval, changed.value), /exact dependency inventory/);
    assert.equal(changed.value.node.sha256, baseline.value.node.sha256);
    assert.equal(changed.value.goToolchain.sha256, baseline.value.goToolchain.sha256);
    assert.deepEqual(changed.value.modules, baseline.value.modules);
    await writeFile(path, original);
  }
  assert.equal((await inventory()).digest, baseline.digest);
  await rm(join(goDirectory, 'LICENSE'));
  await assert.rejects(dependencyInventory(join(import.meta.dirname, '..'), { goExecutable: go }), /toolchain input missing/);
});

test('new Go imports and ignored source inputs invalidate approval without changing pins, notices or tools', async t => {
  const f = await dependencyFixture(t);
  await writeFile(join(f.root, '.gitignore'), 'ignored.go\n');
  assert.equal(spawnSync('/usr/bin/git', ['init', '-q', f.root], { env: { PATH: '/usr/bin:/bin' } }).status, 0);
  const baseline = await f.inventory(), approval = syntheticApproval(baseline);
  validateDependencyApproval(approval, baseline);
  const original = await readFile(f.source);
  await writeFile(f.source, original.toString().replace('import "fmt"', 'import "fmt"\nimport _ "golang.org/x/crypto/ssh"'));
  const changed = await f.inventory();
  assert.notEqual(changed.goBuild.inputs.sha256, baseline.goBuild.inputs.sha256);
  assert.deepEqual(changed.modules, baseline.modules);
  assert.deepEqual(changed.goToolchain, baseline.goToolchain);
  assert.deepEqual(changed.node, baseline.node);
  assert.equal(changed.noticesDigest, baseline.noticesDigest);
  assert.equal(changed.goModDigest, baseline.goModDigest);
  assert.equal(changed.goSumDigest, baseline.goSumDigest);
  assert.throws(() => validateDependencyApproval(approval, changed), /exact dependency inventory/);
  await writeFile(f.source, original);
  const ignored = join(f.moduleRoot, 'cmd/verify/ignored.go');
  await writeFile(ignored, 'package main\nimport _ "golang.org/x/crypto/openpgp"\n');
  assert.equal(spawnSync('/usr/bin/git', ['check-ignore', ignored], { cwd: f.root, env: { PATH: '/usr/bin:/bin' } }).status, 0);
  const added = await f.inventory();
  assert.ok(added.goBuild.inputs.files.some(file => file.path === 'cmd/verify/ignored.go'));
  assert.throws(() => validateDependencyApproval(approval, added), /exact dependency inventory/);
  await rm(ignored);
  assert.deepEqual(await f.inventory(), baseline);
  for (const mutate of [
    inventory => { inventory.goBuild.commands.push({ binary: 'extra', package: './cmd/extra' }); },
    inventory => { inventory.goBuild.flags.push('-tags=extra'); },
    ...['GOOS', 'GOARCH', 'CGO_ENABLED', 'GOARM64', 'GOWORK', 'GOEXPERIMENT'].map(name =>
      inventory => { inventory.goBuild.environment[name] = 'changed'; }),
  ]) {
    const changedPlan = structuredClone(baseline); mutate(changedPlan);
    assert.throws(() => validateDependencyApproval(approval, changedPlan), /exact dependency inventory/);
  }
  await writeFile(join(f.moduleRoot, 'go.mod'), `${await readFile(join(f.moduleRoot, 'go.mod'), 'utf8')}\nreplace golang.org/x/crypto => /outside/unreviewed\n`);
  await assert.rejects(f.inventory(), /module replacements/);
});

test('Go compiler, linker, standard library and other extracted inputs invalidate the prior approval', async t => {
  const f = await dependencyFixture(t), baseline = await f.inventory(), approval = syntheticApproval(baseline);
  for (const path of ['pkg/tool/darwin_arm64/compile', 'pkg/tool/darwin_arm64/link', 'pkg/tool/darwin_arm64/asm',
    'pkg/tool/darwin_arm64/cgo', 'src/runtime/runtime.go', 'pkg/include/textflag.h', 'lib/time/zoneinfo.zip', 'go.env']) {
    const absolute = join(f.goRoot, path), original = await readFile(absolute);
    await writeFile(absolute, Buffer.concat([original, Buffer.from('\nchanged synthetic build input')]));
    const changed = await f.inventory();
    assert.equal(changed.goToolchain.sha256, baseline.goToolchain.sha256);
    assert.deepEqual(changed.goBuild, baseline.goBuild);
    assert.deepEqual(changed.modules, baseline.modules);
    assert.notEqual(changed.goToolchain.inputs.sha256, baseline.goToolchain.inputs.sha256);
    assert.throws(() => validateDependencyApproval(approval, changed), /exact dependency inventory/);
    await writeFile(absolute, original);
  }
  assert.deepEqual(await f.inventory(), baseline);
  await rm(join(f.goRoot, 'pkg/tool/darwin_arm64/compile'));
  await assert.rejects(f.inventory(), /toolchain input missing/);
});

test('build input inventories reject linked roots, directories, files and special files', async t => {
  const f = await dependencyFixture(t);
  for (const path of [f.goExecutable, join(f.goRoot, 'pkg/tool'), join(f.goRoot, 'src/runtime/runtime.go'),
    f.source, f.moduleRoot]) {
    const saved = join(f.directory, 'saved-input');
    await rename(path, saved); await symlink(saved, path);
    await assert.rejects(f.inventory(), /link/);
    await rm(path); await rename(saved, path);
  }
  const linkedRoot = join(f.directory, 'linked-go'); await symlink(f.goRoot, linkedRoot);
  await assert.rejects(dependencyInventory(f.root, { goExecutable: join(linkedRoot, 'bin/go') }), /link/);
  for (const path of [f.goExecutable, join(f.goRoot, 'pkg/tool/darwin_arm64/compile'), f.source]) {
    const hardLink = join(f.directory, 'outside-hard-link'); await link(path, hardLink);
    await assert.rejects(f.inventory(), /link/);
    await rm(hardLink);
  }
  for (const directory of [f.goRoot, f.moduleRoot]) {
    const fifo = join(directory, 'synthetic-fifo');
    assert.equal(spawnSync('/usr/bin/mkfifo', [fifo], { env: { PATH: '/usr/bin:/bin' } }).status, 0);
    await assert.rejects(f.inventory(), /special files/);
    await rm(fifo);
  }
});

test('release channel gating keeps production strict and makes candidates non-production', () => {
  const key = generateKeyPairSync('ed25519'), common = {
    sequence: 2, version: '1.2.0', teamId: 'TESTTEAM01', updateOrigin: 'https://updates.example',
    updatePublicKey: key.publicKey.export({ format: 'jwk' }).x, signingIdentity: 'Developer ID Application: Test',
    notaryProfile: 'private-provenance-notary', helperProvisioningProfile: '/tmp/test-helper.provisionprofile',
    updatePrivateKeyFile: '/tmp/test-update-key', dependencyApprovalFile: '/tmp/test-approval.json',
    goExecutable: '/usr/bin/go', goModuleCache: '/tmp/test-go-cache',
  };
  const candidate = validateBuildConfig({ ...common, releaseChannel: RELEASE_CHANNELS.CANDIDATE, storeListingVerified: false });
  assert.deepEqual(releaseArtifactContract({ ...common, releaseChannel: RELEASE_CHANNELS.CANDIDATE, storeListingVerified: false }), {
    releaseChannel: RELEASE_CHANNELS.CANDIDATE, releaseClass: 'RELEASE_CANDIDATE',
    stableManifestCreated: false, updaterEnabled: false, installedProductionState: false,
    artifactName: 'Attestamp-Release-Candidate-1.2.0-2.dmg', stableManifest: null,
    bundledInstalledRelease: null, updaterAvailable: false, promotion: 'FRESH_PRODUCTION_BUILD_REQUIRED',
  });
  assert.deepEqual(releaseBuildPlan({ releaseChannel: RELEASE_CHANNELS.CANDIDATE }), {
    releaseChannel: RELEASE_CHANNELS.CANDIDATE, releaseClass: 'RELEASE_CANDIDATE',
    stableManifestCreated: false, updaterEnabled: false, installedProductionState: false,
  });
  assert.equal(candidate.profile, RELEASE_CANDIDATE_PROFILE);
  assert.equal(candidate.releaseChannel, RELEASE_CHANNELS.CANDIDATE);
  assert.equal(candidate.storeListingVerified, false);
  assert.throws(() => validateInstalledRelease(candidate), /Unknown\/missing fields|INVALID/);
  assert.throws(() => validateReleaseCandidate({ ...candidate, storeListingVerified: true }), /INVALID_RELEASE_CANDIDATE/);
  assert.throws(() => validateBuildConfig({ ...common, releaseChannel: RELEASE_CHANNELS.PRODUCTION, storeListingVerified: false }), /RELEASE_PROVISIONING_REQUIRED/);
  const production = validateBuildConfig({ ...common, releaseChannel: RELEASE_CHANNELS.PRODUCTION, storeListingVerified: true });
  assert.deepEqual(releaseBuildPlan({ releaseChannel: RELEASE_CHANNELS.PRODUCTION }), {
    releaseChannel: RELEASE_CHANNELS.PRODUCTION, releaseClass: 'PRODUCTION',
    stableManifestCreated: true, updaterEnabled: true, installedProductionState: true,
  });
  assert.equal(production.profile, 'pap-installed-release/1');
  assert.equal(validateInstalledRelease(production).storeListingVerified, true);
});

test('release-candidate lifecycle state is isolated from the production rollback floor', async t => {
  const root = await temporary(t);
  const candidate = await new InstallationLifecycle({ supportDirectory: join(root, 'support'),
    chromeSupportDirectory: join(root, 'chrome-test-only'), browserHost: join(root, 'Test.app/Contents/MacOS/host'),
    sequence: 12, releaseChannel: RELEASE_CHANNELS.CANDIDATE }).init();
  await candidate.enable();
  const status = await candidate.status();
  assert.equal(status.releaseChannel, RELEASE_CHANNELS.CANDIDATE);
  assert.equal(status.releaseClass, 'RELEASE_CANDIDATE');
  assert.equal(candidate.diagnostics().releaseClass, 'RELEASE_CANDIDATE');
  assert.equal(candidate.diagnostics().releaseChannel, RELEASE_CHANNELS.CANDIDATE);
  const restartedCandidate = await new InstallationLifecycle({ supportDirectory: join(root, 'support'),
    chromeSupportDirectory: join(root, 'chrome-test-only'), browserHost: join(root, 'Test.app/Contents/MacOS/host'),
    sequence: 12, releaseChannel: RELEASE_CHANNELS.CANDIDATE }).init();
  assert.equal(restartedCandidate.highestSeen, 12);
  assert.equal((await restartedCandidate.status()).integration, 'ENABLED');
  const production = await installation(root, 2).init();
  assert.equal(production.highestSeen, 2);
  await assert.rejects(installation(root, 1).init(), /APPLICATION_ROLLBACK/);
  assert.equal(JSON.parse(await readFile(join(root, 'support/installation.release-candidate.json'))).profile,
    'pap-release-candidate-installation/1');
  assert.equal(JSON.parse(await readFile(join(root, 'support/installation.release-candidate.json'))).highestSeen, 12);
  assert.equal(JSON.parse(await readFile(join(root, 'support/installation.json'))).highestSeen, 2);
});

test('release-candidate UI and diagnostics expose the non-production boundary', async () => {
  const app = await readFile(new URL('../spikes/browser/chatgpt/product-app.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../spikes/browser/chatgpt/product.html', import.meta.url), 'utf8');
  assert.match(page, /id="release-channel"/);
  assert.match(app, /releaseChannel === 'release-candidate'/);
  assert.match(app, /stable updates are disabled/);
  assert.match(app, /releaseChannel === 'production'/);
});

test('installation actions require the paired composer and support output cannot reflect request data', async t => {
  const root = await temporary(t), lifecycle = await installation(root).init();
  const server = await startProductComposer({ session: {}, browserState: () => null, maintenance: {
    status: () => lifecycle.status(), enable: () => lifecycle.enable(),
    offerExport: () => lifecycle.record('exportOffered'), remove: data => lifecycle.remove(data),
    diagnostics: () => lifecycle.diagnostics(),
  } });
  t.after(() => server.close());
  const secret = new URL(server.url).hash.slice(1);
  const call = (name, data = {}, token = secret) => fetch(`${server.origin}/installation/${name}`, {
    method: 'POST', headers: { Origin: server.origin, Authorization: `Bearer ${token}` }, body: JSON.stringify(data),
  });
  assert.equal((await call('enable', {}, 'unpaired')).status, 400);
  assert.equal((await lifecycle.status()).integration, 'DISABLED');
  assert.equal((await call('enable')).status, 200);
  assert.equal((await call('remove', { exportDecision: 'keep-local' })).status, 400);
  await call('export-opportunity'); assert.equal((await call('remove', { exportDecision: 'keep-local' })).status, 200);
  const response = await call('diagnostics', { privateText: 'NEVER_ECHO_THIS', url: 'https://chatgpt.com/c/secret' });
  const body = await response.text(); assert.equal(response.status, 200);
  assert.doesNotMatch(body, /NEVER_ECHO_THIS|chatgpt\.com|secret|privateText/);
});
