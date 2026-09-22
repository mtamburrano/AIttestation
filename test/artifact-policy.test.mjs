import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyDistribution } from '../spikes/distribution/verify-artifacts.mjs';
import { artifactJSON, bundleInfo, storeArchive } from '../spikes/distribution/artifact-files.mjs';
import { fileInventory } from '../spikes/distribution/inventory.mjs';
import { readOnlyCommand } from '../spikes/distribution/local.mjs';
import { createChromeWebStoreUpload } from '../spikes/distribution/build-macos.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { sha256 } from '../spikes/distribution/release.mjs';
import { fixture, app, verifier, resources, distribution, extension, helper, zip, now } from './artifact-policy-fixture.mjs';

const cli = new URL('../spikes/distribution/verify-artifacts.mjs', import.meta.url).pathname;
function rejected(report, stage) {
  assert.equal(report.status, 'FAILED', JSON.stringify(report));
  if (stage) assert.equal(report.failure, `${stage}_REJECTED`);
  const index = report.checks.findIndex(item => item.status === 'FAILED');
  assert.ok(index >= 0); assert.ok(report.checks.slice(index + 1).every(item => item.status === 'NOT_RUN'));
  assert.equal(report.sourceDigest, null); assert.equal(report.dependencyDigest, null); assert.equal(report.updaterEnabled, null);
  assert.equal(report.releaseReady, false); assert.ok(JSON.stringify(report).length < 2048);
}

test('independent synthetic development, RC and production outputs pass without installation or input writes', async t => {
  for (const channel of ['development', 'release-candidate', 'production']) {
    const f = await fixture(t, channel), before = await fileInventory(f.output), report = await f.run();
    assert.equal(report.status, 'PASSED', JSON.stringify(report)); assert.equal(report.releaseChannel, channel);
    assert.equal(report.sourceDigest, f.policy.sourceDigest); assert.equal(report.updaterEnabled, channel === 'production');
    assert.equal(report.appleTrust, 'NOT_CHECKED'); assert.equal(report.diskImageContents, 'NOT_INSPECTED');
    assert.equal(report.releaseReady, false); assert.deepEqual(await fileInventory(f.output), before);
    if (channel !== 'production') assert.ok(!before.some(file => file.path === 'stable.json'));
  }
});

test('expected policy rejects implicit channels, missing trust roots and stale reviewed source/version/sequence', async t => {
  for (const mutate of [p => { delete p.releaseChannel; }, p => { delete p.sourceDigest; }, p => { delete p.updatePublicKey; },
    p => { p.releaseChannel = 'unknown'; }, p => { p.sourceDigest = '0'.repeat(64); }, p => { p.sequence++; },
    p => { p.version = '9.9.9'; }, p => { p.teamId = 'OTHERTEAM1'; }, p => { p.updateOrigin = 'https://other.example.invalid'; },
    p => { p.updatePublicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x; }]) {
    const f = await fixture(t); mutate(f.policy); rejected(await f.run());
  }
});

test('RC rejects production state, stable manifests and contradictory update or channel claims', async t => {
  for (const change of [
    f => f.json('stable.json', {}), f => f.json(`${distribution}/stable.json`, {}),
    f => f.json(`${distribution}/installed-release.json`, { profile: 'pap-installed-release/1' }),
    async f => { const m = await f.readJSON('build-measurement.json'); m.updaterEnabled = true; await f.json('build-measurement.json', m); },
    async f => { const m = await f.readJSON('release-candidate.json'); m.sequence++; await f.json('release-candidate.json', m); },
    async f => { f.provenance.releaseChannel = 'production'; await f.seal(); },
    async f => { f.provenance.notarized = false; await f.seal(); },
    f => f.write('Private-Provenance-1.2.0-4.dmg', 'stale installer'),
    f => f.write('Start Here.md', 'Production release'),
  ]) { const f = await fixture(t); await change(f); rejected(await f.run(), 'CHANNEL_CONTRACT'); }
});

test('production requires every production file and rejects candidate and development leftovers', async t => {
  for (const path of ['stable.json', 'notarization.json', 'Private-Provenance-1.2.0-4.dmg', `${distribution}/installed-release.json`]) {
    const f = await fixture(t, 'production'); await rm(join(f.output, path)); rejected(await f.run(), 'CHANNEL_CONTRACT');
  }
  for (const path of ['release-candidate.json', `${distribution}/release-candidate.json`]) {
    const f = await fixture(t, 'production'); await f.json(path, {}); rejected(await f.run(), 'CHANNEL_CONTRACT');
  }
  const f = await fixture(t, 'development'); f.provenance.signature = 'DEVELOPER_ID'; await f.seal(); rejected(await f.run(), 'CHANNEL_CONTRACT');
});

test('production authenticates exact provenance, inventory and disk image with the external root and freshness policy', async t => {
  for (const mutate of [f => { f.release.provenanceDigest = '0'.repeat(64); }, f => { f.release.dependencyDigest = '0'.repeat(64); },
    f => { f.release.sequence++; }, f => { f.release.maximumSchema = 4; },
    f => { f.release.expiresAt = new Date(now - 1000).toISOString(); },
    f => { f.release.publishedAt = new Date(now + 3600_000).toISOString(); },
    f => { f.release.artifact.sha256 = '0'.repeat(64); }, f => { f.release.artifact.bytes++; }]) {
    const f = await fixture(t, 'production'); mutate(f); await f.signStable(); rejected(await f.run(), 'PRODUCTION_SIGNATURE');
  }
  const f = await fixture(t, 'production'), envelope = await f.readJSON('stable.json');
  envelope.signature = 'A'.repeat(86); await f.json('stable.json', envelope); rejected(await f.run(), 'PRODUCTION_SIGNATURE');
});

test('inventories reject omitted, extra, duplicate, changed and internally stale source/dependency entries', async t => {
  for (const change of [
    async f => { f.provenance.bundles.application.pop(); await f.json('build-provenance.json', f.provenance); },
    async f => { f.provenance.bundles.verifier.push(f.provenance.bundles.verifier[0]); await f.json('build-provenance.json', f.provenance); },
    f => f.write(`${resources}/spikes/browser/chatgpt/runtime-main.mjs`, '// tampered updater code'),
    async f => { await f.write(`${resources}/spikes/browser/chatgpt/runtime-main.mjs`, '// tampered updater code'); await f.seal(); },
    async f => { f.provenance.source.files.pop(); await f.seal(); },
    async f => { f.inventory.goBuild.inputs.files[0].sha256 = '0'.repeat(64);
      f.provenance.dependencyDigest = sha256(canonical(f.inventory)); await f.json('dependency-inventory.json', f.inventory); await f.seal(); },
    f => f.write(`${verifier}/Contents/Resources/Node-LICENSE.txt`, 'stale copied license'),
  ]) { const f = await fixture(t); await change(f); rejected(await f.run(), 'INVENTORY_LINKAGE'); }
});

test('missing app and recipient imports or assets reject even after inventories and production signatures are refreshed', async t => {
  for (const channel of ['development', 'release-candidate', 'production']) {
    const f = await fixture(t, channel), policy = structuredClone(f.policy);
    assert.equal((await f.run()).status, 'PASSED');
    for (const path of [
      `${resources}/spikes/browser/chatgpt/bridge-runtime.mjs`, `${resources}/spikes/browser/chatgpt/dashboard.html`,
      `${resources}/spikes/managed/client.mjs`, `${extension}/content-script.js`,
      `${verifier}/Contents/Resources/spikes/recipient/server.mjs`, `${verifier}/Contents/Resources/spikes/recipient/recipient.css`,
      `${verifier}/Contents/Resources/spikes/recipient/chatgpt-route.mjs`,
      `${verifier}/Contents/Resources/spikes/vault/records.mjs`,
      `${verifier}/Contents/Resources/spikes/anchor/native-verifier.mjs`,
    ]) {
      const bytes = await readFile(join(f.output, path));
      await rm(join(f.output, path)); await f.seal();
      assert.deepEqual(f.policy, policy);
      rejected(await f.run(), 'INVENTORY_LINKAGE');
      await f.write(path, bytes);
    }
    await f.seal(); assert.equal((await f.run()).status, 'PASSED');
  }
});

test('reviewed copy exclusions stay absent and cannot be added to either bundle with a refreshed inventory', async t => {
  const f = await fixture(t), bytes = 'Synthetic non-shipping source';
  const excluded = ['spikes/browser/chatgpt/testdata/fixture.json', 'spikes/browser/chatgpt/.DS_Store',
    'spikes/managed/server.mjs', 'test/fixture.mjs', 'package.json'];
  for (const path of excluded) f.source.files.push({ path, sha256: sha256(bytes) });
  f.source.files.sort((a, b) => a.path < b.path ? -1 : 1);
  f.policy.sourceDigest = f.source.sha256 = sha256(canonical(f.source.files));
  await f.seal(); assert.equal((await f.run()).status, 'PASSED');
  const policy = structuredClone(f.policy);
  for (const [base, path] of [[resources, 'spikes/managed/server.mjs'],
    [`${verifier}/Contents/Resources`, 'spikes/browser/chatgpt/adapter.mjs']]) {
    await f.write(`${base}/${path}`, path === 'spikes/managed/server.mjs' ? bytes
      : await readFile(join(f.output, resources, path)));
    await f.seal(); assert.deepEqual(f.policy, policy); rejected(await f.run(), 'INVENTORY_LINKAGE');
    await rm(join(f.output, base, path));
    // Remove only the empty directories created for this excluded test resource.
    if (base !== resources) await rm(join(f.output, base, 'spikes/browser'), { recursive: true });
  }
});

test('escaped duplicate JSON cannot hide credentials or evidence in any prepared release channel', async t => {
  const marker = 'PRIVATE-DUPLICATE-TEST-DATA';
  const payloads = [String.raw`{"api_\u006bey":"${marker}","api_key":null}`,
    String.raw`{"evidence":"\u0041TTESTAMP_SYNTHETIC_EVIDENCE_V1:${marker}","evidence":null}`];
  for (const channel of ['development', 'release-candidate', 'production']) {
    const f = await fixture(t, channel); assert.equal((await f.run()).status, 'PASSED');
    for (const payload of payloads) {
      await f.write('Start Here.md', payload); await f.seal();
      const report = await f.run(); rejected(report, 'OUTPUT_FILES');
      assert.equal(report.packageLeak.category, 'AMBIGUOUS_JSON');
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE-DUPLICATE|ATTESTAMP_SYNTHETIC|Start Here/);
    }
  }
});

test('bundle identities, version, helper placement and candidate Finder labels are checked after rehashing', async t => {
  for (const [path, old, replacement] of [
    [`${app}/Contents/Info.plist`, 'ai.provenance.consumer.host', 'ai.provenance.wrong.host'],
    [`${verifier}/Contents/Info.plist`, '<string>4</string>', '<string>3</string>'],
    [`${helper}/Contents/Info.plist`, 'ai.provenance.keychain-helper', 'ai.provenance.wrong-helper'],
    [`${app}/Contents/Info.plist`, 'Attestamp Release Candidate', 'Attestamp'],
  ]) {
    const f = await fixture(t); await f.write(path, (await readFile(join(f.output, path), 'utf8')).replace(old, replacement));
    await f.seal(); rejected(await f.run(), 'BUNDLE_IDENTITIES');
  }
  const f = await fixture(t); await rm(join(f.output, helper, 'Contents/embedded.provisionprofile')); await f.seal();
  rejected(await f.run(), 'BUNDLE_IDENTITIES');
  const inaccessible = await fixture(t); await chmod(join(inaccessible.output, app, 'Contents/MacOS/node'), 0o600);
  rejected(await inaccessible.run(), 'BUNDLE_IDENTITIES');
});

test('Store identity, native origin, upload-key omission and extension-byte parity fail closed', async t => {
  for (const change of [
    async f => { const m = await f.readJSON('NativeMessagingHosts/ai.provenance.consumer.json'); m.allowed_origins = ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']; await f.json('NativeMessagingHosts/ai.provenance.consumer.json', m); },
    async f => { const entries = structuredClone(f.storeEntries); entries.find(([p]) => p === 'manifest.json')[1] = canonical(await f.readJSON(`${extension}/manifest.json`)); await f.write('Chrome-Web-Store-upload.zip', zip(entries)); },
    async f => { const entries = structuredClone(f.storeEntries); entries.find(([p]) => p === 'service-worker.js')[1] = 'tampered'; await f.write('Chrome-Web-Store-upload.zip', zip(entries)); },
    async f => { const path = `${extension}/manifest.json`, m = await f.readJSON(path); m.key = Buffer.from('wrong public key').toString('base64');
      await f.json(path, m); f.source.files.find(item => item.path.endsWith('/extension/manifest.json')).sha256 = sha256(canonical(m));
      f.policy.sourceDigest = f.source.sha256 = sha256(canonical(f.source.files)); await f.seal(); },
  ]) { const f = await fixture(t); await change(f); rejected(await f.run(), 'STORE_PACKAGE'); }
});

test('panel permission, entrypoint and isolation policy reject even a consistently resealed package', async t => {
  for (const change of [
    manifest => manifest.permissions.push('tabs'),
    manifest => { manifest.permissions = ['nativeMessaging']; },
    manifest => { manifest.side_panel.default_path = 'content-script.js'; },
    manifest => { manifest.content_security_policy.extension_pages += '; connect-src *'; },
    manifest => { manifest.web_accessible_resources = [{ resources: ['sidepanel.html'], matches: ['https://chatgpt.com/*'] }]; },
    manifest => { manifest.externally_connectable = { matches: ['https://chatgpt.com/*'] }; },
  ]) {
    const f = await fixture(t), path = `${extension}/manifest.json`, manifest = await f.readJSON(path);
    change(manifest); await f.json(path, manifest);
    f.source.files.find(item => item.path.endsWith('/extension/manifest.json')).sha256 = sha256(canonical(manifest));
    f.policy.sourceDigest = f.source.sha256 = sha256(canonical(f.source.files));
    const { key: _key, ...upload } = manifest, entries = structuredClone(f.storeEntries);
    entries.find(([name]) => name === 'manifest.json')[1] = canonical(upload);
    await f.write('Chrome-Web-Store-upload.zip', zip(entries)); await f.seal();
    rejected(await f.run(), 'STORE_PACKAGE');
  }
});

test('known secret filenames and renamed PEM, DER, JWK, token and approval data are rejected without leaking contents', async t => {
  const key = generateKeyPairSync('ed25519'), marker = 'NEVER-PRINT-THIS-PRIVATE-MARKER';
  for (const [path, bytes] of [
    ['update.key', marker], ['approval.json', JSON.stringify({ inventoryDigest: 'a'.repeat(64), reviewer: marker, securityApproved: true })],
    ['renamed.txt', key.privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['opaque.dat', key.privateKey.export({ type: 'pkcs8', format: 'der' })],
    ['renamed.json', JSON.stringify({ key: key.privateKey.export({ format: 'jwk' }) })],
    ['opaque.txt', JSON.stringify({ access_token: marker })], ['.env', marker], ['release-config.json', '{}'],
  ]) {
    const f = await fixture(t); await f.write(`${resources}/${path}`, bytes); await f.seal();
    const report = await f.run(); rejected(report, 'OUTPUT_FILES'); assert.ok(!JSON.stringify(report).includes(marker));
  }
  const f = await fixture(t); await f.write('Chrome-Web-Store-upload.zip', zip([...f.storeEntries,
    ['hidden.txt', key.privateKey.export({ type: 'pkcs8', format: 'pem' })]], { compressed: true }));
  rejected(await f.run(), 'OUTPUT_FILES');
});

test('redirected roots, files, directories, hard links, special files and leftover staging fail closed', async t => {
  for (const kind of ['file', 'directory', 'hardlink', 'fifo', 'extra-directory']) {
    const f = await fixture(t), target = join(f.directory, 'unrelated-test-marker'); await writeFile(target, 'untouched');
    const path = join(f.output, 'unexpected');
    if (kind === 'file') await symlink(target, path);
    if (kind === 'directory') await symlink(f.directory, path);
    if (kind === 'hardlink') await link(target, path);
    if (kind === 'fifo') assert.equal(spawnSync('/usr/bin/mkfifo', [path], { env: {} }).status, 0);
    if (kind === 'extra-directory') await mkdir(path);
    rejected(await f.run(), kind === 'extra-directory' ? 'CHANNEL_CONTRACT' : 'OUTPUT_FILES');
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  }
  const f = await fixture(t), alias = join(f.directory, 'linked-output'); await symlink(f.output, alias);
  rejected(await verifyDistribution(alias, f.policy), 'OUTPUT_FILES');
});

test('small parsers reject duplicate JSON/plist fields and ambiguous, linked, oversized or traversing ZIP entries', () => {
  assert.throws(() => artifactJSON(Buffer.from('{"a":1,"\\u0061":2}')));
  assert.deepEqual(artifactJSON(Buffer.from('{"a":"{quoted}","child":{"a":2}}')), { a: '{quoted}', child: { a: 2 } });
  assert.throws(() => bundleInfo(Buffer.from('<plist version="1.0"><dict><key>a</key><string>x</string><key>a</key><string>y</string></dict></plist>')));
  for (const options of [{}, { compressed: true }, { compressed: true, descriptor: true }]) {
    assert.equal(storeArchive(zip([['manifest.json', '{}']], options)).get('manifest.json').toString(), '{}');
  }
  for (const entries of [[['../escape', 'x']], [['/absolute', 'x']], [['same', 'a'], ['same', 'b']], [['Case', 'a'], ['case', 'b']]]) {
    assert.throws(() => storeArchive(zip(entries)));
  }
  for (const mutate of [
    b => b.writeUInt16LE(1, 6), b => b.writeUInt32LE(0, 14),
    b => { const c = b.readUInt32LE(b.length - 6); b.writeUInt32LE((0o120777 << 16) >>> 0, c + 38); },
    b => { const c = b.readUInt32LE(b.length - 6); b.writeUInt32LE(100_000_000, c + 24); },
    b => { b[30] = 'x'.charCodeAt(0); },
  ]) { const bytes = zip([['manifest.json', '{}']]); mutate(bytes); assert.throws(() => storeArchive(bytes)); }
  assert.throws(() => storeArchive(Buffer.concat([zip([['ok', 'x']]), Buffer.from('trailing')])));
});

test('CLI uses only an explicit public policy and emits bounded failures with no private paths or raw errors', async t => {
  const f = await fixture(t), policy = join(f.directory, 'public-policy.json'); await writeFile(policy, canonical(f.policy));
  const result = spawnSync(process.execPath, [cli, f.output, policy], { env: {}, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'PASSED');
  await writeFile(policy, '{"secret":"PRIVATE-POLICY-MARKER","sourceDigest":"invalid"}');
  const failure = spawnSync(process.execPath, [cli, f.output, policy], { env: {}, encoding: 'utf8', timeout: 15_000 });
  assert.equal(failure.status, 1); assert.doesNotMatch(failure.stdout + failure.stderr, /PRIVATE-POLICY-MARKER|\/private\/tmp|Error:/);
  const usage = spawnSync(process.execPath, [cli], { env: {}, encoding: 'utf8', timeout: 15_000 });
  assert.equal(usage.status, 1); assert.equal(JSON.parse(usage.stdout).failure, 'USAGE_REQUIRES_OUTPUT_AND_PUBLIC_POLICY');
});

test('CLI passes with filesystem writes, network, Mach lookups and Apple Events denied', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), policy = join(f.directory, 'public-policy.json'); await writeFile(policy, canonical(f.policy));
  const before = await fileInventory(f.directory);
  assert.equal(JSON.parse(readOnlyCommand(process.execPath, [cli, f.output, policy])).status, 'PASSED');
  assert.deepEqual(await fileInventory(f.directory), before);
});

test('actual ditto Store output remains readable without extraction', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await rm(join(f.output, 'Chrome-Web-Store-upload.zip'));
  const path = await createChromeWebStoreUpload(f.output), files = storeArchive(await readFile(path));
  assert.equal(artifactJSON(files.get('manifest.json')).key, undefined);
  const source = await fileInventory(new URL('../spikes/browser/chatgpt/extension', import.meta.url).pathname);
  assert.deepEqual([...files.keys()].sort(), source.map(item => item.path).sort());
});
