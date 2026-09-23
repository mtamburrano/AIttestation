import { mkdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical } from '../vault/format.mjs';
import { fileInventory } from '../distribution/inventory.mjs';
import { exists, ownerDirectory } from './environment.mjs';
import { stageAgentExtension } from './prepare.mjs';
import { runningChromeProcesses } from './chrome.mjs';

export const agentStagePath = paths => join(paths.extension, 'current');

// Only a stopped browser can consume a new stage. Retain old staged bytes for
// inspection; never rewrite a signed build, browser profile, or evidence store.
export async function updateAgentStage(paths, source, expectedInventory, { processes = runningChromeProcesses } = {}) {
  await ownerDirectory(paths.extension); await ownerDirectory(paths.control);
  const lock = join(paths.control, 'stage.lock');
  await mkdir(lock, { mode: 0o700 });
  const stage = agentStagePath(paths), incoming = join(paths.extension, `incoming-${randomUUID()}`);
  let previous;
  try {
    if (processes().length || await exists(join(paths.control, 'runtime.json'))
        || await exists(join(paths.control, 'launch.json'))) throw Error('STOP_PREVIOUS_AGENT_SESSION');
    if (canonical(await fileInventory(source)) !== canonical(expectedInventory)) throw Error('AGENT_BUILD_INVALID');
    if (await exists(stage)) {
      await ownerDirectory(stage);
      if (canonical(await fileInventory(stage)) === canonical(expectedInventory)) return { staged: true, changed: false };
    }
    await stageAgentExtension(source, incoming);
    if (canonical(await fileInventory(incoming)) !== canonical(expectedInventory)) throw Error('AGENT_BUILD_INVALID');
    if (processes().length || await exists(join(paths.control, 'runtime.json'))
        || await exists(join(paths.control, 'launch.json'))) throw Error('STOP_PREVIOUS_AGENT_SESSION');
    if (await exists(stage)) {
      previous = join(paths.extension, `previous-${randomUUID()}`);
      await rename(stage, previous);
    }
    try { await rename(incoming, stage); }
    catch (error) { if (previous) await rename(previous, stage); throw error; }
    return { staged: true, changed: true };
  } finally { await rmdir(lock); }
}
