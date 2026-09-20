import { mkdir, cp, copyFile, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildRecipient, assertPortableExecutable } from '../../recipient/build-macos.mjs';
import { applicationResourceDirectories, copyApplicationResource, managedResourceFiles } from '../../distribution/package-resources.mjs';
import { assertObserverBundle } from './build-observer.mjs';

if (process.platform !== 'darwin' || process.argv.length !== 3) {
  throw Error('Usage on macOS: node spikes/browser/chatgpt/build-macos.mjs NEW_OUTPUT_DIRECTORY');
}
const started = performance.now(), output = resolve(process.argv[2]);
await assertObserverBundle();
const root = fileURLToPath(new URL('../../../', import.meta.url));
assertPortableExecutable(process.execPath);
await Promise.all(['verify', 'fast-verify', 'fast-observe'].map(name => stat(join(root, 'spikes/anchor/algorand/bin', name))));
await mkdir(output, { mode: 0o700 });
const app = join(output, 'Attestamp.app'), contents = join(app, 'Contents');
await mkdir(join(contents, 'MacOS'), { recursive: true });
const resources = join(contents, 'Resources'); await mkdir(resources);
await copyFile(process.execPath, join(contents, 'MacOS', 'node'));
const moduleCache = join(output, '.swift-module-cache'); await mkdir(moduleCache);
try {
  for (const [source, executable, definitions] of [
    [join(root, 'spikes/vault/native/macos-app-host.swift'), 'provenance-app-host', ['-D', 'PRODUCT_CHATGPT']],
    [join(root, 'spikes/vault/native/macos-keychain-helper.swift'), 'provenance-keychain-helper', []],
    [join(root, 'spikes/browser/chatgpt/native/macos-browser-host.swift'), 'provenance-browser-host', []],
    [join(root, 'spikes/browser/chatgpt/native/macos-peer-validator.swift'), 'provenance-bridge-peer-validator', []],
  ]) execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', moduleCache, '-O', ...definitions,
    '-framework', 'Security', source, '-o', join(contents, 'MacOS', executable)],
  { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
} finally { await rm(moduleCache, { recursive: true, force: true }); }
await copyFile(resolve(process.execPath, '../../LICENSE'), join(resources, 'Node-LICENSE.txt'));
for (const name of applicationResourceDirectories) {
  await cp(join(root, 'spikes', name), join(resources, 'spikes', name), {
    recursive: true,
    filter: source => copyApplicationResource(relative(root, source)),
  });
}
await mkdir(join(resources, 'spikes/managed'));
for (const path of managedResourceFiles) {
  await copyFile(join(root, path), join(resources, path));
}
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>provenance-app-host</string><key>CFBundleIdentifier</key><string>ai.provenance.consumer.host</string><key>CFBundleName</key><string>Attestamp</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>15.7</string><key>LSUIElement</key><true/></dict></plist>`);
for (const [executable, identifier] of [
  [join(contents, 'MacOS/node'), 'ai.provenance.consumer.runtime'],
  [join(contents, 'MacOS/provenance-keychain-helper'), 'ai.provenance.keychain-helper'],
  [join(contents, 'MacOS/provenance-browser-host'), 'ai.provenance.consumer.browser-host'],
  [join(contents, 'MacOS/provenance-bridge-peer-validator'), 'ai.provenance.consumer.bridge-peer-validator'],
]) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, executable],
{ env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });

const nativeManifestDirectory = join(output, 'NativeMessagingHosts'); await mkdir(nativeManifestDirectory);
await writeFile(join(nativeManifestDirectory, 'ai.provenance.consumer.json'), JSON.stringify({
  name: 'ai.provenance.consumer', description: 'Private Provenance fixed-purpose ChatGPT bridge',
  path: join(contents, 'MacOS/provenance-browser-host'), type: 'stdio',
  allowed_origins: ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/'],
}, null, 2));
await cp(join(root, 'spikes/browser/chatgpt/README.md'), join(output, 'Start Here.md'));
await buildRecipient(join(output, 'Recipient'));
await writeFile(join(output, 'build-measurement.json'), JSON.stringify({
  platform: process.platform, arch: process.arch, node: process.version,
  buildMs: performance.now() - started, signature: 'AD_HOC_ONLY', notarized: false,
  storeDistributed: false, nativeHostManifestInstalled: false,
}, null, 2));
console.log(app);
