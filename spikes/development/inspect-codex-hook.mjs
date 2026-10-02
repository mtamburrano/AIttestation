import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ownedDirectory, readOwned } from '../distribution/files.mjs';
import { ownedHook, parseSettings } from '../coding/settings.mjs';
import { parseUniqueJSON } from '../distribution/unique-json.mjs';

// A name/comment is not ownership evidence. Compare the entire generated hook
// with the explicitly selected installation journal, without running its command.
export async function inspectCodexHookOwnership({ configRoot, journalPath, receiver }) {
  if (![configRoot, journalPath, receiver].every(path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path)) {
    throw Error('EXPLICIT_CODEX_OWNERSHIP_PATHS_REQUIRED');
  }
  const rootExists = await ownedDirectory(configRoot, { create: false });
  const journalBytes = await ownedDirectory(dirname(journalPath), { create: false }) ? await readOwned(journalPath, 64 * 1024) : null;
  const journal = journalBytes ? parseUniqueJSON(new TextDecoder('utf8', { fatal: true }).decode(journalBytes)) : null;
  const entry = journal?.entries?.codex;
  const known = ['pap-coding-integrations/1', 'pap-coding-integrations/2'].includes(journal?.profile)
    && entry?.client === 'codex' && entry.state === 'configured' && !entry.previousEntry && entry.configRoot === configRoot
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.installationId ?? '')
    && isDeepStrictEqual(entry.hook, ownedHook('codex', receiver, entry.installationId));
  const files = [];
  let inline = false;
  for (const [name, format] of [['config.toml', 'toml'], ['hooks.json', 'json']]) {
    const path = join(configRoot, name), bytes = rootExists ? await readOwned(path, 1024 * 1024) : null;
    const settings = bytes ? parseSettings(new TextDecoder('utf8', { fatal: true }).decode(bytes), format) : {};
    if (format === 'toml') inline = Object.hasOwn(settings, 'hooks');
    const groups = settings.hooks?.UserPromptSubmit ?? [];
    const matches = known && entry.configPath === path && entry.format === format
      ? groups.filter(group => isDeepStrictEqual(group, entry.hook)).length : 0;
    files.push({ file: name, exists: bytes !== null, hooks: groups.map((group, index) => ({ index,
      ownership: matches === 1 && isDeepStrictEqual(group, entry.hook) ? 'MATCHED_ATTESTAMP_JOURNAL' : 'UNPROVEN' })) });
  }
  return { readOnly: true, dualConfiguration: inline && files[1].exists, files, removalAuthorized: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [configRoot, journalPath, receiver, ...extra] = process.argv.slice(2);
  if (extra.length) throw Error('EXPLICIT_CODEX_OWNERSHIP_PATHS_REQUIRED');
  inspectCodexHookOwnership({ configRoot, journalPath, receiver }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(() => { console.error('CODEX_OWNERSHIP_CHECK_FAILED'); process.exitCode = 1; });
}
