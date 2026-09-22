import { validateRuntimeState } from './runtime-state.mjs';
import { requestPrivateExit } from './stop.mjs';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkPlatform } from './chrome.mjs';
import { developmentCommandFailure, readStartupFailure } from './startup.mjs';
import { DEVELOPMENT_PROFILE, exists, initializeAccount, ownerDirectory,
  privateJSON, validateAccount, writeNewJSON } from './environment.mjs';

const run = (command, args) => execFileSync(command, args, {
  env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: 'pipe', timeout: 15000,
});

import { registerNativeHost, removeNativeHost } from './integration.mjs';
export { registerNativeHost, removeNativeHost };

async function stopStage(label, action) {
  try { return await action(); } catch { throw Error(`PRIVATE_STOP_${label}`); }
}

export async function stopDevelopment(accountPaths, { requestExit = requestPrivateExit, wait = delay } = {}) {
  const paths = await stopStage('ACCOUNT_INVALID', () => validateAccount(accountPaths));
  const state = join(paths.control, 'runtime.json');
  const present = () => stopStage('RUNTIME_UNREADABLE', () => exists(state));
  const readState = async () => {
    let entry;
    try { entry = await privateJSON(state); }
    catch (error) {
      // The engine removes the locator after drain; it can disappear between
      // exists() and the guarded read without indicating an unsafe file.
      if (error.code === 'ENOENT' && !await present()) return null;
      throw Error('PRIVATE_STOP_RUNTIME_UNREADABLE');
    }
    return stopStage('RUNTIME_INVALID', () => validateRuntimeState(entry));
  };
  const entry = await present() ? await readState() : null;
  if (entry) {
    const sameState = async () => {
      if (!await present()) return false;
      const current = await readState();
      if (!current) return false;
      if (current.dashboardURL !== entry.dashboardURL) throw Error('PRIVATE_STOP_RUNTIME_CHANGED');
      return true;
    };
    let result;
    try { result = await requestExit(new URL(entry.dashboardURL)); }
    catch (error) {
      if (error?.message !== 'PRIVATE_STOP_EXIT_TIMED_OUT') throw error;
      // Losing the reply does not cancel engine shutdown. Reconcile only the
      // original locator; never send another exit request or follow a new one.
      result = 'TIMED_OUT';
    }
    if (result === 'ALREADY_EXITED') {
      if (await sameState()) await stopStage('RUNTIME_CLEANUP_FAILED', () => unlink(state));
    } else if (result === 'ACCEPTED' || result === 'TIMED_OUT') {
      // Neither an acknowledgment nor a timeout proves drain is complete.
      // Locator removal authorizes cleanup; a replacement still fails closed.
      for (let i = 0; i < 300 && await sameState(); i++) await wait(100);
      if (await sameState()) throw Error(result === 'TIMED_OUT'
        ? 'PRIVATE_STOP_EXIT_TIMED_OUT' : 'PRIVATE_STOP_STILL_DRAINING');
    } else throw Error('PRIVATE_STOP_EXIT_INVALID_RESPONSE');
  }
  if (await present()) throw Error('PRIVATE_STOP_RUNTIME_CHANGED');
  const launch = join(paths.control, 'launch.json');
  const hasLaunch = await stopStage('LAUNCH_UNREADABLE', () => exists(launch));
  if (hasLaunch) {
    const entry = await stopStage('LAUNCH_UNREADABLE', () => privateJSON(launch));
    if (entry?.profile !== DEVELOPMENT_PROFILE || !['live-chatgpt-testnet', 'backup', 'restore'].includes(entry.mode)) {
      throw Error('PRIVATE_STOP_LAUNCH_INVALID');
    }
  }
  await stopStage('REGISTRATION_CLEANUP_FAILED', () => removeNativeHost(paths));
  if (hasLaunch) await stopStage('LAUNCH_CLEANUP_FAILED', () => unlink(launch));
  return { stopped: true, evidence: 'RETAINED', browser: 'CLOSE_TEST_CHROME_MANUALLY' };
}

async function privateApplication(output) {
  await ownerDirectory(output);
  const metadata = await privateJSON(join(output, 'private-build.json'));
  if (metadata.profile !== DEVELOPMENT_PROFILE || metadata.releaseClass !== 'PRIVATE_DEVELOPMENT'
      || metadata.updaterEnabled !== false) throw Error('INVALID_PRIVATE_BUILD');
  const app = join(output, 'package/Attestamp.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const manifest = JSON.parse(await readFile(join(app, 'Contents/Resources/spikes/development/private-development.json')));
  if (manifest.profile !== DEVELOPMENT_PROFILE) throw Error('PRIVATE_ENTRYPOINT_REQUIRED');
  if (manifest.browserPolicy !== 'EXPLICIT_TEST_USER_COPY') throw Error('PRIVATE_BUILD_REQUIRES_CHROME_PATH_SUPPORT');
  return app;
}

export async function startDevelopment(output, mode, chromeApplication) {
  if (mode !== '--live-chatgpt-testnet') throw Error('EXPLICIT_LIVE_TEST_OPT_IN_REQUIRED');
  const paths = await validateAccount(); await checkPlatform(chromeApplication, paths);
  const app = await privateApplication(output);
  if (await exists(join(paths.control, 'runtime.json'))) throw Error('STOP_PREVIOUS_PRIVATE_RUNTIME_FIRST');
  await registerNativeHost(paths, join(app, 'Contents/MacOS/provenance-browser-host'));
  try {
    await writeNewJSON(join(paths.control, 'launch.json'), { profile: DEVELOPMENT_PROFILE, mode: 'live-chatgpt-testnet', chromeApplication });
    const child = spawn(join(app, 'Contents/MacOS/provenance-app-host'), [], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    });
    let exited = false, diagnostics = '';
    child.stderr.on('data', bytes => { diagnostics += bytes.toString('utf8').slice(0, 4096 - diagnostics.length); });
    child.stderr.unref();
    child.once('close', () => { exited = true; }); child.once('error', () => { exited = true; });
    child.unref();
    for (let i = 0; i < 150; i++) {
      if (await exists(join(paths.control, 'runtime.json'))) return { started: true, pairing: 'OPEN_CHROME_EXTENSIONS_AND_LOAD_UNPACKED',
        assurance: 'PRIVATE_TESTNET_ONLY' };
      if (exited) break;
      await delay(100);
    }
    throw Error(readStartupFailure(diagnostics));
  } catch (error) {
    // Keep a possibly running app's registration until an explicit stop drains it.
    throw error;
  }
}

async function maintenance(output, operation) {
  const paths = await validateAccount(), app = await privateApplication(output);
  if (await exists(join(paths.control, 'runtime.json'))) throw Error('STOP_PRIVATE_RUNTIME_BEFORE_RECOVERY');
  const reportPath = join(paths.control, 'operation.json');
  if (await exists(reportPath)) throw Error('PREVIOUS_RECOVERY_REPORT_REQUIRES_INSPECTION');
  await writeNewJSON(join(paths.control, 'launch.json'), { profile: DEVELOPMENT_PROFILE, ...operation });
  const status = await new Promise((resolve, reject) => {
    const child = spawn(join(app, 'Contents/MacOS/provenance-app-host'), [], {
      env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore',
    });
    child.once('error', reject); child.once('exit', code => resolve(code));
  });
  if (status !== 0) throw Error('PRIVATE_RECOVERY_FAILED');
  const report = await privateJSON(reportPath); await unlink(reportPath); return report;
}

export async function command(args) {
  const [action, ...rest] = args;
  if (action === 'doctor' && rest.length === 2 && rest[0] === '--chrome-app') {
    await checkPlatform(rest[1]); return { ready: true, liveCheck: 'NOT_RUN' };
  }
  if (action === 'init' && rest.length === 0) { await initializeAccount(); return { initialized: true }; }
  if (action === 'signing-preflight' && rest.length === 1) {
    const { developmentSigningInputs } = await import('./prepare.mjs');
    const { preflightSigning, ownerAction } = await import('./signing.mjs');
    try { return await preflightSigning((await developmentSigningInputs(rest[0])).config); }
    catch { return ownerAction('SIGNING_INPUTS_INVALID'); }
  }
  if (action === 'prepare' && rest.length === 2) {
    const { prepareDevelopment } = await import('./prepare.mjs'); return prepareDevelopment(...rest);
  }
  if (action === 'start' && rest.length === 4 && rest[1] === '--chrome-app') return startDevelopment(rest[0], rest[3], rest[2]);
  if (action === 'stop' && rest.length === 0) return stopDevelopment();
  if (action === 'backup' && rest.length === 2) return maintenance(rest[0], { mode: 'backup', outputDirectory: rest[1] });
  if (action === 'restore' && rest.length === 4) return maintenance(rest[0], { mode: 'restore',
    outputDirectory: rest[1], packageFile: rest[2], secretFile: rest[3] });
  throw Error('USAGE: dev doctor --chrome-app APP|init|signing-preflight CONFIG|prepare CONFIG NEW_BUILD|start BUILD --chrome-app APP --live-chatgpt-testnet|stop|backup BUILD NEW_DIRECTORY|restore BUILD NEW_DIRECTORY PACKAGE SECRET');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  command(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result));
    if (result.status === 'OWNER_ACTION_REQUIRED') process.exitCode = 2;
  }).catch(error => {
    console.error(developmentCommandFailure(error));
    process.exitCode = 1;
  });
}
