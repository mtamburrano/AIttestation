import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const filename = name => {
  if (!['engine-pointer', 'engine-recording-off'].includes(name)) throw Error('INVALID_RECORDING_STATE_FILE');
  return name;
};

export class RecordingFiles {
  constructor(directory) { this.directory = directory; }
  read(name) { return readFile(join(this.directory, filename(name)), 'utf8'); }
  async remove(name) {
    await unlink(join(this.directory, filename(name))).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await this.#syncDirectory();
  }
  async #syncDirectory() {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async write(name, content) {
    filename(name);
    const temporary = join(this.directory, `${name}-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, name));
      await this.#syncDirectory();
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
