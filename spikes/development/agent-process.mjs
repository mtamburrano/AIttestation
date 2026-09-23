export async function closeAgentBrowser(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return;
  await new Promise((resolve, reject) => {
    let timer;
    const exited = () => { clearTimeout(timer); resolve(); };
    child.once('exit', exited);
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      timer = setTimeout(() => { child.off('exit', exited); reject(Error('AGENT_BROWSER_CLOSE_TIMED_OUT')); }, 2000);
    }, timeoutMs);
    child.kill('SIGTERM');
  });
}
