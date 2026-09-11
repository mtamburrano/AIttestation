import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonical, keys, parseCanonical } from '../vault/format.mjs';

export const RELEASE_PROFILE = 'pap-desktop-release/1';
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function distributionError(code) {
  const error = Error(code); error.code = code; return error;
}

export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw distributionError('INVALID_RELEASE_ORIGIN');
  }
  return url.origin;
}

export function releasePublicKey(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw distributionError('INVALID_RELEASE_KEY');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: encoded }, format: 'jwk' });
}

export function validateRelease(release) {
  keys(release, ['profile', 'sequence', 'version', 'platform', 'publishedAt', 'expiresAt',
    'readerVersion', 'maximumSchema', 'artifact', 'provenanceDigest', 'dependencyDigest']);
  keys(release.artifact, ['name', 'bytes', 'sha256']);
  if (release.profile !== RELEASE_PROFILE || !positive(release.sequence)
      || typeof release.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(release.version)
      || release.platform !== 'darwin-arm64' || !positive(release.readerVersion)
      || !positive(release.maximumSchema) || release.readerVersion > release.maximumSchema
      || release.artifact.name !== `Private-Provenance-${release.version}-${release.sequence}.dmg`
      || !positive(release.artifact.bytes) || release.artifact.bytes > MAX_INSTALLER_BYTES
      || !digest(release.artifact.sha256) || !digest(release.provenanceDigest) || !digest(release.dependencyDigest)) {
    throw distributionError('INVALID_RELEASE');
  }
  for (const value of [release.publishedAt, release.expiresAt]) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      throw distributionError('INVALID_RELEASE_TIME');
    }
  }
  if (Date.parse(release.expiresAt) <= Date.parse(release.publishedAt)
      || Date.parse(release.expiresAt) - Date.parse(release.publishedAt) > 31 * 86400_000) {
    throw distributionError('INVALID_RELEASE_TIME');
  }
  return release;
}

export function verifyRelease(bytes, { publicKey, installedSequence, highestSeen = installedSequence,
  schema, now = Date.now(), allowCurrent = false }) {
  try {
    if (!positive(installedSequence) || !positive(highestSeen) || !Number.isFinite(now)
        || !positive(schema?.writerVersion) || !positive(schema?.minimumReader)) throw Error();
    const envelope = parseCanonical(bytes, 16 * 1024);
    keys(envelope, ['release', 'signature']);
    const release = validateRelease(envelope.release);
    if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw Error();
    const signature = Buffer.from(envelope.signature, 'base64url');
    if (signature.toString('base64url') !== envelope.signature
        || !verify(null, Buffer.from(canonical(release)), releasePublicKey(publicKey), signature)) throw Error();
    if (release.sequence < installedSequence || (!allowCurrent && release.sequence === installedSequence)
        || release.sequence < highestSeen) throw distributionError('UPDATE_ROLLBACK_REJECTED');
    if (Date.parse(release.publishedAt) > now + 300_000 || Date.parse(release.expiresAt) <= now) {
      throw distributionError('UPDATE_EXPIRED');
    }
    if (release.readerVersion < schema.minimumReader || release.maximumSchema < schema.writerVersion) {
      throw distributionError('UPDATE_SCHEMA_INCOMPATIBLE');
    }
    return structuredClone(release);
  } catch (error) {
    if (['UPDATE_ROLLBACK_REJECTED', 'UPDATE_EXPIRED', 'UPDATE_SCHEMA_INCOMPATIBLE'].includes(error.code)) throw error;
    throw distributionError('UPDATE_SIGNATURE_REJECTED');
  }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
