import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { distributionError } from './release.mjs';

export async function ownedDirectory(path, { create = true } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path) throw distributionError('UNSAFE_INSTALL_PATH');
  // Check each existing ancestor before creating descendants; never follow a
  // redirected Chrome/support directory into another store.
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let info;
    try { info = await lstat(current); } catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw distributionError('UNSAFE_INSTALL_PATH');
  }
  const info = await lstat(path);
  if (info.uid !== process.getuid() || (info.mode & 0o022) || await realpath(path) !== path) {
    throw distributionError('UNSAFE_INSTALL_PATH');
  }
  return true;
}

export async function readOwned(path, limit = 16 * 1024) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw distributionError('UNSAFE_INSTALL_FILE'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1
        || (info.mode & 0o022) || info.size > limit) throw distributionError('UNSAFE_INSTALL_FILE');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw distributionError('UNSAFE_INSTALL_FILE');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export async function atomicWrite(path, bytes) {
  await ownedDirectory(dirname(path)); await readOwned(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
