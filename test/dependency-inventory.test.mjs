import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryDependencyInventory } from '../spikes/distribution/inventory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('repository inventory is deterministic, notice-bound and contains no host or approval identity', async () => {
  const report = await repositoryDependencyInventory(root);
  assert.deepEqual(report, await repositoryDependencyInventory(root));
  assert.equal(report.modules.length, 9); assert.equal(report.javascriptPackages.length, 1);
  assert.ok(report.modules.every(value => value.checksum.startsWith('h1:') && value.noticeSha256.length === 64));
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|\/private\/|securityApproved|licensesApproved/);
});

test('inventory rejects missing notices, unlisted dependencies and changed vendored inputs', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'attestamp-inventory-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const file of ['package.json', 'LICENSE.md', 'spikes/anchor/algorand/go.mod', 'spikes/anchor/algorand/go.sum',
    'spikes/distribution/THIRD_PARTY_NOTICES.md', 'spikes/distribution/dependency-licenses.json', 'spikes/coding/vendor/smol-toml']) {
    await mkdir(dirname(join(temporary, file)), { recursive: true }); await cp(join(root, file), join(temporary, file), { recursive: true });
  }
  const notices = join(temporary, 'spikes/distribution/THIRD_PARTY_NOTICES.md'), original = await readFile(notices);
  await writeFile(notices, ''); await assert.rejects(repositoryDependencyInventory(temporary), /NOTICE/); await writeFile(notices, original);
  const pkgPath = join(temporary, 'package.json'), pkg = JSON.parse(await readFile(pkgPath));
  await writeFile(pkgPath, JSON.stringify({ ...pkg, devDependencies: { unexpected: '1' } }));
  await assert.rejects(repositoryDependencyInventory(temporary), /UNINVENTORIED/); await writeFile(pkgPath, JSON.stringify(pkg));
  const goPath = join(temporary, 'spikes/anchor/algorand/go.mod'), goOriginal = await readFile(goPath);
  await writeFile(goPath, goOriginal + '\nrequire example.invalid/new v1.0.0\n');
  await assert.rejects(repositoryDependencyInventory(temporary), /UNSUPPORTED_GO_MODULE_SYNTAX/); await writeFile(goPath, goOriginal);
  await writeFile(join(temporary, 'spikes/coding/vendor/smol-toml/index.cjs'), 'changed');
  await assert.rejects(repositoryDependencyInventory(temporary), /VENDORED_DEPENDENCY_CHANGED/);
});
