import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MacOSKeychainStore } from '../vault/key-lifecycle.mjs';
import { ManagedAnchoringClient } from '../managed/client.mjs';
import { startPackagedChatGPT } from '../browser/chatgpt/runtime-main.mjs';
import { DEVELOPMENT_PROFILE, validateAccount, privateJSON, writeNewJSON, exists } from './environment.mjs';
import { atomicWrite } from '../distribution/files.mjs';
import { privateInstallation } from './integration.mjs';
import { checkPlatform, launchDevelopmentChrome } from './chrome.mjs';
import { localTLSRequest } from './tls.mjs';
import { backupDevelopment, restoreDevelopment } from './recovery.mjs';
import { startupFailure } from './startup.mjs';
import { OwnerDebugSession } from './debug-session.mjs';
import { publishRuntimeState } from './runtime-state.mjs';

let runtime, statePath, debugSession;
try {
  const paths = await validateAccount();
  const launchPath = join(paths.control, 'launch.json'), desktopPath = join(paths.control, 'desktop.json');
  const explicitLaunch = await exists(launchPath);
  const request = await privateJSON(explicitLaunch ? launchPath : desktopPath);
  if (!explicitLaunch && request.mode !== 'live-chatgpt-testnet') throw Error('EXPLICIT_PRIVATE_OPERATION_REQUIRED');
  const fields = { 'live-chatgpt-testnet': 'chromeApplication,mode,profile', backup: 'mode,outputDirectory,profile',
    restore: 'mode,outputDirectory,packageFile,profile,secretFile' };
  if (request.profile !== DEVELOPMENT_PROFILE || !Object.hasOwn(fields, request.mode)
      || Object.keys(request).sort().join(',') !== fields[request.mode]) throw Error('EXPLICIT_PRIVATE_OPERATION_REQUIRED');
  const config = JSON.parse(await readFile(new URL('private-development.json', import.meta.url)));
  if (Object.keys(config).sort().join(',') !== 'assurance,browserPolicy,profile,sponsorOrigin,updaterEnabled'
      || config.profile !== DEVELOPMENT_PROFILE || config.assurance !== 'PRIVATE_TESTNET_ONLY'
      || config.browserPolicy !== 'EXPLICIT_TEST_USER_COPY' || config.updaterEnabled !== false) throw Error('INVALID_PRIVATE_BUILD');
  // Revalidate the explicit copy inside the signed runtime before opening the
  // vault; launcher state is not a substitute for browser identity validation.
  const chrome = request.mode === 'live-chatgpt-testnet' ? await checkPlatform(request.chromeApplication, paths) : null;
  if (explicitLaunch) await unlink(launchPath);
  const keyStore = new MacOSKeychainStore();
  if (request.mode !== 'live-chatgpt-testnet') {
    const report = request.mode === 'backup'
      ? await backupDevelopment(paths, request.outputDirectory, keyStore)
      : await restoreDevelopment(paths, request.outputDirectory, request.packageFile, request.secretFile, keyStore);
    await writeNewJSON(join(paths.control, 'operation.json'), report);
    process.exit(0);
  }
  const managed = config.sponsorOrigin === null ? null : new ManagedAnchoringClient({
    origin: config.sponsorOrigin, keyStore,
    request: localTLSRequest(await readFile(new URL('sponsor-certificate.pem', import.meta.url)), config.sponsorOrigin),
  });
  debugSession = new OwnerDebugSession(paths.control);
  runtime = await startPackagedChatGPT({ supportDirectory: paths.support, keyStore, managed,
    diagnostics: debugSession.diagnostics, debugSession,
    installation: privateInstallation(paths, join(dirname(process.execPath), 'provenance-browser-host')),
    desktopChannel: process.argv.includes('--resident') ? { requestFD: 6, responseFD: 7 } : null,
    openDashboard: url => launchDevelopmentChrome(chrome, paths, url) });
  // Reopening restores only the consented browser location, never a scope or send.
  if (explicitLaunch) await atomicWrite(desktopPath, JSON.stringify(request));
  await launchDevelopmentChrome(chrome, paths, 'about:blank');
  statePath = await publishRuntimeState(paths.control, runtime);
  process.once('beforeExit', () => unlink(statePath).catch(() => {}));
  const stop = async code => {
    await runtime.close(); debugSession.close(); await unlink(statePath).catch(() => {}); process.exit(code);
  };
  process.once('SIGINT', () => stop(0)); process.once('SIGTERM', () => stop(0));
} catch (error) {
  await runtime?.close();
  debugSession?.close();
  process.stderr.write(`${startupFailure(error)}\n`); process.exitCode = 1;
}
