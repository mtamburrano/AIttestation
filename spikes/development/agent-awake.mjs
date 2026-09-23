import { spawn } from 'node:child_process';
import { closeAgentBrowser } from './agent-process.mjs';

export async function withAgentAwake(seconds, action, { spawnProcess = spawn } = {}) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw Error('AGENT_COMMAND_INVALID');
  const child = spawnProcess('/usr/bin/caffeinate', ['-i', '-t', String(seconds), '-w', String(process.pid)],
    { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  let rejectExit;
  const abort = new AbortController();
  const interruption = new Promise((_, reject) => { rejectExit = reject; });
  // Register immediately, including for asynchronous spawn failure.
  const fail = reason => { const error = Error(reason); abort.abort(error); rejectExit(error); };
  const interrupted = () => fail('AGENT_RUN_INTERRUPTED');
  const exited = () => fail('AGENT_SLEEP_HOLD_UNAVAILABLE');
  child.once('error', exited); child.once('exit', exited);
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  let timer;
  try {
    timer = setTimeout(() => fail('AGENT_RUN_TIMED_OUT'), seconds * 1000);
    await Promise.race([new Promise(resolve => child.once('spawn', resolve)), interruption]);
    return await Promise.race([Promise.resolve().then(() => action(abort.signal)), interruption]);
  } finally {
    abort.abort(Error('AGENT_RUN_INTERRUPTED'));
    clearTimeout(timer); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
    child.off('exit', exited); child.off('error', exited);
    await closeAgentBrowser(child, 1000);
  }
}
