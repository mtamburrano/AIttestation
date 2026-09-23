import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { readReleaseFile } from '../distribution/release-inputs.mjs';
import { ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';
import { AGENT_OPT_IN, AGENT_PROFILE, agentAccount, initializeAgent, validateAgent } from './agent-environment.mjs';
import { validateDevelopmentConfig } from './prepare.mjs';

function configurationPaths(namespace, optIn, info = userInfo()) {
  // This template locates the namespace only. Automation authority comes from
  // the persisted config and its matching namespace marker below.
  const paths = agentAccount({ profile: AGENT_PROFILE, namespace, automation: 'local-api',
    account: { username: info.username, uid: info.uid, home: info.homedir } }, optIn, info);
  const bootstrap = join(paths.root, 'bootstrap');
  return { ...paths, bootstrap, configPath: join(bootstrap, 'agent-config.json'),
    helperProfilePath: join(bootstrap, 'helper.provisionprofile') };
}

export async function initializeAgentConfig(sourcePath, optIn, info) {
  if (optIn !== AGENT_OPT_IN) throw Error('AGENT_OPT_IN_REQUIRED');
  const config = validateDevelopmentConfig(await privateJSON(sourcePath));
  if (!config.agent) throw Error('AGENT_CONFIG_REQUIRED');
  agentAccount(config.agent, optIn, info);
  const paths = configurationPaths(config.agent.namespace, optIn, info);
  const profile = await readReleaseFile(config.helperProvisioningProfile, { limit: 1024 * 1024 });
  await initializeAgent(config.agent, optIn, info);
  await mkdir(paths.bootstrap, { mode: 0o700 });
  await writeFile(paths.helperProfilePath, profile, { flag: 'wx', mode: 0o600 });
  // Publish the config last. An interrupted initialization cannot fall back to
  // the source file or make a partially copied profile available to a session.
  await writeNewJSON(paths.configPath, { ...config, helperProvisioningProfile: paths.helperProfilePath });
  return { profile: AGENT_PROFILE, initialized: true, namespace: config.agent.namespace };
}

export async function resolveAgentConfig(namespace, optIn, info) {
  const paths = configurationPaths(namespace, optIn, info);
  let config;
  try {
    await ownerDirectory(paths.root);
    await ownerDirectory(paths.bootstrap);
    config = validateDevelopmentConfig(await privateJSON(paths.configPath));
  } catch (error) {
    throw Error(error.code === 'ENOENT' ? 'AGENT_CONFIG_NOT_PREPARED' : 'AGENT_CONFIG_INVALID');
  }
  if (!config.agent) throw Error('AGENT_CONFIG_REQUIRED');
  if (config.agent.namespace !== namespace) throw Error('AGENT_NAMESPACE_MISMATCH');
  if (config.helperProvisioningProfile !== paths.helperProfilePath) throw Error('AGENT_CONFIG_INVALID');
  await validateAgent(config.agent, optIn, info);
  return { config, paths, configPath: paths.configPath };
}
