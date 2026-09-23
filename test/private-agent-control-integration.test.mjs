import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingFixture, until } from './recording-fixture.mjs';
import { agentControl } from '../spikes/development/agent-control.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { publishRuntimeState } from '../spikes/development/runtime-state.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';

test('agent controls use the real authenticated dashboard, durable vault and debug journal without capture authority', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/agent-api-integration-test-'));
  const paths = { control: join(root, 'control') }; await mkdir(paths.control, { mode: 0o700 });
  const debug = new OwnerDebugSession(paths.control), network = restrictFixtureNetwork(root);
  let fixture;
  try {
    fixture = await recordingFixture(root, { network, debugSession: debug, diagnostics: debug.diagnostics });
    await publishRuntimeState(paths.control, fixture.runtime);
    const control = (action, ...args) => agentControl(paths, action, args);
    assert.equal((await control('state')).available, true);
    await control('recording', 'on'); await fixture.recording(true);
    assert.equal((await control('history')).counts.prompts, 0, 'control cannot admit evidence');
    await control('debug', 'on');
    fixture.send('SYNTHETIC_AGENT_API_PROMPT');
    await until(() => fixture.runtime.session.receipts.list().length === 1);
    assert.equal((await control('wait', 'prompt-count=1', '5000')).satisfied, true);
    await control('recording', 'off');
    assert.equal((await control('assert', 'recording=OFF')).satisfied, true);
    await control('debug', 'off');
    const status = await control('debug', 'status');
    const exported = await control('debug', 'export');
    const originalExport = await readFile(exported.artifact, 'utf8');
    assert.doesNotMatch(originalExport, /SYNTHETIC_AGENT_API_PROMPT|https:\/\/chatgpt/);
    await assert.rejects(control('debug', 'new', status.sessionId, '0'.repeat(32), 'acknowledge'), /AGENT_API_REJECTED/);
    await control('debug', 'new', status.sessionId, status.revision, 'acknowledge');
    assert.equal(await readFile(exported.artifact, 'utf8'), originalExport);
    assert.equal((await control('history')).counts.prompts, 1);
    const failure = await control('failure-bundle');
    assert.equal(failure.state.prompts, 1);
    assert.doesNotMatch(await readFile(failure.artifact, 'utf8'), /SYNTHETIC_AGENT_API_PROMPT|https:\/\/chatgpt/);
    await assert.rejects(control('capture', 'SYNTHETIC_FORGED_INPUT'), /AGENT_COMMAND_INVALID/);
    assert.equal(fixture.userSends, 1); assert.equal(fixture.deliveries.length, 1);
  } finally { await fixture?.close(); debug.close(); network.restore(); await rm(root, { recursive: true, force: true }); }
});
