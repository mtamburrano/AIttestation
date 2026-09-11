import { spawn } from 'node:child_process';
import { startRecipient } from './server.mjs';

const app = await startRecipient();
if (process.argv.includes('--open')) {
  const browser = spawn('/usr/bin/open', [app.url], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  browser.on('error', () => {});
} else console.log(app.url);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
