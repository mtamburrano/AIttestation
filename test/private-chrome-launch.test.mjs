import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, realpath, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDevelopmentChrome, runningChromeProcesses } from '../spikes/development/chrome.mjs';
import { startupFailure } from '../spikes/development/startup.mjs';

const application = '/private/synthetic test/Google Chrome.app';
const chrome = { application, executable: join(application, 'Contents/MacOS/Google Chrome') };
const paths = { home: '/private/synthetic test', chrome: '/private/synthetic test/browser data' };
const dashboardURL = 'http://127.0.0.1:12345/#synthetic-token';
function child() { const c = new EventEmitter(); c.pid = 42; c.unref = () => {}; return c; }

test('private launch uses the validated executable and confirms its effective process', async () => {
  let snapshots = 0;
  const result = await launchDevelopmentChrome(chrome, paths, dashboardURL, {
    spawnProcess(executable, args, options) {
      assert.equal(executable, chrome.executable);
      assert.equal(args.at(-1), dashboardURL);
      assert.ok(args.includes(`--user-data-dir=${paths.chrome}`));
      assert.ok(args.includes('--disable-updater-scheduler'));
      assert.ok(args.includes('--disable-component-update'));
      assert.ok(!args.includes('--args'));
      assert.deepEqual(options, { env: { HOME: paths.home, PATH: '/usr/bin:/bin' }, detached: true, stdio: 'ignore' });
      const c = child(); queueMicrotask(() => c.emit('spawn')); return c;
    },
    runningProcesses: () => snapshots++ ? [{ pid: 42, executable: chrome.executable }] : [],
    settle: async () => {},
  });
  assert.deepEqual(result, { ...chrome, pid: 42 });
});

test('another installed copy cannot receive launch or profile-singleton forwarding', async () => {
  const other = { pid: 7, executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
  let launches = 0;
  await assert.rejects(launchDevelopmentChrome(chrome, paths, dashboardURL, {
    runningProcesses: () => [other], spawnProcess: () => { launches++; },
  }), /CLOSE_OTHER_CHROME_COPY/);
  assert.equal(launches, 0);
  let snapshots = 0;
  await assert.rejects(launchDevelopmentChrome(chrome, paths, dashboardURL, {
    runningProcesses: () => snapshots++ ? [other] : [],
    spawnProcess: () => { const c = child(); queueMicrotask(() => c.emit('spawn')); return c; }, settle: async () => {},
  }), /CLOSE_OTHER_CHROME_COPY/);
});

test('selected existing Chrome may receive a dashboard request without a second profile', async () => {
  const prior = { pid: 17, executable: chrome.executable };
  let c;
  const result = await launchDevelopmentChrome(chrome, paths, dashboardURL, {
    runningProcesses: () => [prior],
    spawnProcess: () => { c = child(); queueMicrotask(() => c.emit('spawn')); return c; },
    settle: async () => { c.emit('exit', 0); },
  });
  assert.equal(result.pid, 17);
});

test('wrong paths, failed spawns and unconfirmed or failed launches have bounded errors', async () => {
  await assert.rejects(launchDevelopmentChrome({ ...chrome, executable: '/unvalidated' }, paths, dashboardURL),
    /CHROME_LAUNCH_PATH_MISMATCH/);
  for (const mode of ['spawn-error', 'thrown', 'exit-error', 'forwarded-elsewhere', 'inspection-error']) {
    let c;
    await assert.rejects(launchDevelopmentChrome(chrome, paths, dashboardURL, {
      runningProcesses: () => { if (mode === 'inspection-error') throw Error('PRIVATE_PROCESS_LIST'); return []; },
      spawnProcess: () => {
        if (mode === 'thrown') throw Error('PRIVATE_PATH');
        c = child(); queueMicrotask(() => c.emit(mode === 'spawn-error' ? 'error' : 'spawn', Error('PRIVATE_TOKEN'))); return c;
      },
      settle: async () => { if (mode === 'exit-error') c.emit('exit', 1); },
    }), error => {
      assert.match(error.message, /^CHROME_LAUNCH_(FAILED|NOT_CONFIRMED)$/);
      assert.equal(startupFailure(error), `PRIVATE_DEVELOPMENT_START_FAILED:${error.code}`);
      return true;
    });
  }
});

test('real direct launch runs the selected bundle executable when duplicate bundle names exist', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = await realpath(await mkdtemp('/private/tmp/attestamp-chrome-launch-test-'));
  let launched;
  t.after(async () => {
    if (launched && launched.exitCode === null && launched.signalCode === null) {
      launched.kill(); await once(launched, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  });
  const selected = join(root, 'selected/Google Chrome.app'), duplicate = join(root, 'other/Google Chrome.app');
  const executable = join(selected, 'Contents/MacOS/Google Chrome');
  await mkdir(join(selected, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(duplicate, 'Contents/MacOS'), { recursive: true });
  execFileSync('/usr/bin/xcrun', ['clang', 'test/fixtures/chrome-launch.c', '-o', executable], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: root }, encoding: 'utf8', timeout: 60000,
  });
  await copyFile(executable, join(duplicate, 'Contents/MacOS/Google Chrome'));
  const output = join(root, 'observed.txt'), fixturePaths = { home: root, chrome: join(root, 'browser-data') };
  const result = await launchDevelopmentChrome({ application: selected, executable }, fixturePaths, output, {
    spawnProcess: (...args) => { launched = spawn(...args); return launched; },
    runningProcesses: () => runningChromeProcesses().filter(entry => entry.executable.startsWith(`${root}/`)),
  });
  let lines;
  for (let i = 0; i < 100; i++) {
    try { lines = (await readFile(output, 'utf8')).trim().split('\n'); break; } catch { await delay(10); }
  }
  assert.equal(result.pid, launched.pid);
  assert.equal(result.executable, executable);
  assert.equal(lines[0], executable);
  assert.equal(lines[1], root);
  assert.ok(lines.includes(`--user-data-dir=${fixturePaths.chrome}`));
  assert.ok(!lines.some(line => line.includes(duplicate)));
});
