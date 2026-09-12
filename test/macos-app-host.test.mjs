import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { startChromeProtectionRuntime } from '../spikes/browser/chatgpt/bridge-runtime.mjs';
import { NATIVE_BRIDGE_PROFILE } from '../spikes/browser/chatgpt/native-host.mjs';
import { canonical, parseCanonical } from '../spikes/vault/format.mjs';
import { portableBundle } from '../spikes/recipient/portable.mjs';
import { sourceInventory } from '../spikes/distribution/inventory.mjs';
import { verifyDistribution } from '../spikes/distribution/verify-artifacts.mjs';

test('packaged ChatGPT path uses fixed signed hosts and withholds raw Keychain authority', { skip: process.platform !== 'darwin' }, async t => {
  const root = realpathSync(mkdtempSync('/private/tmp/provenance-native-boundary-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'isolated-build');
  const expectedSource = await sourceInventory(join(import.meta.dirname, '..'));
  const build = spawnSync(process.execPath, ['spikes/distribution/build-macos.mjs', '--prepare', output], {
    cwd: import.meta.dirname + '/..', env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
  const provenance = JSON.parse(readFileSync(join(output, 'build-provenance.json')));
  const dependencies = JSON.parse(readFileSync(join(output, 'dependency-inventory.json')));
  assert.equal(provenance.releaseChannel, 'development'); assert.equal(provenance.releaseClass, 'DEVELOPMENT');
  assert.equal(provenance.signature, 'AD_HOC_ONLY'); assert.equal(provenance.notarized, false);
  assert.equal(provenance.storeListing, 'NOT_PROVISIONED'); assert.equal(provenance.sourceRebuiltNativeTools, false);
  assert.ok(provenance.source.files.some(file => file.path === 'spikes/distribution/updater.mjs'));
  assert.equal(existsSync(join(output, 'Chrome-Web-Store-upload.zip')), true);
  const artifactPolicy = await verifyDistribution(output, { releaseChannel: 'development', sourceDigest: expectedSource.sha256 });
  assert.equal(artifactPolicy.status, 'PASSED', JSON.stringify(artifactPolicy));
  const productionCompile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'swift-release-cache'),
    '-O', '-D', 'PRODUCT_CHATGPT', '-D', 'PRODUCT_RELEASE', '-framework', 'Security',
    join(import.meta.dirname, '../spikes/vault/native/macos-app-host.swift'), '-o', join(root, 'release-host-compile-only')],
  { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(productionCompile.status, 0, productionCompile.stderr);
  const app = join(output, 'Attestamp.app'), node = join(app, 'Contents/MacOS/node');
  const host = join(app, 'Contents/MacOS/provenance-app-host');
  const helper = join(app, 'Contents/MacOS/provenance-keychain-helper');
  const browserHost = join(app, 'Contents/MacOS/provenance-browser-host');
  const peerValidator = join(app, 'Contents/MacOS/provenance-bridge-peer-validator');
  const lifecycle = join(app, 'Contents/Resources/spikes/vault/key-lifecycle.mjs');
  assert.equal(existsSync(join(app, 'Contents/Resources/spikes/managed/client.mjs')), true);
  assert.equal(existsSync(join(app, 'Contents/Resources/spikes/managed/service.mjs')), false);
  assert.equal(existsSync(join(app, 'Contents/Resources/spikes/anchor/algorand/bin/sponsor')), false);
  const identifier = executable => spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', executable], { encoding: 'utf8' }).stderr;
  assert.match(identifier(host), /Identifier=ai\.provenance\.consumer\.host/);
  assert.match(identifier(node), /Identifier=ai\.provenance\.consumer\.runtime/);
  assert.match(identifier(helper), /Identifier=ai\.provenance\.keychain-helper/);
  assert.match(identifier(browserHost), /Identifier=ai\.provenance\.consumer\.browser-host/);
  assert.match(identifier(peerValidator), /Identifier=ai\.provenance\.consumer\.bridge-peer-validator/);
  assert.ok((statSync(browserHost).mode & 0o111) !== 0, 'native messaging host must be executable');
  assert.ok((statSync(peerValidator).mode & 0o111) !== 0, 'peer validator must be executable');
  const nativeManifest = JSON.parse(readFileSync(join(output, 'NativeMessagingHosts/ai.provenance.consumer.json')));
  assert.equal(nativeManifest.path, browserHost);
  assert.deepEqual(nativeManifest.allowed_origins, ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/']);
  const recipient = join(output, 'Recipient/Attestamp Verifier.app');
  const recipientResources = join(recipient, 'Contents/Resources/spikes');
  for (const [bundle, name, id] of [[app, 'Attestamp', 'ai.provenance.consumer.host'],
    [recipient, 'Attestamp Verifier', 'ai.provenance.verifier.host']]) {
    const info = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')],
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).stdout);
    assert.equal(info.CFBundleName, name);
    assert.equal(info.CFBundleIdentifier, id, 'display branding must not change signed bundle identity');
  }
  for (const file of ['Start Here.md', 'Install and remove.md', 'Recipient/Verify locally.md']) {
    const guidance = readFileSync(join(output, file), 'utf8');
    assert.match(guidance, /Attestamp/); assert.doesNotMatch(guidance, /private[ -]?provenance/i);
  }
  assert.equal(nativeManifest.name, 'ai.provenance.consumer');
  assert.equal(nativeManifest.description, 'Private Provenance fixed-purpose ChatGPT bridge');
  for (const bundle of [app, recipient]) {
    const notices = readFileSync(join(bundle, 'Contents/Resources/THIRD_PARTY_NOTICES.md'));
    assert.equal(createHash('sha256').update(notices).digest('hex'), dependencies.noticesDigest);
    assert.equal(createHash('sha256').update(readFileSync(join(bundle, 'Contents/Resources/Node-LICENSE.txt'))).digest('hex'),
      dependencies.node.licenseSha256);
    assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { env: {}, encoding: 'utf8' }).status, 0);
  }
  assert.equal(existsSync(join(recipientResources, 'vault/vault.mjs')), false, 'recipient carries no vault storage/key APIs');
  assert.equal(existsSync(join(recipientResources, 'anchor/algorand/bin/live')), false, 'recipient carries no network/submission tool');
  assert.match(identifier(join(recipient, 'Contents/MacOS/provenance-verifier-host')), /Identifier=ai\.provenance\.verifier\.host/);
  const fixtures = new URL('../spikes/anchor/algorand/proof/testdata/', import.meta.url);
  const disclosure = parseCanonical(readFileSync(new URL('disclosure.json', fixtures)));
  const envelope = parseCanonical(readFileSync(new URL('anchor-envelope.json', fixtures)));
  const checkpoint = JSON.parse(readFileSync(new URL('independent-checkpoint.json', fixtures)));
  const trust = { profile: checkpoint.profile, network: checkpoint.network, genesis: checkpoint.genesis, checkpoint };
  const exportFile = join(root, 'public-recorded-evidence.json'), trustFile = join(root, 'separate-checkpoint.json');
  writeFileSync(exportFile, canonical(portableBundle(disclosure, [envelope]))); writeFileSync(trustFile, JSON.stringify(trust));
  const guard = join(root, 'deny-network.mjs');
  writeFileSync(guard, `import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw Error('NETWORK_FORBIDDEN')};net.connect=net.createConnection=tls.connect=http.request=http.get=https.request=https.get=deny;globalThis.fetch=deny;syncBuiltinESMExports();`);
  const cleanVerification = spawnSync(join(recipient, 'Contents/MacOS/node'), ['--import', guard,
    join(recipientResources, 'recipient/verify.mjs'), exportFile, trustFile], { cwd: root, env: {}, encoding: 'utf8', timeout: 30000 });
  assert.equal(cleanVerification.status, 0, cleanVerification.stderr);
  assert.equal(JSON.parse(cleanVerification.stdout).records[0].anchor, 'CONSENSUS_VERIFIED');
  assert.equal(JSON.parse(cleanVerification.stdout).records[0].timestamp, 'BLOCK_HASH_BOUND');
  const rejectedBrowserParent = spawnSync(browserHost,
    ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/'], { env: {}, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(rejectedBrowserParent.status, 0, 'native host must reject a non-Chrome Stable parent');

  const bridgeDirectory = join(root, 'stolen-token-runtime');
  const bridge = await startChromeProtectionRuntime(bridgeDirectory, {
    vaultKey: randomBytes(32), peerValidatorPath: peerValidator,
    fastTrust: { profile: 'PAP_ALGORAND_FAST_CONFIRM_V1' },
  });
  try {
    const record = JSON.parse(readFileSync(bridge.rendezvousPath, 'utf8'));
    const direct = createConnection(bridge.socketPath); await once(direct, 'connect');
    const directClosed = new Promise(resolve => direct.once('close', resolve));
    direct.on('error', () => {});
    direct.write(`${canonical({ kind: 'PAP_BRIDGE_AUTH', profile: NATIVE_BRIDGE_PROFILE,
      extensionOrigin: 'chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/',
      runtimeEpoch: record.runtimeEpoch, token: record.token })}\n`);
    await directClosed;
    assert.equal(bridge.browserState(), null,
      'same-user direct client must be rejected even with the exact rendezvous token');
  } finally { await bridge.close(); }

  const attack = join(root, 'attacker-selected.mjs');
  writeFileSync(attack, `
    import { spawnSync } from 'node:child_process';
    import { pathToFileURL } from 'node:url';
    const account = 'vault:AAAAAAAAAAAAAAAAAAAAAA:signing:active';
    const request = JSON.stringify({ profile: 'pap-keychain-request/1', operation: 'get',
      service: 'ai.provenance.evidence-vault', account });
    const direct = spawnSync(process.argv[2], [], { input: request, encoding: 'utf8', env: {} });
    const { MacOSKeychainStore } = await import(pathToFileURL(process.argv[3]));
    let brokerError = null;
    try { new MacOSKeychainStore().get(account); } catch (error) { brokerError = error.code; }
    process.stdout.write(JSON.stringify({ helperStatus: direct.status, helperSignal: direct.signal,
      helperOutput: direct.stdout, brokerError }));
  `, { mode: 0o600 });
  const attempted = spawnSync(node, [attack, helper, lifecycle], { env: {}, encoding: 'utf8', timeout: 15000 });
  assert.equal(attempted.error, undefined);
  assert.equal(attempted.status, 0, attempted.stderr);
  const result = JSON.parse(attempted.stdout);
  assert.notEqual(result.helperStatus, 0, 'Keychain helper must reject the general-purpose Node parent');
  assert.equal(result.helperOutput, '');
  assert.equal(result.brokerError, 'UNRECOVERABLE', 'direct Node has no inherited native broker channel');

  appendFileSync(join(app, 'Contents/Resources/spikes/browser/chatgpt/runtime-main.mjs'), '\n// product signature violation\n');
  const altered = spawnSync(host, [], { env: {}, encoding: 'utf8', timeout: 15000 });
  assert.equal(altered.error, undefined);
  assert.notEqual(altered.status, 0, 'native host must reject a modified application entrypoint');
  appendFileSync(join(recipientResources, 'recipient/main.mjs'), '\n// test-only signature violation\n');
  const alteredRecipient = spawnSync(join(recipient, 'Contents/MacOS/provenance-verifier-host'), [], { env: {}, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(alteredRecipient.status, 0, 'recipient host must reject a modified entrypoint before opening any UI');
});
