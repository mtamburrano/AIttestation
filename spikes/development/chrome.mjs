import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
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

export function launchDevelopmentChrome(chrome, paths, dashboardURL, execute = execFile) {
  // Use LaunchServices so Chrome can receive its own permission attribution. Directly
  // spawning its executable attributes Chrome's app-clone maintenance to Attestamp.
  // Keep the already-validated app path explicit; a bundle-ID lookup is ambiguous.
  return new Promise((resolve, reject) => {
    execute('/usr/bin/open', ['-n', '-a', chrome.application, '--args', `--user-data-dir=${paths.chrome}`,
      '--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-updater-scheduler', dashboardURL],
    { env: { HOME: paths.home, PATH: '/usr/bin:/bin' }, timeout: 15000, maxBuffer: 4096 }, error => {
      if (error) reject(Object.assign(Error('CHROME_LAUNCH_FAILED'), { code: 'CHROME_LAUNCH_FAILED' }));
      else resolve();
    });
  });
}
