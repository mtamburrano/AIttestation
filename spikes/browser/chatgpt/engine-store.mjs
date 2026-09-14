import { open, readFile, rename, unlink } from 'node:fs/promises';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, parseCanonical } from '../../vault/format.mjs';

// An OS-released SQLite lock precedes all engine state loading. A second process
// cannot clear grants or create a second dispatcher; a crash needs no PID reaping.
export function lockResidentEngine(directory) {
  const path = join(directory, 'resident-lock.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid()) {
    throw Error('UNSAFE_ENGINE_LOCK');
  }
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS resident (id INTEGER)'); }
  catch { db.close(); throw Error('RESIDENT_ENGINE_ALREADY_RUNNING'); }
  return () => db.close();
}

export class EngineStateStore {
  constructor(directory, vault) { this.directory = directory; this.vault = vault; }
  async load() {
    let id;
    try { id = await readFile(join(this.directory, 'engine-pointer'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('INVALID_ENGINE_POINTER');
    const record = this.vault.inspect().records.find(value => value.manifest.eventId === id);
    if (!record) throw Error('ENGINE_HISTORY_MISSING');
    const decoded = parseCanonical(this.vault.read(record.manifest.evidence[0].objectDigest), 16 * 1024 * 1024);
    if (decoded.profile !== 'pap-resident-state/1') throw Error('UNSUPPORTED_ENGINE_HISTORY');
    return decoded.state;
  }
  async save(state) {
    const record = this.vault.capture(Buffer.from(canonical({ profile: 'pap-resident-state/1', state })));
    const temporary = join(this.directory, `engine-pointer-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(record.manifest.eventId); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, 'engine-pointer'));
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
