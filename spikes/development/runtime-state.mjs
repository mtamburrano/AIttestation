import { join } from 'node:path';
import { atomicWrite } from '../distribution/files.mjs';
import { DEVELOPMENT_PROFILE, exists, ownerDirectory, privateJSON } from './environment.mjs';

export const RUNTIME_STATE_PROFILE = 'pap-private-runtime/2';

function validate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'dashboardURL,profile'
      || value.profile !== RUNTIME_STATE_PROFILE || typeof value.dashboardURL !== 'string'
      || value.dashboardURL.length > 256) throw Error('INVALID_PRIVATE_RUNTIME_STATE');
  const url = new URL(value.dashboardURL);
  if (url.href !== value.dashboardURL || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !url.port || url.pathname !== '/dashboard' || url.search || url.username || url.password
      || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)) throw Error('INVALID_PRIVATE_RUNTIME_STATE');
  return value;
}

// Call only after startPackagedChatGPT has acquired the resident engine lock.
// A recognized stale locator can then be replaced without trusting its endpoint
// or signalling any old process. It contains no restorable send authority.
export async function publishRuntimeState(controlDirectory, runtime) {
  const state = runtime.engine.state();
  if (!state.available || state.runtimeEpoch !== runtime.runtimeEpoch) throw Error('PRIVATE_RUNTIME_NOT_STARTED');
  const value = validate({ profile: RUNTIME_STATE_PROFILE, dashboardURL: runtime.dashboardURL });
  await ownerDirectory(controlDirectory);
  const path = join(controlDirectory, 'runtime.json');
  if (await exists(path)) {
    const prior = await privateJSON(path);
    // Read an old locator only to replace it after taking the resident lock.
    if (prior.profile === DEVELOPMENT_PROFILE && Object.keys(prior).sort().join(',') === 'composerURL,profile') {
      const url = new URL(prior.composerURL);
      if (url.pathname !== '/') throw Error('INVALID_PRIVATE_RUNTIME_STATE');
      url.pathname = '/dashboard'; validate({ profile: RUNTIME_STATE_PROFILE, dashboardURL: url.href });
    } else validate(prior);
  }
  await atomicWrite(path, `${JSON.stringify(value)}\n`);
  return path;
}
