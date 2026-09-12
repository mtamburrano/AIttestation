import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonical } from '../vault/format.mjs';
import { RELEASE_CHANNELS } from './config.mjs';
import { dependencyInventory, sourceInventory, validateDependencyApproval } from './inventory.mjs';
import { readOnlyCommand } from './local.mjs';
import { sha256 } from './release.mjs';
import { assertCleanSource, inspectLocalHelperProfile, readReleaseApproval, readReleaseConfig, readUpdateSigningKey,
  validateBuildConfig, validateReleasePermissions } from './release-inputs.mjs';

const checks = ['LOCAL_SANDBOX', 'CONFIG_FILE', 'RELEASE_CONFIG', 'LOCAL_PERMISSIONS', 'CLEAN_SOURCE',
  'DEPENDENCY_INVENTORY', 'DEPENDENCY_APPROVAL', 'UPDATE_KEY', 'HELPER_PROFILE', 'INPUT_STABILITY'];
const emptyReport = () => ({ profile: 'pap-release-preflight/1', status: 'FAILED', releaseChannel: null,
  sourceDigest: null, dependencyDigest: null, failure: null,
  checks: checks.map(check => ({ check, status: 'NOT_RUN' })) });

export async function releasePreflight(root, configPath) {
  const report = emptyReport();
  let active;
  const check = async (name, action) => {
    active = report.checks.find(item => item.check === name);
    const value = await action(); active.status = 'PASSED'; return value;
  };
  try {
    await check('LOCAL_SANDBOX', () => {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error();
      readOnlyCommand('/usr/bin/true', []);
    });
    const config = await check('CONFIG_FILE', () => readReleaseConfig(configPath));
    await check('RELEASE_CONFIG', () => validateBuildConfig(config));
    report.releaseChannel = config.releaseChannel ?? RELEASE_CHANNELS.PRODUCTION;
    await check('LOCAL_PERMISSIONS', () => validateReleasePermissions(config));
    const source = await check('CLEAN_SOURCE', async () => {
      assertCleanSource(root, readOnlyCommand);
      return sourceInventory(root, { command: readOnlyCommand });
    });
    const inventory = await check('DEPENDENCY_INVENTORY', () => dependencyInventory(root,
      { goExecutable: config.goExecutable, command: readOnlyCommand }));
    const dependencyDigest = sha256(canonical(inventory));
    await check('DEPENDENCY_APPROVAL', async () => validateDependencyApproval(await readReleaseApproval(config), inventory));
    await check('UPDATE_KEY', async () => { await readUpdateSigningKey(config); });
    await check('HELPER_PROFILE', () => inspectLocalHelperProfile(config, readOnlyCommand));
    await check('INPUT_STABILITY', async () => {
      assertCleanSource(root, readOnlyCommand);
      const current = await dependencyInventory(root, { goExecutable: config.goExecutable, command: readOnlyCommand });
      if ((await sourceInventory(root, { command: readOnlyCommand })).sha256 !== source.sha256
          || sha256(canonical(current)) !== dependencyDigest
          || canonical(await readReleaseConfig(configPath)) !== canonical(config)) throw Error();
      await validateReleasePermissions(config);
      await readUpdateSigningKey(config);
      await inspectLocalHelperProfile(config, readOnlyCommand);
      validateDependencyApproval(await readReleaseApproval(config), current);
    });
    report.status = 'PASSED'; report.sourceDigest = source.sha256; report.dependencyDigest = dependencyDigest;
  } catch {
    active.status = 'FAILED'; report.failure = `${active.check}_REJECTED`;
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // No output file is opened by this command. Shell redirection is an explicit
  // operator choice; only this fixed schema can reach stdout or stderr.
  const emitFailure = failure => {
    process.stdout.write(`${JSON.stringify({ ...emptyReport(), failure })}\n`);
    process.exitCode = 1;
  };
  if (process.argv.length !== 3) emitFailure('USAGE_REQUIRES_CONFIG_PATH');
  else {
    const timeout = setTimeout(() => { emitFailure('PREFLIGHT_TIMEOUT'); process.exit(1); }, 120_000);
    try {
      const report = await releasePreflight(resolve(import.meta.dirname, '../..'), resolve(process.argv[2]));
      process.stdout.write(`${JSON.stringify(report)}\n`); process.exitCode = report.status === 'PASSED' ? 0 : 1;
    } catch { emitFailure('PREFLIGHT_FAILED'); }
    finally { clearTimeout(timeout); }
  }
}
