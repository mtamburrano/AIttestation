import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { discoverClients } from '../spikes/coding/discovery.mjs';
import { CodingIntegrations } from '../spikes/coding/integrations.mjs';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/attestamp-discovery-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { home: join(root, 'home'), applications: join(root, 'Applications'), globalBins: [join(root, 'bin')], arch: 'arm64' };
  const put = async (path, text = 'synthetic native image') => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode: 0o700 }); return path; };
  const enables = [], manager = await new CodingIntegrations({ directory: join(root, 'support'), receiver: join(root, 'receiver'),
    configRoots: { codex: join(root, 'codex'), 'claude-code': join(root, 'claude') },
    discover: ({ client }) => discoverClients({ ...options, client }), codeIdentity: async () => 'a'.repeat(40),
    setEnabled: async (...args) => enables.push(args) }).init();
  return { root, options, put, manager, enables };
}

test('bounded discovery finds desktop, active IDE and CLI without enrolling stale extension directories', async t => {
  const { root, options, put, manager, enables } = await fixture(t);
  const desktop = await put(join(options.applications, 'ChatGPT.app/Contents/Resources/codex'));
  await put(join(options.applications, 'ChatGPT.app/Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>26.1</string>');
  const extensions = join(options.home, '.vscode/extensions');
  const active = await put(join(extensions, 'openai.chatgpt-2/bin/macos-aarch64/codex'));
  await put(join(extensions, 'openai.chatgpt-1/bin/macos-aarch64/codex'));
  const claude = await put(join(extensions, 'anthropic.claude-code-3/resources/native-binary/claude'));
  await put(join(extensions, 'extensions.json'), JSON.stringify([
    { identifier: { id: 'openai.chatgpt' }, relativeLocation: 'openai.chatgpt-2', version: '2.0' },
    { identifier: { id: 'anthropic.claude-code' }, relativeLocation: 'anthropic.claude-code-3', version: '3.0' },
  ]));
  const result = await manager.discover({ client: 'codex' });
  assert.deepEqual(result.candidates.map(v => v.path), [desktop, active]);
  assert.deepEqual(result.candidates.map(v => v.version), ['26.1', '2.0']);
  assert.equal(result.authority, 'NONE'); assert.deepEqual(enables, []);
  await assert.rejects(readFile(join(root, 'codex/hooks.json')), { code: 'ENOENT' });
  await assert.rejects(manager.preview({ client: 'codex' }), /SELECT_CLIENT_EXECUTABLE/);
  const plan = await manager.preview({ client: 'claude-code' });
  assert.deepEqual(plan.executables, [{ path: claude }]); assert.deepEqual(enables, []);
  const cli = await put(join(options.globalBins[0], 'codex'), '#!/usr/bin/env node\n');
  const script = (await manager.discover({ client: 'codex' })).candidates.find(v => v.path === cli);
  assert.equal(script.interpreterRequired, true);
});

test('ambiguous, traversal and oversized IDE inventories never select an abandoned installation', async t => {
  const { options, put, manager } = await fixture(t), extensions = join(options.home, '.vscode/extensions');
  await put(join(extensions, 'openai.chatgpt-1/bin/macos-aarch64/codex'));
  for (const registry of [
    [{ identifier: { id: 'openai.chatgpt' }, relativeLocation: '../openai.chatgpt-1' }],
    Array.from({ length: 2 }, () => ({ identifier: { id: 'openai.chatgpt' }, relativeLocation: 'openai.chatgpt-1' })),
    Array(513).fill({}),
  ]) {
    await put(join(extensions, 'extensions.json'), JSON.stringify(registry));
    assert.equal((await manager.discover({ client: 'codex' })).state, 'UNAVAILABLE');
  }
});

test('dual Codex hook configuration has a precise conflict and never rewrites either file', async t => {
  const { root, put, manager } = await fixture(t);
  const exe = await put(join(root, 'native'));
  const toml = await put(join(root, 'codex/config.toml'), '[hooks]\nUserPromptSubmit = []\n');
  const json = await put(join(root, 'codex/hooks.json'), '{"hooks":{"UserPromptSubmit":[]}}');
  const originals = await Promise.all([readFile(toml), readFile(json)]);
  await assert.rejects(manager.preview({ client: 'codex', clientExecutable: exe }), /CODEX_DUAL_HOOK_CONFIGURATION/);
  assert.deepEqual(await Promise.all([readFile(toml), readFile(json)]), originals);
  await rm(json);
  const plan = await manager.preview({ client: 'codex', clientExecutable: exe });
  await put(json, originals[1]);
  await assert.rejects(manager.apply({ operationId: plan.operationId, consent: true }), /CODEX_DUAL_HOOK_CONFIGURATION/);
  assert.deepEqual(await Promise.all([readFile(toml), readFile(json)]), originals);
});
