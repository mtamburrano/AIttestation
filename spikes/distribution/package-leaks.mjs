import { createPrivateKey } from 'node:crypto';

// Categories and numeric locations are the entire public diagnostic. Even a
// relative filename can contain evidence or credentials supplied by an attacker.
export class PackageLeakError extends Error {
  constructor(category) { super('PACKAGED_CONTENT_REJECTED'); this.category = category; }
}
const reject = category => { throw new PackageLeakError(category); };
export const leakDiagnostic = error => error instanceof PackageLeakError
  ? { category: error.category, entry: error.entry ?? null, archiveEntries: error.archiveEntries ?? [] } : null;

export function rejectSecretName(path) {
  for (const part of path.split('/')) {
    if (/^(?:\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.release-work|\.swift-module-cache|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc)$/i.test(part)
        || /\.(?:key|p8|p12|pfx|seed|mnemonic|keychain(?:-db)?)$/i.test(part)
        || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\..*)?|application_default_credentials\.json)$/i.test(part)) reject('PRIVATE_FILE');
    if (/^(?:.*(?:dependency[-_]approval|release[-_]approval|private[-_]key|notary[-_]credentials).*)$/i.test(part)
        || /^release[-_]config(?:\..*)?\.json$/i.test(part) && part !== 'release-config.example.json') reject('PRIVATE_RELEASE_FILE');
  }
}

const credential = /^(?:private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|mnemonic|seed|aws_secret_access_key|aws_session_token)$/i;
const releaseInput = /^(?:updatePrivateKeyFile|dependencyApprovalFile|signingIdentity|helperProvisioningProfile|goExecutable|goModuleCache)$/i;
const populated = value => value !== null && value !== '';
const kty = '"kty"\\s{0,32}:\\s{0,32}"(?:OKP|EC|RSA|oct)"';
const privateMember = '"(?:d|p|q|k)"\\s{0,32}:\\s{0,32}"[A-Za-z0-9_-]{1,256}';
const privateJWK = new RegExp(`${kty}[^{}]{0,4096}${privateMember}|${privateMember}[^{}]{0,4096}${kty}`);
const literalCredential = /["'](?:private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|mnemonic|seed|aws_secret_access_key|aws_session_token)["'][\t ]{0,32}:[\t ]{0,32}["'][^"'\x00-\x1f\x7f]{1,512}["']/i;
const literalReleaseInput = /["'](?:updatePrivateKeyFile|dependencyApprovalFile|signingIdentity|helperProvisioningProfile|goExecutable|goModuleCache)["'][\t ]{0,32}:[\t ]{0,32}["'][^"'\x00-\x1f\x7f]{1,512}["']/i;

function inspectJSON(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 32 || ++budget.nodes > 1_000_000) reject('CONTENT_LIMIT');
  if (!value || typeof value !== 'object') return;
  if (value.kty && ['d', 'p', 'q', 'k'].some(key => Object.hasOwn(value, key))) reject('PRIVATE_KEY');
  if (Object.hasOwn(value, 'inventoryDigest')
      && ['reviewer', 'securityApproved', 'licensesApproved'].some(key => Object.hasOwn(value, key))) reject('PRIVATE_APPROVAL');
  for (const [key, child] of Object.entries(value)) {
    rejectSecretText(key);
    if (credential.test(key) && populated(child)) reject('CREDENTIAL');
    if (releaseInput.test(key) && populated(child)) reject('PRIVATE_RELEASE_CONFIG');
    if (key === 'notaryProfile' && populated(child) && child !== 'private-provenance-notary') reject('PRIVATE_RELEASE_CONFIG');
    // Decode JSON escapes before looking for paths, PEMs and evidence markers.
    if (typeof child === 'string') rejectSecretText(child);
    inspectJSON(child, depth + 1, budget);
  }
}

function rejectSecretText(text) {
  if (/-----BEGIN (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY-----[\t \r\n]{1,64}[A-Za-z0-9+/=\r\n]{16}/.test(text)
      || /-----BEGIN PGP PRIVATE KEY BLOCK-----[\t \r\n]{1,64}(?:(?:Version|Comment):[^\r\n]{0,128}\r?\n){0,8}[\t \r\n]{0,64}[A-Za-z0-9+/=\r\n]{16}/.test(text)) reject('PRIVATE_KEY');
  // A complete, explicit test marker is required; ordinary receipt fields,
  // hashes, filenames and the words "evidence" or "plaintext" are not secrets.
  if (/ATTESTAMP_SYNTHETIC_EVIDENCE_V1:[A-Za-z0-9_-]{16}/.test(text)) reject('SYNTHETIC_EVIDENCE');
  if (/(?:\/Users\/[^/\s"'<>]{1,128}|\/home\/[^/\s"'<>]{1,128}|\/root|~)\/(?:\.(?:ssh|aws|gnupg|azure|kube)\/[^\s"'<>]{1,256}|\.config\/gcloud\/[^\s"'<>]{1,256}|Library\/Keychains\/[^\s"'<>]{1,256})/i.test(text)
      || /[A-Z]:\\Users\\[^\\\s"'<>]{1,128}\\\.(?:ssh|aws|gnupg|azure|kube)\\[^\s"'<>]{1,256}/i.test(text)) reject('LOCAL_SECRET_PATH');
  if (literalReleaseInput.test(text)) reject('PRIVATE_RELEASE_CONFIG');
  if (/(?:^|[\r\n])[\t ]{0,32}(?:export[\t ]{1,8})?(?:PRIVATE_KEY|CLIENT_SECRET|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|MNEMONIC|SEED|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|NPM_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY)[\t ]{0,8}=[\t ]{0,8}["']?[A-Za-z0-9_./+=:-]{8}/.test(text)
      || /(?:^|[\r\n])[\t ]{0,32}(?:(?:const|let|var)[\t ]{1,8})?(?:private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|mnemonic|seed)[\t ]{0,8}[:=][\t ]{0,8}["'][^"'\x00-\x1f\x7f]{1,512}["']/i.test(text)
      || /["']?(?:authorization)["']?[\t ]{0,8}[:=][\t ]{0,8}["']?(?:Bearer|Basic)[\t ]{1,8}[A-Za-z0-9_./+=~-]{8}/i.test(text)
      || /\b(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s/:@"'<>`$\\]{1,128}:[^\s/@"'<>`$\\]{1,256}@/i.test(text)
      || literalCredential.test(text)) reject('CREDENTIAL');
  // Recognize private JWK literals embedded in source or a large executable,
  // without mistaking a public JWK's kty/crv/x or a Store manifest key for a secret.
  if (privateJWK.test(text)) reject('PRIVATE_KEY');
}

// All textual rules fit inside this overlap. Scan both UTF-16 byte alignments
// as well as ASCII/UTF-8 so binary padding and read boundaries cannot hide them.
export const LEAK_OVERLAP = 16 * 1024;
export function rejectSecretChunk(bytes) {
  rejectSecretText(bytes.toString('latin1'));
  if (!bytes.includes(0)) return;
  for (const offset of [0, 1]) {
    const even = bytes.subarray(offset, offset + Math.floor((bytes.length - offset) / 2) * 2);
    rejectSecretText(even.toString('utf16le'));
    rejectSecretText(Buffer.from(even).swap16().toString('utf16le'));
  }
}

export function rejectSecretBytes(bytes) {
  rejectSecretChunk(bytes);
  // Public certificates, public DER keys and CMS provisioning profiles remain
  // allowed. Parse only bounded standalone DER objects, never execute a tool.
  if (bytes[0] === 0x30 && bytes.length <= 16 * 1024) {
    for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
      let key;
      try { key = createPrivateKey({ key: bytes, format: 'der', type }); } catch {}
      if (key) reject('PRIVATE_KEY');
    }
  }
  let text = bytes.toString('utf8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff && bytes.length % 2 === 0) text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes[1] === 0 && [9, 10, 13, 32, 91, 123].includes(bytes[0])) text = bytes.toString('utf16le');
  if (bytes[0] === 0 && [9, 10, 13, 32, 91, 123].includes(bytes[1]) && bytes.length % 2 === 0) text = Buffer.from(bytes).swap16().toString('utf16le');
  if (!/^\s*[\[{]/.test(text)) return;
  let value;
  try { value = JSON.parse(text); } catch { return; }
  inspectJSON(value);
}
