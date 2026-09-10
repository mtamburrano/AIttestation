import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startDemo } from './server.mjs';
const started = performance.now();
const directory = await mkdtemp(join(tmpdir(), 'provenance-consumer-demo-'));
let child;
const measurement = { source: 'LOCAL_DEMO', platform: process.platform, arch: process.arch,
  startupMs: null, uiReadyMs: null, node: process.version, externalCalls: 0 };
const saveMeasurement = () => writeFile(join(directory, 'launch-measurement.json'), JSON.stringify(measurement), { mode: 0o600 });
const app = await startDemo(directory, {
  onClose: () => { if (child?.exitCode === null) child.kill(); },
  onReady: async () => { if (measurement.uiReadyMs === null) { measurement.uiReadyMs = performance.now() - started; await saveMeasurement(); } },
});
measurement.startupMs = performance.now() - started; await saveMeasurement();
if (process.argv.includes('--open')) {
  child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${join(directory, 'chrome-profile')}`, '--no-first-run', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--no-proxy-server', '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', app.url,
  ], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  child.on('exit', () => app.close());
  child.on('error', () => app.close());
} else console.log(`Synthetic-only local demonstrator: ${app.url}\nEncrypted temporary store: ${directory}`);
process.on('SIGINT', () => app.close());
process.on('SIGTERM', () => app.close());
