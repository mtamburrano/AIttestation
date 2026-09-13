import { execFileSync } from 'node:child_process';

export const LOCAL_ENVIRONMENT = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', OPENSSL_CONF: '/dev/null' });
// Block service-mediated network/browser access as well as direct sockets.
export const READ_ONLY_SANDBOX = '(version 1) (allow default) (deny network*) (deny mach-lookup) (deny appleevent-send) '
  + '(deny file-write*) (allow file-write-data (literal "/dev/null"))';

export function localCommand(command, args, options = {}) {
  return execFileSync(command, args, { ...options, env: { ...LOCAL_ENVIRONMENT, ...options.env },
    encoding: 'utf8', stdio: 'pipe', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
}

export function codeSignatureCheckArguments(path, requirement, { deep = false } = {}) {
  // Without the leading '=', codesign treats the requirement as a filename.
  return ['--verify', ...(deep ? ['--deep'] : []), '--strict', '-R', `=${requirement}`, path];
}

export function readOnlyCommand(command, args, options = {}) {
  // Denial applies to descendants too; an unavailable sandbox is a hard failure.
  return localCommand('/usr/bin/sandbox-exec', ['-p', READ_ONLY_SANDBOX, command, ...args], options);
}

export function localGit(root, args, command = localCommand) {
  return command('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
}
