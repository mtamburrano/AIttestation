import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { recordingFixture } from '../../test/recording-fixture.mjs';
import { discoverClients } from '../coding/discovery.mjs';
import { receiveHook } from '../coding/hook-receiver.mjs';

const exact = '\ufeffSYNTHETIC_CODING_EXACT_e\u0301\r\n\0 ☕';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(Error(code), { code });

export async function codingProductFixture(directory, scenario, diagnostics, network) {
  const home = join(directory, 'home'), applications = join(directory, 'Applications'), checkpoints = [];
  const put = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, { mode: 0o700 }); return path; };
  const desktop = await put(join(applications, 'ChatGPT.app/Contents/Resources/codex'), 'synthetic desktop');
  const ide = await put(join(home, '.vscode/extensions/openai.chatgpt-2/bin/macos-aarch64/codex'), 'synthetic IDE');
  const claude = await put(join(home, '.local/bin/claude'), 'synthetic Claude');
  await put(join(home, '.vscode/extensions/extensions.json'), JSON.stringify([{ identifier: { id: 'openai.chatgpt' },
    relativeLocation: 'openai.chatgpt-2', version: '2.0' }]));
  let selectedPeer = desktop;
  const f = await recordingFixture(directory, { diagnostics, network, managed: null,
    discoverClients: ({ client }) => discoverClients({ client, home, applications, globalBins: [], arch: 'arm64' }),
    codeIdentity: async path => hash(await readFile(path)),
    hookPeer: async (_socket, entry) => {
      const identity = entry.executables.find(value => value.path === selectedPeer);
      if (!identity || identity.sha256 !== hash(await readFile(selectedPeer))) throw failure('SYNTHETIC_IDENTITY_REJECTED');
      return { client: entry.client, origin: 'enrolled-local-executable' };
    } });
  let expected = 0;
  const manager = () => f.runtime.integrationManager;
  const install = async (client, paths) => {
    const plan = await manager().preview({ client, ...(paths ? { clientExecutables: paths.map(path => ({ path })) } : {}) });
    await manager().apply({ operationId: plan.operationId, consent: true });
    return (await manager().status()).find(entry => entry.id === client);
  };
  const invoke = async (client, installationId, path, saved) => {
    selectedPeer = path;
    const { socketPath } = JSON.parse(await readFile(join(directory, 'engine/coding-bridge.json')));
    const revoke = network.allowSocket(socketPath);
    try {
      const result = await receiveHook({ client, installationId, socket: connect(socketPath), input: Readable.from([
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: exact, session_id: 'synthetic', turn_id: 't', prompt_id: randomUUID() })]) });
      assert.equal(result.state, saved ? 'ADMITTED' : 'UNAVAILABLE');
      if (saved) expected++;
      await f.runtime.engine.drain();
      assert.equal(f.runtime.session.versionCount, expected);
    } finally { revoke(); }
  };
  const checkpoint = async (name, run) => {
    try { await run(); checkpoints.push({ name, status: 'PASS', historyCount: expected }); }
    catch (error) {
      if (['EPERM', 'EACCES', 'FIXTURE_NETWORK_FORBIDDEN'].includes(error?.code)) throw error;
      throw Object.assign(failure('SCENARIO_ASSERTION_FAILED'), { checkpoint: name });
    }
  };
  try {
    let codex, claudeEntry;
    await checkpoint('discovery-install-repair', async () => {
      assert.deepEqual((await manager().discover({ client: 'codex' })).candidates.map(v => v.path), [desktop, ide]);
      assert.equal((await manager().status()).find(v => v.id === 'codex').configured, false);
      codex = await install('codex', [desktop, ide]); claudeEntry = await install('claude-code');
      assert.equal((await install('codex')).installationId, codex.installationId);
    });
    await checkpoint('off-captures-nothing', async () => {
      await invoke('codex', codex.installationId, desktop, false);
      await invoke('claude-code', claudeEntry.installationId, claude, false);
    });
    await checkpoint('two-codex-and-claude-coexist', async () => {
      await f.command('SET_RECORDING', { enabled: true });
      await invoke('codex', codex.installationId, desktop, true);
      await invoke('codex', codex.installationId, ide, true);
      await invoke('claude-code', claudeEntry.installationId, claude, true);
    });
    await checkpoint('disable-reenable-preserves-other-client', async () => {
      await manager().disable({ client: 'codex' });
      await invoke('codex', codex.installationId, ide, false);
      await invoke('claude-code', claudeEntry.installationId, claude, true);
      codex = await install('codex'); await invoke('codex', codex.installationId, desktop, true);
    });
    await checkpoint('stale-executable-and-config-conflict', async () => {
      await writeFile(ide, 'synthetic replacement');
      await invoke('codex', codex.installationId, ide, false);
      codex = await install('codex'); await invoke('codex', codex.installationId, ide, true);
      const stale = await manager().preview({ client: 'codex' });
      const path = join(directory, 'codex/hooks.json'), value = JSON.parse(await readFile(path));
      value.unrelated = 'preserved'; await writeFile(path, JSON.stringify(value));
      await assert.rejects(manager().apply({ operationId: stale.operationId, consent: true }), /CONFLICT/);
      assert.equal(JSON.parse(await readFile(path)).unrelated, 'preserved');
      codex = await install('codex');
    });
    await checkpoint('resident-restart-and-exact-history', async () => {
      await f.restart(); await f.command('SET_RECORDING', { enabled: true });
      await invoke('codex', codex.installationId, desktop, true);
      await invoke('claude-code', claudeEntry.installationId, claude, true);
      const receipts = f.runtime.session.receipts.list(); assert.equal(receipts.length, expected);
      const selection = f.runtime.session.receipts.prepare({ ids: receipts.map(value => value.id) });
      assert.ok(selection.texts.every(value => value.preview === exact));
    });
    await checkpoint('remove-retains-history-and-unrelated-settings', async () => {
      for (const entry of [codex, claudeEntry]) {
        const plan = await manager().preview({ client: entry.id, action: 'remove' });
        await manager().apply({ operationId: plan.operationId, consent: true });
        await invoke(entry.id, entry.installationId, entry.id === 'codex' ? desktop : claude, false);
      }
      assert.equal(JSON.parse(await readFile(join(directory, 'codex/hooks.json'))).unrelated, 'preserved');
    });
    await checkpoint('app-absence-fails-open', async () => {
      const { socketPath } = JSON.parse(await readFile(join(directory, 'engine/coding-bridge.json')));
      await f.close(); const revoke = network.allowSocket(socketPath);
      try {
        assert.equal((await receiveHook({ client: 'codex', installationId: codex.installationId,
          socket: connect(socketPath), input: Readable.from(['{}']) })).state, 'UNAVAILABLE');
      } finally { revoke(); }
    });
    return { scenario, status: 'PASS', checkpoints, providerAttempts: 0, sponsorBroadcasts: 0,
      identity: 'SYNTHETIC_PINNED_EXECUTABLES', historyCount: expected, vendorClientEvidence: 'NOT_TESTED' };
  } finally { await f.close(); }
}

export async function nativeCodingFixture(directory, scenario) {
  if (process.platform !== 'darwin') return { scenario, status: 'UNAVAILABLE', classification: 'EXTERNAL', reason: 'MACOS_TOOLCHAIN_REQUIRED' };
  for (const tool of ['swiftc', 'clang']) if (spawnSync('/usr/bin/xcrun', ['--find', tool], { env: { PATH: '/usr/bin:/bin' }, timeout: 5000 }).status !== 0)
    return { scenario, status: 'UNAVAILABLE', classification: 'EXTERNAL', reason: 'MACOS_TOOLCHAIN_REQUIRED' };
  const report = join(directory, 'native.json');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../test/mac-hook-native.mjs', import.meta.url)), report, '--quick'],
    { env: { PATH: '/usr/bin:/bin' }, timeout: 120_000, maxBuffer: 128 * 1024, encoding: 'utf8' });
  if (run.status !== 0) throw failure(run.error?.code === 'ETIMEDOUT' ? 'NATIVE_HARNESS_TIMEOUT' : 'NATIVE_RECEIVER_FAILED');
  const value = JSON.parse(await readFile(report));
  return { scenario, status: 'PASS', identity: value.identity, vendorClientEvidence: 'NOT_TESTED',
    checkpoints: Object.entries(value.paths).map(([name, result]) => ({ name, status: 'PASS', samples: result.samples, saved: result.saved })) };
}
