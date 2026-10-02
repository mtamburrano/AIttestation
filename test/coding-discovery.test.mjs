import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discoverClients } from '../spikes/coding/discovery.mjs';
import { CodingIntegrations } from '../spikes/coding/integrations.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attestamp-discovery-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { home: join(root, 'home'), applications: join(root, 'Applications'), globalBins: [join(root, 'bin')], arch: 'arm64' };
  const put = async (path, text = 'synthetic native image') => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode: 0o700 }); return path; };
  const enables = [], manager = await new CodingIntegrations({ directory: join(root, 'support'), receiver: join(root, 'receiver'),
    configRoots: { codex: join(root, 'codex'), 'claude-code': join(root, 'claude') },
    discover: ({ client }) => discoverClients({ ...options, client }), codeIdentity: async () => 'a'.repeat(40),
    setEnabled: async (...args) => enables.push(args) }).init();
  return { root, options, put, manager, enables };
}

for (const legacy of [false, true]) test(`current ChatGPT desktop discovery${legacy ? ' alongside legacy layouts' : ' without legacy layouts'} remains selection-only`, async t => {
  const { root, options, put, manager, enables } = await fixture(t);
  const app = join(options.applications, 'ChatGPT.app/Contents');
  const paths = [await put(join(app, 'Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')),
    await put(join(app, 'Resources/codex-cli/bin/codex'))];
  await put(join(app, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>26.10</string>');
  if (legacy) paths.push(await put(join(app, 'Resources/codex')),
    await put(join(options.applications, 'Codex.app/Contents/Resources/codex')));
  await put(join(app, 'Resources/unregistered/codex'));
  const result = await manager.discover({ client: 'codex' });
  assert.equal(result.state, 'DETECTED'); assert.equal(result.authority, 'NONE');
  assert.deepEqual(result.candidates.map(value => value.path), paths);
  assert.deepEqual(result.candidates.slice(0, 2).map(value => value.version), ['26.10', '26.10']);
  assert.ok(result.candidates.every(value => value.surface === 'DESKTOP' && value.state === 'DETECTED'));
  assert.deepEqual(enables, []);
  await assert.rejects(manager.preview({ client: 'codex' }), /SELECT_CLIENT_EXECUTABLE/);
  const plan = await manager.preview({ client: 'codex', clientExecutables: [{ path: paths[0] }] });
  assert.deepEqual(plan.executables, [{ path: paths[0] }]);
  await assert.rejects(manager.apply({ operationId: plan.operationId }), /CONSENT_REQUIRED/);
  assert.deepEqual(enables, []);
  await assert.rejects(readFile(join(root, 'codex/hooks.json')), { code: 'ENOENT' });
});

test('current desktop aliases deduplicate to the actual executable and retain preview identity pinning', async t => {
  const { root, options, put, manager, enables } = await fixture(t);
  const resources = join(options.applications, 'ChatGPT.app/Contents/Resources');
  const binary = await put(join(resources, 'codex-cli/CodexCLI.app/Contents/MacOS/codex'));
  const alias = join(resources, 'codex-cli/bin/codex'); await mkdir(dirname(alias)); await symlink(binary, alias);
  assert.deepEqual((await manager.discover({ client: 'codex' })).candidates.map(value => value.path), [binary]);
  await mkdir(options.globalBins[0]); await symlink(binary, join(options.globalBins[0], 'codex'));
  assert.deepEqual((await manager.discover({ client: 'codex' })).candidates.map(value => value.path), [binary]);
  const plan = await manager.preview({ client: 'codex' });
  assert.deepEqual(plan.executables, [{ path: binary }]); assert.deepEqual(enables, []);
  await put(binary, 'changed synthetic native image');
  await assert.rejects(manager.apply({ operationId: plan.operationId, consent: true }), /CONFLICT/);
  assert.ok(enables.every(([, enabled]) => !enabled));
  await assert.rejects(readFile(join(root, 'codex/hooks.json')), { code: 'ENOENT' });
});

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
