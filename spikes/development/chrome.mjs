import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { codeSignatureCheckArguments } from '../distribution/local.mjs';
import { assertPlatform, testAccount } from './environment.mjs';

const run = (command, args) => execFileSync(command, args, {
  env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: 'pipe', timeout: 15000,
});

export async function chromeApplicationFiles(application, paths = testAccount()) {
  if (typeof application !== 'string' || !isAbsolute(application) || resolve(application) !== application
      || !application.endsWith('.app') || !application.startsWith(`${paths.home}${sep}`)) {
    throw Error('EXPLICIT_TEST_USER_CHROME_COPY_REQUIRED');
  }
  for (const reserved of [paths.control, paths.support, paths.chrome]) {
    if (application === reserved || application.startsWith(`${reserved}${sep}`)) throw Error('CHROME_COPY_MUST_BE_SEPARATE');
  }
  const executable = join(application, 'Contents/MacOS/Google Chrome');
  const infoPlist = join(application, 'Contents/Info.plist');
  for (const [path, directory] of [[application, true], [executable, false], [infoPlist, false]]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || await realpath(path) !== path || info.uid !== process.getuid()
        || (info.mode & 0o022) || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw Error('UNSAFE_PRIVATE_CHROME_COPY');
    }
  }
  return { application, executable, infoPlist };
}

export async function checkPlatform(application, paths = testAccount()) {
  const chrome = await chromeApplicationFiles(application, paths);
  assertPlatform({ platform: process.platform, arch: process.arch,
    osVersion: run('/usr/bin/sw_vers', ['-productVersion']).trim(),
    chromeVersion: run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', chrome.infoPlist]).trim() });
  try {
    run('/usr/bin/codesign', codeSignatureCheckArguments(chrome.executable,
      'anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"'));
  } catch { throw Error('CHROME_SIGNATURE_REJECTED'); }
  return chrome;
}

export function runningChromeProcesses() {
  const output = run('/bin/ps', ['-U', String(process.getuid()), '-o', 'pid=,comm=']);
  return output.split('\n').flatMap(line => {
    const match = /^\s*([1-9][0-9]*)\s+(.+\/Contents\/MacOS\/Google Chrome)$/.exec(line);
    return match ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}

export async function launchDevelopmentChrome(chrome, paths, dashboardURL,
  { spawnProcess = spawn, runningProcesses = runningChromeProcesses, settle = () => delay(250) } = {}) {
  const failure = code => Object.assign(Error(code), { code });
  const expected = join(chrome.application, 'Contents/MacOS/Google Chrome');
  if (chrome.executable !== expected) throw failure('CHROME_LAUNCH_PATH_MISMATCH');
  const inspect = () => {
    let processes;
    try { processes = runningProcesses(); } catch { throw failure('CHROME_LAUNCH_NOT_CONFIRMED'); }
    if (processes.some(entry => entry.executable !== expected)) throw failure('CLOSE_OTHER_CHROME_COPY');
    return processes;
  };
  const previous = inspect();
  // LaunchServices can substitute a registered copy even with `open -a PATH`.
  // Chrome can also forward to a profile's existing process, so verify both
  // the preexisting processes and the effective process after direct launch.
  let child, exited = false, exitCode, spawnError = false;
  try {
    child = spawnProcess(expected, [`--user-data-dir=${paths.chrome}`,
      '--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-updater-scheduler', dashboardURL],
    { env: { HOME: paths.home, PATH: '/usr/bin:/bin' }, detached: true, stdio: 'ignore' });
    child.on('error', () => { spawnError = true; });
    child.once('exit', code => { exited = true; exitCode = code; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure('CHROME_LAUNCH_FAILED')), 15000);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); reject(failure('CHROME_LAUNCH_FAILED')); });
    });
    child.unref();
    await settle();
    if (spawnError || exited && exitCode !== 0) throw failure('CHROME_LAUNCH_FAILED');
    const effective = inspect();
    const selected = effective.find(entry => entry.pid === child.pid || previous.some(old => old.pid === entry.pid));
    if (!selected) throw failure('CHROME_LAUNCH_NOT_CONFIRMED');
    return { application: chrome.application, executable: selected.executable, pid: selected.pid };
  } catch (error) {
    child?.unref();
    if (['CLOSE_OTHER_CHROME_COPY', 'CHROME_LAUNCH_NOT_CONFIRMED'].includes(error.code)) throw error;
    throw failure('CHROME_LAUNCH_FAILED');
  }
}
