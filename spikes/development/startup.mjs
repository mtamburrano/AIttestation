const prefix = 'PRIVATE_DEVELOPMENT_START_FAILED:';
const keychainReasons = new Map([
  ['Native Keychain broker closed', 'KEYCHAIN_BROKER_CLOSED'],
  ['Invalid Keychain broker response', 'KEYCHAIN_BROKER_RESPONSE_INVALID'],
  ['Native Keychain broker unavailable', 'KEYCHAIN_BROKER_UNAVAILABLE'],
  ['App-bound Keychain helper failed', 'KEYCHAIN_HELPER_FAILED'],
  ['Invalid Keychain helper response', 'KEYCHAIN_RESPONSE_INVALID'],
  ['macOS Keychain is locked', 'KEYCHAIN_LOCKED'],
  ['App-bound Keychain operation failed', 'KEYCHAIN_OPERATION_FAILED'],
]);
const codes = new Set(['UNKNOWN', 'LOCKED', 'UNRECOVERABLE', 'INVALID', 'UNSUPPORTED_PATH',
  'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'CHROME_LAUNCH_FAILED', ...keychainReasons.values()]);

// Startup errors can carry private paths or broker data. Only fixed diagnostic
// labels cross the signed runtime's stderr boundary into the development CLI.
export function startupFailure(error) {
  const reason = keychainReasons.get(error?.message) ?? (codes.has(error?.code) ? error.code : 'UNKNOWN');
  return `${prefix}${reason}`;
}

export function readStartupFailure(output) {
  for (const line of output.slice(0, 4096).split('\n')) {
    if (line.startsWith(prefix) && codes.has(line.slice(prefix.length))) return line;
  }
  return 'PRIVATE_APP_START_NOT_CONFIRMED';
}

export function developmentCommandFailure(error) {
  const message = error?.message;
  if (typeof message === 'string' && (/^[A-Z_0-9]+$/.test(message)
      || readStartupFailure(message) === message)) return message;
  return 'PRIVATE_DEVELOPMENT_COMMAND_FAILED';
}
