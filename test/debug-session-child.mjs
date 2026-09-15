import assert from 'node:assert/strict';
import { join } from 'node:path';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { FileKeyStore } from './file-key-store.mjs';
import { publishRuntimeState } from '../spikes/development/runtime-state.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_RELEASE_PROTOCOL, CHATGPT_PAGE_CONTRACT,
  CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { DatabaseSync } from 'node:sqlite';

const [root, mode] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/pap-debug-test-[^/]+$/);
process.umask(0);
const network = restrictFixtureNetwork(root);
let armed = false;
const session = new OwnerDebugSession(root, { afterCommit: () => {
  if (armed && mode === 'wal-crash') process.kill(process.pid, 'SIGKILL');
} });
session.setEnabled(true);
if (mode === 'malformed-wal') {
  session.diagnostics.record('ENGINE_STARTED', { epochId: 'synthetic' }); session.close();
  const db = new DatabaseSync(join(root, 'debug-session/journal.sqlite'));
  db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA wal_autocheckpoint=0');
  const state = JSON.parse(db.prepare('SELECT payload FROM journal').get().payload);
  state.segments[0].events[0].error = 'MALFORMED_WAL_CANARY';
  db.prepare('UPDATE journal SET payload=?').run(JSON.stringify(state));
  process.kill(process.pid, 'SIGKILL');
}
if (mode === 'wal-crash') {
  const events = session.diagnostics.scope({ epochId: 'synthetic-before-crash' });
  events.record('ENGINE_STARTED'); armed = true;
  events.record('BRIDGE_DISCONNECTED');
  assert.fail('Crash hook was not reached');
}
assert.ok(['runtime-crash', 'runtime-restart'].includes(mode));
let runtime;
try {
  runtime = await startPackagedChatGPT({ supportDirectory: join(root, 'engine'), installation: null,
    keyStore: new FileKeyStore(join(root, 'provenance-key-lifecycle-test-keys')),
    fastTrust: { profile: FAST_CONFIRM_PROFILE }, managed: null, debugSession: session, diagnostics: session.diagnostics,
    collectFast: async () => ({ synthetic: true }),
    verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
      assurance: FAST_CONFIRM_PROFILE, round: 42 }),
    verifyArchive: () => { throw Error('NO_ARCHIVE_FIXTURE'); },
    attestPeer: () => { throw Error('NO_NATIVE_PEER_FIXTURE'); },
  });
  await publishRuntimeState(root, runtime);
  if (mode === 'runtime-crash') {
    const hello = { extensionId: CHATGPT_EXTENSION_ID, adapterProfile: CHATGPT_ADAPTER_PROFILE,
      releaseProtocol: CHATGPT_RELEASE_PROTOCOL, pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-browser',
      browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' }, permissions: ['nativeMessaging'],
      hostPermission: 'https://chatgpt.com/*', permissionState: 'granted', tabs: [{ id: 17, windowId: 1,
        tabEpoch: 'synthetic-tab', active: true, url: 'https://chatgpt.com/c/synthetic', destination: 'conversation:synthetic',
        surfaceSupported: true, composerEmpty: true, attachmentsPresent: false }] };
    runtime.adapter.pair(hello); runtime.adapter.synchronize(hello);
    const { scope } = runtime.session.enroll({ tabId: 17, destination: 'conversation:synthetic' });
    const version = await runtime.session.freeze({ text: 'CRASH_PROMPT_CANARY', mode: 'Sealed', scope, editRevision: 1 });
    await runtime.session.confirmFast({ id: version.id, scope, currentText: 'CRASH_PROMPT_CANARY', editRevision: 1, transactionId: 'synthetic' });
    assert.ok(runtime.session.runtime.snapshot().seals[version.id].authorization);
    assert.ok(JSON.parse(session.export()).segments.flatMap(segment => segment.events).some(event => event.code === 'CONFIRMATION_ACCEPTED'));
    process.kill(process.pid, 'SIGKILL');
  }
  assert.equal(runtime.engine.state().scopes.length, 0);
  const snapshot = runtime.session.runtime.snapshot();
  assert.equal(Object.keys(snapshot.seals).length, 1);
  assert.ok(Object.values(snapshot.seals).every(seal => seal.authorization === null));
  assert.deepEqual(snapshot.attempts, {});
  assert.equal(session.status().state, 'RECORDING');
  assert.equal(session.status().segments, 2);
} finally {
  await runtime?.close(); session.close(); network.restore();
}
