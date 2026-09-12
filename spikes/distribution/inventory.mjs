import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from './release.mjs';
import { canonical } from '../vault/format.mjs';

export async function fileInventory(directory, prefix = '') {
  const files = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, info = await lstat(join(directory, path));
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw Error('Inventory rejects links and special files');
    if (info.isDirectory()) files.push(...await fileInventory(directory, path));
    else files.push({ path, bytes: info.size, sha256: sha256(await readFile(join(directory, path))) });
  }
  return files;
}

export async function sourceInventory(root) {
  const paths = execFileSync('/usr/bin/git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  }).split('\0').filter(path => path === 'package.json' || path.startsWith('spikes/') || path.startsWith('test/'));
  const files = [];
  for (const path of [...new Set(paths)].sort()) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Source inventory rejects links');
    files.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  return { sha256: sha256(canonical(files)), files };
}

export async function dependencyInventory(root, { goExecutable = null } = {}) {
  const packageJSON = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (Object.keys(packageJSON.dependencies ?? {}).length || Object.keys(packageJSON.optionalDependencies ?? {}).length) {
    throw Error('New JavaScript dependencies require distribution inventory support');
  }
  const goMod = await readFile(join(root, 'spikes/anchor/algorand/go.mod'), 'utf8');
  const goSum = await readFile(join(root, 'spikes/anchor/algorand/go.sum'), 'utf8');
  const modules = [...goMod.matchAll(/^\s+([^\s]+) (v[^\s]+)(?: \/\/ indirect)?$/gm)].map(([, name, version]) => {
    const sum = goSum.split('\n').find(line => line.startsWith(`${name} ${version} `))?.split(' ')[2];
    if (!sum) throw Error('Dependency checksum missing');
    return { name, version, checksum: sum };
  }).sort((a, b) => a.name.localeCompare(b.name));
  let goToolchain = null;
  if (goExecutable) {
    const go = args => execFileSync(goExecutable, args, {
      env: { PATH: '/usr/bin:/bin', GOENV: 'off', GOTOOLCHAIN: 'local' }, encoding: 'utf8',
    }).trim();
    const goRoot = go(['env', 'GOROOT']);
    goToolchain = { sha256: sha256(await readFile(goExecutable)), version: go(['version']),
      licenseSha256: sha256(await readFile(join(goRoot, 'LICENSE'))),
      patentsSha256: sha256(await readFile(join(goRoot, 'PATENTS'))) };
  }
  return { profile: 'pap-dependency-inventory/1', javascriptPackages: [],
    node: { version: process.version, sha256: sha256(await readFile(process.execPath)), components: { ...process.versions },
      licenseSha256: sha256(await readFile(resolve(process.execPath, '../../LICENSE'))) },
    goToolchain,
    noticesDigest: sha256(await readFile(join(root, 'spikes/distribution/THIRD_PARTY_NOTICES.md'))),
    goModDigest: sha256(goMod), goSumDigest: sha256(goSum), modules,
    reviewScope: 'Exact pins and runtime components; independent security and license approval required before release.' };
}
