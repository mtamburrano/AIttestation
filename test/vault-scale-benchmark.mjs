import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Vault } from '../spikes/vault/vault.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { ResidentEngine } from '../spikes/browser/chatgpt/engine.mjs';
import { dashboardState } from '../spikes/browser/chatgpt/dashboard.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';

if (process.argv[2] !== '--child') {
  const results = [];
  for (const [count, pageSize] of [[1000,4096],[1000,8192],[1000,16384],[1000,32768],[10000,4096],[50000,4096]]) {
    const child = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--child', String(count), String(pageSize)],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30 * 60000, maxBuffer: 1024 * 1024 });
    if (child.status !== 0) throw Error(child.stderr || child.stdout);
    const result = JSON.parse(child.stdout); results.push(result); console.log(JSON.stringify(result));
  }
} else {
  const count = Number(process.argv[3]), pageSize = Number(process.argv[4]);
  assert.ok([1000,10000,50000].includes(count));
  const root = mkdtempSync(join(tmpdir(), 'attestamp-scale-benchmark-test-')), directory = join(root, 'vault'), key = randomBytes(32);
  let vault, session, engine;
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const sessionOptions = () => ({ vault, fastTrust: { profile: FAST_CONFIRM_PROFILE }, managed: null });
  try {
    vault = new Vault(directory, key, undefined, { create: true, pageSize });
    session = await new ChatGPTRecordingSession(root, adapter, sessionOptions()).init();
    const captureStart = performance.now();
    for (let n = 0; n < count; n++) session.observeNormal(scaleObservation(n));
    const captureMs = performance.now() - captureStart;
    assert.equal(vault.recordCount, count * 2);
    session.close(); session = null; vault.close(); vault = null; global.gc?.();
    const diskBytes = readdirSync(directory).reduce((n, file) => n + statSync(join(directory, file)).size, 0);
    const openStart = performance.now();
    vault = new Vault(directory, key);
    session = await new ChatGPTRecordingSession(root, adapter, sessionOptions()).init();
    engine = await new ResidentEngine(root, session, adapter, randomUUID()).init();
    const startupMs = performance.now() - openStart, startupAccess = vault.metrics({ reset: true });
    assert.equal(startupAccess.recordsRead, 0); assert.equal(startupAccess.objectsRead, 0);
    const runtime = { engine, session, browserState: () => null };
    const recentStart = performance.now(), recent = await dashboardState(runtime);
    const recentMs = performance.now() - recentStart, recentAccess = vault.metrics({ reset: true });
    assert.equal(recent.history.prompts.length, 5); assert.equal(recent.history.counts.prompts, count);
    const pageStart = performance.now();
    const page = await dashboardState(runtime, { before: recent.history.page.next });
    const pagedMs = performance.now() - pageStart, pageAccess = vault.metrics({ reset: true });
    assert.equal(page.history.prompts.length, 5);
    const searchStart = performance.now(), search = await dashboardState(runtime, { search: 'needle000000' });
    const searchMs = performance.now() - searchStart, searchAccess = vault.metrics({ reset: true });
    assert.equal(search.history.prompts.length, 1);
    const commonStart = performance.now(), common = await dashboardState(runtime, { search: 'exact local' });
    const commonSearchMs = performance.now() - commonStart;
    assert.equal(common.history.prompts.length, 5);
    for (const access of [recentAccess, pageAccess, searchAccess]) { assert.ok(access.recordsRead <= 40); assert.ok(access.objectsRead <= 60); }
    console.log(JSON.stringify({ prompts: count, pageSize, captureMs, startupMs, recentMs, pagedMs, searchMs, commonSearchMs,
      peakRssMiB: process.resourceUsage().maxRSS / 1024, rssMiB: process.memoryUsage().rss / 2 ** 20,
      diskMiB: diskBytes / 2 ** 20, startupAccess, recentAccess, pageAccess, searchAccess }));
  } finally { engine?.stop(); await engine?.drain(); session?.close(); vault?.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
}
