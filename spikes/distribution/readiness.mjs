import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, chmod, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical } from '../vault/format.mjs';
import { localGit } from './local.mjs';
import { sha256 } from './release.mjs';
import { assertCleanSource } from './release-inputs.mjs';
import { verifyDistribution } from './verify-artifacts.mjs';
import { readinessManifest, ownerActions } from './readiness-plan.mjs';
import { verifyPackagedReceipt } from '../../test/packaged-readiness-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), full = args.includes('--full'), paths = args.filter(arg => arg !== '--full');
const report = { profile: 'attestamp-offline-readiness/1', status: 'FAIL', releaseReady: false,
  authority: 'NONE', checks: [], ownerActionRequired: ownerActions };
let work, output, ownedOutput = false;
try {
  if (paths.length !== 1 || args.length !== paths.length + Number(full)) throw Error('USAGE_NEW_OUTPUT_OPTIONAL_FULL');
  assertCleanSource(root);
  report.revision = localGit(root, ['rev-parse', 'HEAD']).trim();
  output = resolve(paths[0]); await mkdir(output, { mode: 0o700 }); ownedOutput = true;
  work = await mkdtemp(join(tmpdir(), 'attestamp-readiness-work-')); await mkdir(join(work, 'home'));
  const env = { PATH: '/usr/bin:/bin', HOME: join(work, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GOENV: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOTELEMETRY: 'off' };
  const source = join(work, 'checkout');
  const run = (name, exe, command, cwd = source, timeout = 180_000) => {
    const result = spawnSync(exe, command, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    const passed = !result.error && result.status === 0;
    report.checks.push({ name, status: passed ? 'PASS' : 'FAIL', exitCode: result.status,
      ...(command[0] === '--test' ? { tests: Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0),
        passed: Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1] ?? 0), failed: Number(/^# fail (\d+)$/m.exec(result.stdout)?.[1] ?? 0) } : {}) });
    if (!passed) throw Error(name);
    return result;
  };
  run('clean-source-clone', '/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--local', '--no-hardlinks', root, source], root);
  const helpers = join(source, 'spikes/anchor/algorand/bin'); await mkdir(helpers);
  report.goHelperInputs = [];
  for (const name of ['verify', 'fast-verify', 'fast-observe']) {
    const from = join(root, 'spikes/anchor/algorand/bin', name), info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024 || info.mode & 0o022) throw Error('SAFE_OFFLINE_GO_HELPERS_REQUIRED');
    const digest = sha256(await readFile(from)); await copyFile(from, join(helpers, name)); await chmod(join(helpers, name), 0o700);
    if (sha256(await readFile(join(helpers, name))) !== digest) throw Error('GO_HELPER_INPUT_CHANGED');
    report.goHelperInputs.push({ name, sha256: digest, bytes: info.size });
  }
  report.nativeToolSourceRebuilt = false;
  const manifest = await readinessManifest(source); await writeFile(join(output, 'release-manifest.json'), canonical(manifest), { flag: 'wx', mode: 0o600 });
  run('contributor-smoke-and-hygiene', process.execPath, ['spikes/development/bootstrap.mjs']);
  run('dependency-inventory', process.execPath, ['spikes/development/dependency-report.mjs', join(output, 'repository-dependencies.json')]);
  const tests = full ? (await readdir(join(source, 'test'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`)
    : ['test/readiness.test.mjs', 'test/artifact-policy.test.mjs', 'test/release-preflight.test.mjs', 'test/package-leaks.test.mjs', 'test/recipient.test.mjs'];
  run(full ? 'consolidated-deterministic-regressions' : 'distribution-and-verifier-regressions', process.execPath,
    ['--test', '--test-concurrency=1', ...tests], source, full ? 600_000 : 180_000);
  if (!full) run('release-rehearsal', process.execPath, ['spikes/development/product-test.mjs', '--suite', 'release', '--output', join(output, 'release-rehearsal')]);
  run('coding-lifecycle', process.execPath, ['spikes/development/product-test.mjs', '--scenario', 'coding-lifecycle', '--output', join(output, 'coding')]);
  const bundle = join(output, 'development-package');
  run('fresh-development-package', process.execPath, ['spikes/distribution/build-macos.mjs', '--prepare', bundle]);
  const artifact = await verifyDistribution(bundle, { releaseChannel: 'development', sourceDigest: manifest.sourceDigest });
  await writeFile(join(output, 'artifact-policy.json'), canonical(artifact), { flag: 'wx', mode: 0o600 });
  if (artifact.status !== 'PASSED' || artifact.releaseReady) throw Error('DEVELOPMENT_ARTIFACT_POLICY');
  report.checks.push({ name: 'exact-package-policy-and-leaks', status: 'PASS' });
  for (const app of ['Attestamp.app', 'Recipient/Attestamp Verifier.app'])
    run('ad-hoc-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', join(bundle, app)]);
  if (!(await readFile(join(bundle, 'Mac Connections.md'), 'utf8')).includes('Find installed clients')
      || !(await readFile(join(bundle, 'Attestamp.app/Contents/Resources/spikes/browser/chatgpt/dashboard.html'), 'utf8')).includes('integration-discover')) throw Error('ONBOARDING_ASSETS_MISSING');
  try { report.packagedVerifier = await verifyPackagedReceipt(bundle, work); }
  catch { throw Error('PACKAGED_VERIFIER_FIXTURE_FAILED'); }
  const provenance = JSON.parse(await readFile(join(bundle, 'build-provenance.json')));
  report.provenance = { sourceDigest: manifest.sourceDigest, dependencyDigest: provenance.dependencyDigest,
    repositoryDependencyDigest: manifest.repositoryDependencyDigest, buildProvenanceDigest: sha256(canonical(provenance)) };
  assertCleanSource(root); if (localGit(root, ['rev-parse', 'HEAD']).trim() !== report.revision) throw Error('SOURCE_CHANGED_DURING_READINESS');
  report.status = 'PASS'; report.externalGates = 'OWNER_ACTION_REQUIRED';
} catch (error) {
  report.failure = typeof error.message === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.message) ? error.message : 'READINESS_PREREQUISITE_OR_CHECK_FAILED';
} finally {
  if (work) await rm(work, { recursive: true, force: true });
  if (ownedOutput) await writeFile(join(output, 'readiness.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1;
