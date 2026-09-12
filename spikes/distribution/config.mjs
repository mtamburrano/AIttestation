import { keys } from '../vault/format.mjs';
import { distributionError, httpsOrigin, releasePublicKey } from './release.mjs';

export const RELEASE_CHANNELS = Object.freeze({ PRODUCTION: 'production', CANDIDATE: 'release-candidate' });
export const RELEASE_CANDIDATE_PROFILE = 'pap-release-candidate/1';

export function validateInstalledRelease(config) {
  keys(config, ['profile', 'sequence', 'version', 'teamId', 'updateOrigin', 'updatePublicKey', 'storeListingVerified']);
  if (config.profile !== 'pap-installed-release/1' || !Number.isSafeInteger(config.sequence) || config.sequence < 1
      || typeof config.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(config.version)
      || typeof config.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(config.teamId)
      || config.storeListingVerified !== true) throw distributionError('RELEASE_PROVISIONING_REQUIRED');
  httpsOrigin(config.updateOrigin); releasePublicKey(config.updatePublicKey); return config;
}

export function validateReleaseCandidate(config) {
  keys(config, ['profile', 'releaseChannel', 'sequence', 'version', 'teamId', 'updateOrigin', 'updatePublicKey', 'storeListingVerified']);
  if (config.profile !== RELEASE_CANDIDATE_PROFILE || config.releaseChannel !== RELEASE_CHANNELS.CANDIDATE
      || !Number.isSafeInteger(config.sequence) || config.sequence < 1
      || typeof config.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(config.version)
      || typeof config.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(config.teamId)
      || config.storeListingVerified !== false) throw distributionError('INVALID_RELEASE_CANDIDATE');
  httpsOrigin(config.updateOrigin); releasePublicKey(config.updatePublicKey); return config;
}
