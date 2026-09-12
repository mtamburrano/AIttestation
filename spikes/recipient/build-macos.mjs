import { mkdir, copyFile, writeFile, rm, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function assertPortableExecutable(executable) {
  const libraries = execFileSync('/usr/bin/otool', ['-L', executable], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    .split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  if (!libraries.length || libraries.some(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'))) {
    throw Error('Portable packaging requires a self-contained Node/native executable with only macOS system libraries; Homebrew external dylibs are not bundled.');
  }
}

export async function buildRecipient(output) {
  if (process.platform !== 'darwin') throw Error('macOS recipient builder required');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assertPortableExecutable(process.execPath);
  assertPortableExecutable(join(root, 'spikes/anchor/algorand/bin/verify'));
  await mkdir(output, { mode: 0o700 });
  const app = join(output, 'Attestamp Verifier.app'), contents = join(app, 'Contents');
  const macos = join(contents, 'MacOS'), resources = join(contents, 'Resources');
  await mkdir(macos, { recursive: true }); await mkdir(resources);
  await copyFile(process.execPath, join(macos, 'node'));
  await copyFile(resolve(process.execPath, '../../LICENSE'), join(resources, 'Node-LICENSE.txt'));
  for (const file of ['vault/format.mjs', 'vault/records.mjs', 'anchor/verifier.mjs', 'anchor/merkle.mjs', 'anchor/algorand/bin/verify',
    ...['portable.mjs', 'verify.mjs', 'server.mjs', 'main.mjs', 'recipient.html', 'recipient.js', 'recipient.css'].map(name => `recipient/${name}`)]) {
    const destination = join(resources, 'spikes', file); await mkdir(resolve(destination, '..'), { recursive: true });
    await copyFile(join(root, 'spikes', file), destination);
  }
  const cache = join(output, '.swift-module-cache'); await mkdir(cache);
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache, '-O', '-framework', 'Security',
      join(root, 'spikes/recipient/macos-verifier-host.swift'), '-o', join(macos, 'provenance-verifier-host')],
    { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
  } finally { await rm(cache, { recursive: true, force: true }); }
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>provenance-verifier-host</string><key>CFBundleIdentifier</key><string>ai.provenance.verifier.host</string><key>CFBundleName</key><string>Attestamp Verifier</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>15.7</string><key>LSUIElement</key><true/></dict></plist>`);
  for (const [path, id] of [[join(macos, 'node'), 'ai.provenance.verifier.runtime'],
    [join(resources, 'spikes/anchor/algorand/bin/verify'), 'ai.provenance.verifier.algorand']]) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', id, path], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
  }
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
  await cp(join(root, 'spikes/recipient/README.md'), join(output, 'Verify locally.md'));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: node build-macos.mjs NEW_OUTPUT_DIRECTORY');
  console.log(await buildRecipient(resolve(process.argv[2])));
}
