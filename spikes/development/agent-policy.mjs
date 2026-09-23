import { privateInstallation } from './integration.mjs';

export async function agentInstallation(paths, browserHost, live) {
  const installation = privateInstallation(paths, browserHost);
  const record = installation.record;
  installation.record = async event => {
    if (event === 'storeOpened') throw Error('AGENT_PUBLICATION_DISABLED');
    return record(event);
  };
  if (!live) {
    if ((await installation.status()).integration !== 'DISABLED') throw Error('AGENT_LIVE_OPT_IN_REQUIRED');
    installation.enable = async () => { throw Error('AGENT_LIVE_OPT_IN_REQUIRED'); };
  }
  return installation;
}
