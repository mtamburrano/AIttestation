import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('coding acceptance uses isolated resources and produces content-free reproducible lifecycle evidence', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-coding-report-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, 'untouched'); await writeFile(sentinel, 'retained synthetic state');
  const output = join(root, 'report');
  const result = spawnSync(process.execPath, ['spikes/development/product-test.mjs', '--scenario', 'coding-lifecycle', '--output', output], {
    env: { HOME: sentinel, CODEX_HOME: sentinel, CLAUDE_CONFIG_DIR: sentinel, PROVENANCE_VAULT: sentinel,
      NODE_OPTIONS: '--no-warnings', HTTPS_PROXY: 'https://unrelated.invalid' }, timeout: 15000, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout);
  const bytes = await readFile(join(output, 'result.json'), 'utf8'), report = JSON.parse(bytes);
  assert.equal(report.status, 'PASS'); assert.equal(report.liveEvidence, 'NOT_TESTED');
  assert.equal(report.dependencies.sponsor, 'DISABLED');
  assert.equal(report.scenarios[0].historyCount, 8); assert.equal(report.scenarios[0].checkpoints.length, 8);
  assert.match(report.scenarios[0].reproduction, /--scenario coding-lifecycle$/);
  assert.ok(bytes.length < 320 * 1024);
  assert.doesNotMatch(bytes, /SYNTHETIC_CODING_EXACT|hooks\.json|synthetic replacement|\/private\/tmp\//);
  assert.equal(await readFile(sentinel, 'utf8'), 'retained synthetic state');
  assert.deepEqual((await readdir(output)).sort(), ['diagnostics.json', 'report.html', 'result.json']);
  const again = spawnSync(process.execPath, ['spikes/development/product-test.mjs', '--scenario', 'coding-lifecycle', '--output', output], { env: {}, encoding: 'utf8' });
  assert.equal(again.status, 2); assert.equal(await readFile(join(output, 'result.json'), 'utf8'), bytes);
});
