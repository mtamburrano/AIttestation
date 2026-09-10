import { mkdir, cp, copyFile, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Developer-only preparation. The output must be a new explicit directory.
if (process.platform !== 'darwin' || process.argv.length !== 3) throw Error('Usage on macOS: node spikes/demonstrator/build-macos.mjs NEW_OUTPUT_DIRECTORY');
const start = performance.now(), output = resolve(process.argv[2]);
const root = fileURLToPath(new URL('../../', import.meta.url));
await stat(join(root, 'spikes/anchor/algorand/bin/verify'));
await mkdir(output, { mode: 0o700 });
const app = join(output, 'Private Provenance Demo.app'), contents = join(app, 'Contents');
await mkdir(join(contents, 'MacOS'), { recursive: true });
const resources = join(contents, 'Resources'); await mkdir(resources);
await copyFile(process.execPath, join(contents, 'MacOS', 'node'));
const moduleCache = join(output, '.swift-module-cache'); await mkdir(moduleCache);
try {
  execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', moduleCache, '-O', '-framework', 'Security',
    join(root, 'spikes/vault/native/macos-keychain-helper.swift'), '-o', join(contents, 'MacOS', 'provenance-keychain-helper')],
  { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
} finally { await rm(moduleCache, { recursive: true, force: true }); }
await copyFile(resolve(process.execPath, '../../LICENSE'), join(resources, 'Node-LICENSE.txt'));
for (const name of ['release', 'vault', 'anchor', 'demonstrator']) await cp(join(root, 'spikes', name), join(resources, 'spikes', name), {
  recursive: true, filter: source => !source.includes('/testdata') && !source.endsWith('/bin/live') && !source.endsWith('/.DS_Store'),
});
await writeFile(join(contents, 'MacOS', 'launch'), '#!/bin/sh\nAPP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec /usr/bin/env -i PATH=/usr/bin:/bin "$APP_DIR/MacOS/node" "$APP_DIR/Resources/spikes/demonstrator/main.mjs" --open\n', { mode: 0o755 });
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>launch</string><key>CFBundleIdentifier</key><string>local.provenance.demonstrator</string><key>CFBundleName</key><string>Private Provenance Demo</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/></dict></plist>`);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
await cp(join(root, 'spikes/demonstrator/WALKTHROUGH.md'), join(output, 'Start Here.md'));
await writeFile(join(output, 'build-measurement.json'), JSON.stringify({ platform: process.platform, arch: process.arch,
  node: process.version, buildMs: performance.now() - start, signature: 'AD_HOC_ONLY', notarized: false,
  storeDistributed: false, participantTerminalCommands: 0, manualInstallationMs: null, manualGatekeeperSteps: null }, null, 2));
console.log(app);
