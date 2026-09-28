import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PRIVATE_ACCEPTANCE_SUPPORT, privateAcceptanceArtifactSources,
  privateAcceptanceHookSocketPath } from '../spikes/development/namespace-artifact.mjs';
import { PRIVATE_ACCEPTANCE_NAMESPACE } from '../spikes/development/environment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('private acceptance artifact binds every native rendezvous and lock to its fresh support directory', async () => {
  const specialized = privateAcceptanceArtifactSources({
    host: await readFile(join(root, 'spikes/vault/native/macos-app-host.swift'), 'utf8'),
    hookReceiver: await readFile(join(root, 'spikes/coding/native/macos-hook-receiver.swift'), 'utf8'),
    chromeRelay: await readFile(join(root, 'spikes/browser/chatgpt/native-host.mjs'), 'utf8'),
    firefoxRelay: await readFile(join(root, 'spikes/browser/firefox/native-host.mjs'), 'utf8'),
  }, PRIVATE_ACCEPTANCE_NAMESPACE);
  const retainedPath = 'Library/Application Support/Private Provenance';

  assert.ok(specialized.host.includes(`.appendingPathComponent(".attestamp-private-acceptance-${PRIVATE_ACCEPTANCE_NAMESPACE}/support", isDirectory: true)`));
  assert.ok(specialized.host.includes('application.lock'));
  assert.ok(specialized.hookReceiver.includes(`String(cString: home) + "/.attestamp-private-acceptance-${PRIVATE_ACCEPTANCE_NAMESPACE}/support"`));
  assert.ok(specialized.hookReceiver.includes('support + "/coding-bridge.json"'));
  assert.ok(specialized.chromeRelay.includes(`${JSON.stringify(join(PRIVATE_ACCEPTANCE_SUPPORT, 'browser-bridge.json'))}`));
  assert.ok(specialized.firefoxRelay.includes(`${JSON.stringify(join(PRIVATE_ACCEPTANCE_SUPPORT, 'firefox-bridge.json'))}`));
  assert.ok(!specialized.chromeRelay.includes('homedir()'));
  assert.ok(!specialized.firefoxRelay.includes('homedir()'));
  assert.ok(!Object.values(specialized).some(source => source.includes(retainedPath)));
  assert.ok(Buffer.byteLength(privateAcceptanceHookSocketPath()) < 104);
  assert.throws(() => privateAcceptanceArtifactSources({}, 'other'), /UNRECOGNIZED_PRIVATE_ACCEPTANCE_NAMESPACE/);
});
