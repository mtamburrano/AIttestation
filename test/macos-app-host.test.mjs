import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { startChromeProtectionRuntime } from '../spikes/browser/chatgpt/bridge-runtime.mjs';
import { NATIVE_BRIDGE_PROFILE } from '../spikes/browser/chatgpt/native-host.mjs';
import { canonical } from '../spikes/vault/format.mjs';

test('packaged ChatGPT path uses fixed signed hosts and withholds raw Keychain authority', { skip: process.platform !== 'darwin' }, async t => {
  const root = realpathSync(mkdtempSync('/private/tmp/provenance-native-boundary-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'isolated-build');
  const build = spawnSync(process.execPath, ['spikes/browser/chatgpt/build-macos.mjs', output], {
    cwd: import.meta.dirname + '/..', env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
  const app = join(output, 'Private Provenance.app'), node = join(app, 'Contents/MacOS/node');
  const host = join(app, 'Contents/MacOS/provenance-app-host');
  const helper = join(app, 'Contents/MacOS/provenance-keychain-helper');
  const browserHost = join(app, 'Contents/MacOS/provenance-browser-host');
  const peerValidator = join(app, 'Contents/MacOS/provenance-bridge-peer-validator');
  const lifecycle = join(app, 'Contents/Resources/spikes/vault/key-lifecycle.mjs');
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
  assert.deepEqual(nativeManifest.allowed_origins, ['chrome-extension://hdnjjomhchcpcnikfabcnmlhcehbnhbc/']);
  const rejectedBrowserParent = spawnSync(browserHost,
    ['chrome-extension://hdnjjomhchcpcnikfabcnmlhcehbnhbc/'], { env: {}, encoding: 'utf8', timeout: 15000 });
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
      extensionOrigin: 'chrome-extension://hdnjjomhchcpcnikfabcnmlhcehbnhbc/',
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
});
