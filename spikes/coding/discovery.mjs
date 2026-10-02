import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// Discovery reads bounded metadata only. It neither runs clients nor grants trust.
async function metadata(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 512 * 1024) return '';
    const bytes = Buffer.alloc(512 * 1024 + 1), { bytesRead } = await file.read(bytes);
    return bytesRead <= 512 * 1024 ? bytes.subarray(0, bytesRead).toString('utf8') : '';
  } catch { return ''; } finally { await file?.close(); }
}
const versionLabel = value => typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : 'version unavailable';

export async function discoverClients({ client, home = homedir(), applications = '/Applications',
  globalBins = ['/opt/homebrew/bin', '/usr/local/bin'], arch = process.arch } = {}) {
  if (!['codex', 'claude-code'].includes(client)) throw Error('UNKNOWN_INTEGRATION');
  const candidates = [], seen = new Set();
  async function add(path, name, version, surface) {
    let file;
    try {
      const resolved = await realpath(path);
      if (seen.has(resolved)) return;
      file = await open(resolved, 'r'); const info = await file.stat();
      if (!info.isFile() || !(info.mode & 0o111) || (info.mode & 0o022) || info.size > 256 * 1024 * 1024) return;
      const head = Buffer.alloc(2); await file.read(head, 0, 2, 0);
      seen.add(resolved);
      candidates.push({ path: resolved, name, version: versionLabel(version), surface,
        interpreterRequired: head.toString() === '#!', state: 'DETECTED' });
    } catch {} finally { await file?.close(); }
  }
  if (client === 'codex') for (const name of ['ChatGPT', 'Codex']) {
    const app = join(applications, `${name}.app`);
    const plist = await metadata(join(app, 'Contents/Info.plist'));
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    await add(join(app, 'Contents/Resources/codex'), `${name} desktop · Codex runtime`, version, 'DESKTOP');
  }
  // VS Code's registration list is authoritative for installed extensions. Never
  // enroll a version merely because an abandoned directory remains on disk.
  const extensions = join(home, '.vscode/extensions');
  let registered = [];
  try { registered = JSON.parse(await metadata(join(extensions, 'extensions.json'))); } catch {}
  if (Array.isArray(registered) && registered.length <= 512) {
    const id = client === 'codex' ? 'openai.chatgpt' : 'anthropic.claude-code';
    const selected = registered.filter(entry => entry?.identifier?.id === id);
    if (selected.length === 1) {
      const entry = selected[0], location = entry.relativeLocation;
      if (typeof location === 'string' && location.length < 180 && basename(location) === location
          && location.startsWith(`${id}-`) && /^[a-zA-Z0-9._+-]+$/.test(location)) {
        const binary = client === 'codex' ? `bin/macos-${arch === 'arm64' ? 'aarch64' : 'x86_64'}/codex` : 'resources/native-binary/claude';
        await add(join(extensions, location, binary), `VS Code · ${client === 'codex' ? 'Codex' : 'Claude Code'}`, entry.version, 'IDE');
      }
    }
  }
  const command = client === 'codex' ? 'codex' : 'claude';
  const bins = client === 'claude-code' ? [join(home, '.local/bin'), ...globalBins] : globalBins;
  for (const bin of bins.slice(0, 4)) await add(join(bin, command), `${client === 'codex' ? 'Codex' : 'Claude Code'} · local CLI`, null, 'CLI');
  return { client, state: candidates.length ? 'DETECTED' : 'UNAVAILABLE', candidates,
    limit: client === 'codex' ? 4 : 1, authority: 'NONE' };
}
