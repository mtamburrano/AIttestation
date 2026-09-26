import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { decodeHook } from '../spikes/coding/protocol.mjs';
import { editSettings, ownedHook, parseSettings } from '../spikes/coding/settings.mjs';
import { CodingIntegrations } from '../spikes/coding/integrations.mjs';
import { startCodingRuntime } from '../spikes/coding/runtime.mjs';
import { receiveHook } from '../spikes/coding/hook-receiver.mjs';
import { codingFixture, exactHookText } from './coding-fixture.mjs';

test('official decoders retain only the exact documented user prompt and stable source IDs', () => {
  const base = { hook_event_name: 'UserPromptSubmit', prompt: exactHookText, session_id: 's1', turn_id: 't1',
    prompt_id: randomUUID(), transcript_path: '/never/read/transcript', cwd: '/never/read/project' };
  const decode = (client, extra = {}) => decodeHook(client, Buffer.from(JSON.stringify({ ...base, ...extra })));
  for (const client of ['codex', 'claude-code']) {
    const value = decode(client); assert.equal(value.text, exactHookText);
    assert.deepEqual(Object.keys(value).sort(), ['promptId', 'sessionId', 'text', 'turnId']);
    for (const extra of [{ hook_event_name: 'Stop' }, { agent_id: 'subagent' }, { parent_session_id: 'parent' },
      { prompt: '\ud800' }, { prompt: '' }, { prompt: 'x'.repeat(300000) }]) assert.throws(() => decode(client, extra));
  }
  assert.throws(() => decodeHook('codex', Buffer.from('{"prompt":"a","prompt":"b"}')));
  assert.throws(() => decodeHook('codex', Buffer.from([0xff])));
});

test('admission performs no durable or History work, binds a copy, and saves a pre-OFF admission afterward', async t => {
  const f = await codingFixture(t); await f.command('SET_RECORDING', true);
  assert.throws(() => f.admit(0, f.input()), /CAPTURE_NOT_ENABLED/);
  await f.command('SET_INTEGRATION', true, 'codex');
  const before = f.vault.recordCount, input = f.input();
  const capture = f.vault.capture, status = f.session.status;
  f.vault.capture = f.session.status = () => { throw Error('FORBIDDEN_BEFORE_ACK'); };
  const admitted = f.admit(0, input); input.text = 'mutated after admission';
  f.vault.capture = capture; f.session.status = status;
  assert.equal(admitted.state, 'ADMITTED'); assert.equal(f.vault.recordCount, before);
  await f.command('SET_RECORDING', false);
  assert.equal(f.channels[0].releaseAdmission(admitted.eventId), true);
  await f.engine.drain();
  assert.equal(f.session.versionCount, 1);
  const receipt = f.session.version(admitted.eventId);
  const preview = f.session.receipts.prepare({ ids: [receipt.descriptorId] });
  assert.equal(preview.texts[0].preview, exactHookText);
  assert.equal(f.engine.beginAdmission(), null);
});

test('stale OFF/ON and disable/re-enable authorities, timeout, replay and backpressure cannot admit', async t => {
  const f = await codingFixture(t);
  await f.command('SET_INTEGRATION', true, 'codex'); await f.command('SET_RECORDING', true);
  const stale = f.engine.beginAdmission();
  await f.command('SET_RECORDING', false); await f.command('SET_RECORDING', true);
  assert.throws(() => f.admit(0, f.input(), stale), /CAPTURE_NOT_ENABLED/);
  const disabled = f.engine.beginAdmission();
  await f.command('SET_INTEGRATION', false, 'codex'); await f.command('SET_INTEGRATION', true, 'codex');
  assert.throws(() => f.admit(0, f.input(), disabled), /CAPTURE_NOT_ENABLED/);
  const authority = f.engine.beginAdmission(); const one = f.admit(0, f.input(), authority);
  assert.throws(() => f.admit(0, f.input(), authority), /CAPTURE_NOT_ENABLED/);
  for (let i = 0; i < 3; i++) f.admit(0, f.input());
  assert.throws(() => f.admit(0, f.input()), /ADMISSION_BUSY/);
  f.channels[0].cancelAdmission(one.eventId);
  const next = f.admit(0, f.input()); f.channels[0].cancelAdmission(next.eventId);
  await f.command('SET_INTEGRATION', true, 'claude-code');
  const independent = f.admit(1, f.input(1)); f.channels[1].releaseAdmission(independent.eventId);
  await f.engine.drain(); assert.equal(f.session.versionCount, 1);
});

test('real local socket handoff releases acknowledged copies; rejected native identity saves nothing', async t => {
  const f = await codingFixture(t); await f.command('SET_RECORDING', true); await f.command('SET_INTEGRATION', true, 'codex');
  let authorized = true;
  const installationId = randomUUID();
  const server = await startCodingRuntime({ directory: f.root, engine: f.engine, sources: f.sources, runtimeEpoch: f.epoch,
    integrations: { enrollment: (client, id) => client === 'codex' && id === installationId ? { client, installationId, operationId: 'fixture' } : null },
    attestPeer: async socket => { socket.pause(); // Passing a real Socket to native child stdio pauses it.
      if (!authorized) throw Error('SYNTHETIC_IDENTITY_REJECTED'); return { client: 'codex', origin: 'enrolled-local-executable' }; } });
  t.after(() => server.close());
  const { socketPath } = JSON.parse(await readFile(join(f.root, 'coding-bridge.json')));
  const invoke = () => receiveHook({ client: 'codex', installationId, socket: connect(socketPath),
    input: Readable.from([Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: exactHookText, session_id: 's', turn_id: 't' }))]) });
  assert.equal((await invoke()).state, 'ADMITTED'); await new Promise(resolve => setTimeout(resolve, 20)); await f.engine.drain();
  assert.equal(f.session.versionCount, 1);
  authorized = false; assert.equal((await invoke()).state, 'UNAVAILABLE');
  await f.engine.drain(); assert.equal(f.session.versionCount, 1);
  await server.close();
});

for (const [name, text] of [
  ['table', '# keep comment\nmodel = "example"\n[hooks]\nother = "unchanged"\n'],
  ['array of tables', '[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "existing"\n'],
  ['inline array', 'hooks = { UserPromptSubmit = [{ hooks = [{ type = "command", command = "existing" }] }] }\n'],
  ['multiline text', 'message = """\n[[hooks.UserPromptSubmit]]\n# not a real edit location\n"""\n[hooks]\nUserPromptSubmit = [\n]\n'],
]) test(`TOML ${name} installs and removes without rewriting unrelated representation`, () => {
  const installationId = randomUUID(), hook = ownedHook('codex', "/Applications/Attestamp 'Test'.app/Contents/MacOS/provenance-hook-receiver", installationId);
  const edit = editSettings({ text, format: 'toml', client: 'codex', installationId, next: hook });
  assert.equal(parseSettings(edit.text, 'toml').hooks.UserPromptSubmit.at(-1).hooks[0].command, hook.hooks[0].command);
  const removed = editSettings({ text: edit.text, format: 'toml', client: 'codex', installationId, previous: hook, fragment: edit.fragment });
  assert.equal(removed.text, text);
  assert.throws(() => parseSettings('a=[1 #', 'toml'), /CONFLICT/);
});

test('registration is consented, revision-aware, idempotent, reversible and preserves unrelated JSON', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-registration-test-'); t.after(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, 'codex'), claude = join(root, 'claude'); await mkdir(codex); await mkdir(claude);
  const executable = join(root, 'fixture-client'); await writeFile(executable, 'synthetic native image', { mode: 0o700 });
  const path = join(claude, 'settings.json'), original = '{\n  "theme": "unchanged",\n  "hooks": {"Stop": [{"hooks": [{"type":"command","command":"existing"}]}]}\n}\n';
  await writeFile(path, original); const enables = [];
  const options = { directory: join(root, 'support'), receiver: join(root, 'App With Space/receiver'), configRoots: { codex, 'claude-code': claude },
    codeIdentity: async () => 'a'.repeat(40),
    setEnabled: async (...args) => enables.push(args) };
  const manager = await new CodingIntegrations(options).init();
  const plan = await manager.preview({ client: 'claude-code', clientExecutable: executable });
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(manager.apply({ operationId: plan.operationId }), /CONSENT_REQUIRED/);
  await manager.apply({ operationId: plan.operationId, consent: true });
  const first = JSON.parse(await readFile(path)); assert.equal(first.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(first.hooks.Stop, JSON.parse(original).hooks.Stop); assert.equal(first.theme, 'unchanged');
  const again = await manager.preview({ client: 'claude-code' }); await manager.apply({ operationId: again.operationId, consent: true });
  assert.equal(JSON.parse(await readFile(path)).hooks.UserPromptSubmit.length, 1);
  const conflict = await manager.preview({ client: 'claude-code', action: 'remove' });
  first.theme = 'edited after preview'; await writeFile(path, JSON.stringify(first));
  await assert.rejects(manager.apply({ operationId: conflict.operationId, consent: true }), /CONFLICT/);
  assert.deepEqual(enables.at(-1), ['claude-code', false]);
  const reopened = await new CodingIntegrations(options).init(), remove = await reopened.preview({ client: 'claude-code', action: 'remove' });
  await reopened.apply({ operationId: remove.operationId, consent: true });
  const final = JSON.parse(await readFile(path)); assert.equal(final.theme, first.theme); assert.deepEqual(final.hooks.Stop, first.hooks.Stop);
  assert.deepEqual(final.hooks.UserPromptSubmit, []);
  const other = join(root, 'other'); await writeFile(other, '{}'); await symlink(other, join(codex, 'hooks.json'));
  await assert.rejects(reopened.preview({ client: 'codex', clientExecutable: executable }), /UNSAFE/);
});
