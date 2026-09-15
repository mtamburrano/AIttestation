import { join } from 'node:path';
import { atomicWrite } from '../distribution/files.mjs';
import { DEVELOPMENT_PROFILE, exists, ownerDirectory, privateJSON } from './environment.mjs';

function validate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'composerURL,profile'
      || value.profile !== DEVELOPMENT_PROFILE || typeof value.composerURL !== 'string'
      || value.composerURL.length > 256) throw Error('INVALID_PRIVATE_RUNTIME_STATE');
  const url = new URL(value.composerURL);
  if (url.href !== value.composerURL || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !url.port || url.pathname !== '/' || url.search || url.username || url.password
      || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)) throw Error('INVALID_PRIVATE_RUNTIME_STATE');
  return value;
}

// Call only after startPackagedChatGPT has acquired the resident engine lock.
// A recognized stale locator can then be replaced without trusting its endpoint
// or signalling any old process. It contains no restorable send authority.
export async function publishRuntimeState(controlDirectory, runtime) {
  const state = runtime.engine.state();
  if (!state.available || state.runtimeEpoch !== runtime.runtimeEpoch) throw Error('PRIVATE_RUNTIME_NOT_STARTED');
  const value = validate({ profile: DEVELOPMENT_PROFILE, composerURL: runtime.composerURL });
  await ownerDirectory(controlDirectory);
  const path = join(controlDirectory, 'runtime.json');
  if (await exists(path)) validate(await privateJSON(path));
  await atomicWrite(path, `${JSON.stringify(value)}\n`);
  return path;
}
