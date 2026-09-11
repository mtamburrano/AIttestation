import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { distributionError, httpsOrigin, verifyRelease } from './release.mjs';
import { ownedDirectory, syncDirectory } from './files.mjs';

const execute = promisify(execFile);

export function getReleaseBytes(url, maximum, consume) {
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw distributionError('UNSAFE_UPDATE_URL');
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { outgoing.destroy(); reject(distributionError('UPDATE_UNAVAILABLE')); } else resolve();
    };
    const outgoing = request(url, { method: 'GET', agent: false, headers: {
      Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'PrivateProvenance-Updater/1',
    } }, async response => {
      if (response.statusCode !== 200 || response.headers['content-encoding']
          || Number(response.headers['content-length'] ?? 0) > maximum) {
        response.destroy(); finish(true); return;
      }
      let size = 0;
      try {
        for await (const chunk of response) {
          size += chunk.length;
          if (size > maximum) throw Error();
          await consume(chunk);
        }
        finish();
      } catch { finish(true); }
    });
    const timer = setTimeout(() => finish(true), 120_000);
    outgoing.setTimeout(10_000, () => finish(true)); outgoing.once('error', () => finish(true)); outgoing.end();
  });
}

export async function verifyAppleInstaller(path, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw distributionError('INVALID_SIGNING_TEAM');
  const options = { env: { PATH: '/usr/bin:/bin' }, timeout: 30_000, maxBuffer: 64 * 1024 };
  try {
    await execute('/usr/bin/codesign', ['--verify', '--strict', '-R',
      `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`, path], options);
    await execute('/usr/bin/xcrun', ['stapler', 'validate', path], options);
    await execute('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path], options);
  } catch { throw distributionError('UPDATE_APPLE_SIGNATURE_REJECTED'); }
}

export class DesktopUpdater {
  #config; #lifecycle; #schema; #get; #apple; #directory; #release = null; #busy = false;
  state = 'NOT_CHECKED';
  constructor({ config, lifecycle, schema, directory, get = getReleaseBytes, apple = verifyAppleInstaller }) {
    httpsOrigin(config.updateOrigin);
    this.#config = config; this.#lifecycle = lifecycle; this.#schema = schema;
    this.#get = get; this.#apple = apple; this.#directory = directory;
  }
  async #exclusive(operation) {
    if (this.#busy) throw distributionError('UPDATE_BUSY');
    this.#busy = true;
    try { return await operation(); }
    catch (error) {
      this.state = error.code === 'UPDATE_UNAVAILABLE' ? 'UNAVAILABLE' : 'REJECTED';
      this.#release = null; throw distributionError(this.state === 'UNAVAILABLE' ? 'UPDATE_UNAVAILABLE' : 'UPDATE_REJECTED');
    } finally { this.#busy = false; }
  }
  check() {
    return this.#exclusive(async () => {
      this.#release = null;
      const chunks = []; let size = 0;
      await this.#get(new URL('/desktop/stable.json', this.#config.updateOrigin), 16 * 1024, chunk => {
        size += chunk.length; if (size > 16 * 1024) throw distributionError('UPDATE_REJECTED'); chunks.push(Buffer.from(chunk));
      });
      const release = verifyRelease(Buffer.concat(chunks), { publicKey: this.#config.updatePublicKey,
        installedSequence: this.#config.sequence, highestSeen: this.#lifecycle.highestSeen, schema: this.#schema(), allowCurrent: true });
      await this.#lifecycle.rememberRelease(release.sequence); await this.#lifecycle.record('updateChecked');
      this.#release = release.sequence > this.#config.sequence ? release : null;
      this.state = this.#release ? 'AVAILABLE' : 'CURRENT';
      return { state: this.state, version: release.version, bytes: release.artifact.bytes };
    });
  }
  download() {
    return this.#exclusive(async () => {
      const release = this.#release;
      if (!release || Date.parse(release.expiresAt) <= Date.now()
          || release.sequence < this.#lifecycle.highestSeen) throw distributionError('UPDATE_REJECTED');
      await ownedDirectory(this.#directory);
      const path = join(this.#directory, `${randomUUID()}-${release.artifact.name}`);
      const temporary = `${path}.partial`, file = await open(temporary, 'wx', 0o600);
      let size = 0, committed = false; const hash = createHash('sha256');
      try {
        await this.#get(new URL(`/desktop/${release.artifact.name}`, this.#config.updateOrigin), release.artifact.bytes, async chunk => {
          size += chunk.length;
          if (size > release.artifact.bytes) throw distributionError('UPDATE_REJECTED');
          hash.update(chunk); await file.writeFile(chunk);
        });
        if (size !== release.artifact.bytes || hash.digest('hex') !== release.artifact.sha256) throw distributionError('UPDATE_REJECTED');
        await file.sync(); await file.close();
        // No downloaded executable or installer is opened until both independent
        // release signatures and Apple's distribution assessment have passed.
        await rename(temporary, path);
        await this.#apple(path, this.#config.teamId);
        await syncDirectory(this.#directory); await this.#lifecycle.record('updateDownloaded');
        committed = true; this.state = 'DOWNLOADED';
        return { state: this.state, path };
      } finally {
        await file.close().catch(() => {});
        if (!committed) for (const name of [temporary, path]) {
          try { await unlink(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    });
  }
}
