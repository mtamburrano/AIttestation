import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from './release.mjs';
import { canonical } from '../vault/format.mjs';
import { localCommand, localGit } from './local.mjs';

export async function fileInventory(directory, prefix = '') {
  if (!(await lstat(join(directory, prefix))).isDirectory()) throw Error('Inventory requires a directory without links');
  const files = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, info = await lstat(join(directory, path));
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) || (!info.isFile() && !info.isDirectory())) {
      throw Error('Inventory rejects links and special files');
    }
    if (info.isDirectory()) files.push(...await fileInventory(directory, path));
    else files.push({ path, bytes: info.size, sha256: sha256(await readFile(join(directory, path))) });
  }
  return files;
}

async function inputTreeInventory(directory) {
  if (await realpath(directory) !== resolve(directory)) throw Error('Build input inventory rejects linked paths');
  const files = await fileInventory(directory);
  return { sha256: sha256(canonical(files)), files };
}

export function shippingGoBuildPlan() {
  return { directory: 'spikes/anchor/algorand',
    commands: [
      { binary: 'verify', package: './cmd/verify' },
      { binary: 'fast-verify', package: './cmd/fastverify' },
      { binary: 'fast-observe', package: './cmd/fastobserve' },
    ],
    flags: ['-trimpath', '-mod=readonly', '-buildvcs=false'],
    environment: { PATH: '/usr/bin:/bin', GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '',
      GOPROXY: 'off', GOSUMDB: 'off', GOTELEMETRY: 'off', CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: 'arm64', GOARM64: 'v8.0', GOEXPERIMENT: '' },
    moduleIntegrity: 'go mod verify before and after compilation; replacements forbidden',
    caches: 'explicit module cache; fresh build cache and GOPATH per build',
  };
}

export function validateDependencyApproval(approval, inventory, now = Date.now()) {
  if (!inventory.goToolchain || approval?.inventoryDigest !== sha256(canonical(inventory))
      || approval.securityApproved !== true || approval.licensesApproved !== true
      || typeof approval.reviewer !== 'string' || !approval.reviewer.trim()
      || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now) {
    throw Error('Current security and license approval must cover this exact dependency inventory');
  }
}

export async function sourceInventory(root, { command = localCommand } = {}) {
  const paths = localGit(root, ['ls-files', '-co', '--exclude-standard', '-z'], command)
    .split('\0').filter(path => path === 'package.json' || path.startsWith('spikes/') || path.startsWith('test/'));
  const files = [];
  for (const path of [...new Set(paths)].sort()) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Source inventory rejects links');
    files.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  return { sha256: sha256(canonical(files)), files };
}

export async function dependencyInventory(root, { goExecutable = null, command = localCommand } = {}) {
  const packageJSON = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (Object.keys(packageJSON.dependencies ?? {}).length || Object.keys(packageJSON.optionalDependencies ?? {}).length) {
    throw Error('New JavaScript dependencies require distribution inventory support');
  }
  const goMod = await readFile(join(root, 'spikes/anchor/algorand/go.mod'), 'utf8');
  const goSum = await readFile(join(root, 'spikes/anchor/algorand/go.sum'), 'utf8');
  if (/^\s*replace\b/m.test(goMod)) throw Error('Release inventory rejects Go module replacements');
  const modules = [...goMod.matchAll(/^\s+([^\s]+) (v[^\s]+)(?: \/\/ indirect)?$/gm)].map(([, name, version]) => {
    const sum = goSum.split('\n').find(line => line.startsWith(`${name} ${version} `))?.split(' ')[2];
    if (!sum) throw Error('Dependency checksum missing');
    return { name, version, checksum: sum };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const goBuild = shippingGoBuildPlan();
  let goToolchain = null;
  if (goExecutable) {
    const executableInfo = await lstat(goExecutable);
    if (await realpath(goExecutable) !== resolve(goExecutable) || !executableInfo.isFile() || executableInfo.nlink !== 1) {
      throw Error('Go executable must be a regular file without linked paths');
    }
    const go = args => command(goExecutable, args, {
      env: goBuild.environment, cwd: root,
    }).trim();
    const goRoot = go(['env', 'GOROOT']);
    if (resolve(goExecutable) !== join(goRoot, 'bin/go')) throw Error('Select the extracted GOROOT bin/go directly');
    // Bind the complete extracted distribution, including compiler/linker/cgo,
    // standard-library sources, headers, lib inputs and toolchain defaults.
    const inputs = await inputTreeInventory(goRoot);
    for (const path of ['bin/go', 'LICENSE', 'PATENTS', 'go.env', 'VERSION',
      ...['compile', 'link', 'asm', 'cgo'].map(name => `pkg/tool/darwin_arm64/${name}`)]) {
      if (!inputs.files.some(file => file.path === path)) throw Error(`Go toolchain input missing: ${path}`);
    }
    for (const path of ['src', 'pkg/include', 'lib']) {
      if (!inputs.files.some(file => file.path.startsWith(`${path}/`))) throw Error(`Go toolchain input missing: ${path}`);
    }
    goToolchain = { sha256: sha256(await readFile(goExecutable)), version: go(['version']), inputs,
      licenseSha256: sha256(await readFile(join(goRoot, 'LICENSE'))),
      patentsSha256: sha256(await readFile(join(goRoot, 'PATENTS'))) };
  }
  // Git ignores are not a compilation boundary. Even ignored/new files can
  // introduce imports or embedded inputs, so conservatively bind the whole tree.
  goBuild.inputs = await inputTreeInventory(join(root, goBuild.directory));
  return { profile: 'pap-dependency-inventory/2', javascriptPackages: [],
    node: { version: process.version, sha256: sha256(await readFile(process.execPath)), components: { ...process.versions },
      licenseSha256: sha256(await readFile(resolve(process.execPath, '../../LICENSE'))) },
    goToolchain, goBuild,
    noticesDigest: sha256(await readFile(join(root, 'spikes/distribution/THIRD_PARTY_NOTICES.md'))),
    goModDigest: sha256(goMod), goSumDigest: sha256(goSum), modules,
    reviewScope: 'Exact pins, local Go inputs, shipping build plan and extracted Go toolchain; independent security and license approval required before release.' };
}
