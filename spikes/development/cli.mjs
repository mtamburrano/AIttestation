import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { codeSignatureCheckArguments } from '../distribution/local.mjs';
import { CHROME, DEVELOPMENT_PROFILE, assertPlatform, exists, initializeAccount, ownerDirectory,
  privateJSON, testAccount, validateAccount, writeNewJSON } from './environment.mjs';

const run = (command, args) => execFileSync(command, args, {
  env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: 'pipe', timeout: 15000,
});

export function checkPlatform() {
  assertPlatform({ platform: process.platform, arch: process.arch,
    osVersion: run('/usr/bin/sw_vers', ['-productVersion']).trim(),
    chromeVersion: run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString',
      '/Applications/Google Chrome.app/Contents/Info.plist']).trim() });
  try {
    run('/usr/bin/codesign', codeSignatureCheckArguments(CHROME,
      'anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"'));
  } catch { throw Error('CHROME_SIGNATURE_REJECTED'); }
}

export async function registerNativeHost(paths, browserHost) {
  const directory = join(paths.chrome, 'NativeMessagingHosts');
  if (!await exists(directory)) await mkdir(directory, { mode: 0o700 });
  await ownerDirectory(directory);
  const target = join(directory, 'ai.provenance.consumer.json');
  const manifest = { name: 'ai.provenance.consumer', description: 'Attestamp private development bridge',
    path: browserHost, type: 'stdio', allowed_origins: ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/'] };
  const ownership = join(paths.control, 'registration.json');
  if (await exists(target)) throw Error('NATIVE_REGISTRATION_ALREADY_EXISTS');
  // Journal ownership before installation; an interrupted install is safe to remove.
  await writeNewJSON(ownership, manifest);
  try { await writeNewJSON(target, manifest); }
  catch (error) { await unlink(ownership); throw error; }
}

export async function removeNativeHost(paths) {
  const ownership = join(paths.control, 'registration.json');
  if (!await exists(ownership)) return;
  const expected = await privateJSON(ownership);
  const target = join(paths.chrome, 'NativeMessagingHosts/ai.provenance.consumer.json');
  if (await exists(target)) {
    if (JSON.stringify(await privateJSON(target)) !== JSON.stringify(expected)) throw Error('NATIVE_REGISTRATION_CHANGED');
    await unlink(target);
  }
  await unlink(ownership);
}

export async function stopDevelopment() {
  const paths = await validateAccount(), state = join(paths.control, 'runtime.json');
  if (await exists(state)) {
    const entry = await privateJSON(state), url = new URL(entry.composerURL);
    if (entry.profile !== DEVELOPMENT_PROFILE || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || url.pathname !== '/' || url.search || url.username || url.password || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)) {
      throw Error('INVALID_PRIVATE_RUNTIME_STATE');
    }
    let alreadyExited = false;
    try {
      const response = await fetch(new URL('/close', url), { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(5000), headers: { Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw Error('PRIVATE_RUNTIME_STOP_REJECTED');
    } catch (error) {
      // A dead runtime has no authority; never signal a stored PID or another app.
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
      alreadyExited = true;
    }
    if (alreadyExited) await unlink(state);
    else {
      // The HTTP acknowledgment precedes draining admitted work. Wait for the
      // runtime's exit marker before removing registration or starting again.
      for (let i = 0; i < 300 && await exists(state); i++) await delay(100);
      if (await exists(state)) throw Error('PRIVATE_RUNTIME_STILL_DRAINING');
    }
  }
  await removeNativeHost(paths);
  const launch = join(paths.control, 'launch.json');
  if (await exists(launch)) await unlink(launch);
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
  return app;
}

export async function startDevelopment(output, mode) {
  if (mode !== '--live-chatgpt-testnet') throw Error('EXPLICIT_LIVE_TEST_OPT_IN_REQUIRED');
  const paths = await validateAccount(); checkPlatform();
  const app = await privateApplication(output);
  if (await exists(join(paths.control, 'runtime.json'))) throw Error('STOP_PREVIOUS_PRIVATE_RUNTIME_FIRST');
  await registerNativeHost(paths, join(app, 'Contents/MacOS/provenance-browser-host'));
  try {
    await writeNewJSON(join(paths.control, 'launch.json'), { profile: DEVELOPMENT_PROFILE, mode: 'live-chatgpt-testnet' });
    const child = spawn(join(app, 'Contents/MacOS/provenance-app-host'), [], {
      env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', detached: true,
    });
    let exited = false; child.once('exit', () => { exited = true; }); child.once('error', () => { exited = true; });
    child.unref();
    for (let i = 0; i < 150; i++) {
      if (await exists(join(paths.control, 'runtime.json'))) return { started: true, pairing: 'OPEN_CHROME_EXTENSIONS_AND_LOAD_UNPACKED',
        assurance: 'PRIVATE_TESTNET_ONLY' };
      if (exited) break;
      await delay(100);
    }
    throw Error('PRIVATE_APP_START_NOT_CONFIRMED');
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
  if (action === 'doctor' && rest.length === 0) { checkPlatform(); testAccount(); return { ready: true, liveCheck: 'NOT_RUN' }; }
  if (action === 'init' && rest.length === 0) { await initializeAccount(); return { initialized: true }; }
  if (action === 'prepare' && rest.length === 2) {
    const { prepareDevelopment } = await import('./prepare.mjs'); return prepareDevelopment(...rest);
  }
  if (action === 'start' && rest.length === 2) return startDevelopment(...rest);
  if (action === 'stop' && rest.length === 0) return stopDevelopment();
  if (action === 'backup' && rest.length === 2) return maintenance(rest[0], { mode: 'backup', outputDirectory: rest[1] });
  if (action === 'restore' && rest.length === 4) return maintenance(rest[0], { mode: 'restore',
    outputDirectory: rest[1], packageFile: rest[2], secretFile: rest[3] });
  throw Error('USAGE: dev doctor|init|prepare CONFIG NEW_BUILD|start BUILD --live-chatgpt-testnet|stop|backup BUILD NEW_DIRECTORY|restore BUILD NEW_DIRECTORY PACKAGE SECRET');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  command(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'PRIVATE_DEVELOPMENT_COMMAND_FAILED');
    process.exitCode = 1;
  });
}
