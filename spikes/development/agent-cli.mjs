import { fileURLToPath } from 'node:url';
import { agentCommand, agentOwnerAction } from './agent.mjs';

export async function main(args) {
  let result;
  try { result = await agentCommand(args); }
  catch { result = agentOwnerAction('AGENT_COMMAND_INVALID'); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'OWNER_ACTION_REQUIRED') process.exitCode = 2;
  else if (result.status === 'FAILED') process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
