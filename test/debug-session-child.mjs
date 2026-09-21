import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { FileKeyStore } from './file-key-store.mjs';
import { publishRuntimeState } from '../spikes/development/runtime-state.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT,
  CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { DatabaseSync } from 'node:sqlite';

const [root, mode] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/pap-debug-test-[^/]+$/);
process.umask(0);
const network = restrictFixtureNetwork(root);
let armed = false;
const session = new OwnerDebugSession(root, { beforeCommit: () => {
  if (armed && mode === 'fresh-before-commit') process.kill(process.pid, 'SIGKILL');
}, afterCommit: () => {
  if (armed && ['wal-crash', 'fresh-after-commit'].includes(mode)) process.kill(process.pid, 'SIGKILL');
} });
session.setEnabled(true);
if (mode.startsWith('fresh-')) {
  session.diagnostics.record('ENGINE_STARTED', { epochId: 'synthetic-before-replacement' });
  session.setEnabled(false);
  writeFileSync(join(root, 'saved-debug-session.json'), session.export(), { mode: 0o600 });
  armed = true;
  const { sessionId, revision } = session.status();
  session.startFresh({ sessionId, revision, acknowledged: true });
  assert.fail('Fresh-session crash hook was not reached');
}
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
      captureProfile: 'pap-chatgpt-capture/4', pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-browser',
      browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' }, permissions: ['nativeMessaging'],
      hostPermission: 'https://chatgpt.com/*', permissionState: 'granted', tabs: [{ id: 17, windowId: 1,
        tabEpoch: 'synthetic-tab', active: true, url: 'https://chatgpt.com/c/synthetic', destination: 'conversation:synthetic',
        surfaceSupported: true, attachmentsPresent: false }] };
    runtime.adapter.pair(hello); runtime.adapter.synchronize(hello);
    const state = runtime.engine.state();
    await runtime.engine.command({ profile: 'pap-resident-command/2', adapterProfile: state.adapterProfile,
      runtimeEpoch: state.runtimeEpoch, expectedRevision: state.revision, commandId: crypto.randomUUID(),
      kind: 'SET_RECORDING', enabled: true }, { surface: 'desktop' });
    const policy = runtime.engine.capturePolicy()[0];
    const { scope, runtimeEpoch, browserSessionId, tabId, windowId, tabEpoch, destination } = policy;
    await runtime.engine.observe({ profile: 'pap-chatgpt-capture/4', kind: 'request-observed', token: policy.token,
      eventId: crypto.randomUUID(), inputMethod: 'provider-request', text: 'CRASH_PROMPT_CANARY',
      request: { profile: 'chatgpt-new-user-text/2', path: '/backend-api/conversation', messageId: 'crash-message', conversationId: 'synthetic' },
      source: { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
        scope, runtimeEpoch, browserSessionId, tabId, windowId, tabEpoch, destination, documentId: 'synthetic-document' } });
    await runtime.engine.drain();
    assert.ok(JSON.parse(session.export()).segments.flatMap(segment => segment.events).some(event => event.code === 'NORMAL_PROMPT_SAVED'));
    process.kill(process.pid, 'SIGKILL');
  }
  assert.equal(runtime.engine.state().scopes.length, 0);
  assert.equal(runtime.engine.state().recording, true);
  assert.equal(runtime.session.receipts.list().length, 1);
  assert.equal(runtime.session.runtime, undefined);
  assert.equal(session.status().state, 'RECORDING');
  assert.equal(session.status().segments, 2);
} finally {
  await runtime?.close(); session.close(); network.restore();
}
