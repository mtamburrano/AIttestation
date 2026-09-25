import { closeSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// An OS-released SQLite lock precedes all engine state loading. A second process
// cannot create a second recorder; a crash needs no PID reaping.
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

