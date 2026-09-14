import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ManagedSponsorship } from '../managed/service.mjs';
import { algorandSponsor } from '../managed/algorand.mjs';
import { startManagedServer } from '../managed/http.mjs';
import { readReleaseFile } from '../distribution/release-inputs.mjs';
import { DEVELOPMENT_PROFILE, newDirectory, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';

const limits = { accounts: 1, ledger: 10, accountMonth: 10, accountDay: 10,
  globalDay: 10, accountMinute: 20, globalMinute: 30 };

export function algorandAddress(publicKey) {
  const key = Buffer.from(publicKey);
  if (key.length !== 32) throw Error('ED25519_PUBLIC_KEY_REQUIRED');
  const bytes = Buffer.concat([key, createHash('sha512-256').update(key).digest().subarray(-4)]);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export async function initializeSponsor(directory, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('EXPLICIT_LOCAL_PORT_REQUIRED');
  await newDirectory(directory);
  const pair = generateKeyPairSync('ed25519'), jwk = pair.privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  try { await writeFile(join(directory, 'account.seed'), seed, { flag: 'wx', mode: 0o600 }); }
  finally { seed.fill(0); }
  const address = algorandAddress(Buffer.from(jwk.x, 'base64url'));
  // This CA is scoped to the private transport; it is never installed in macOS.
  const opensslConfig = join(directory, 'tls.cnf');
  await writeFile(opensslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Attestamp private TestNet sponsor\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n', { flag: 'wx', mode: 0o600 });
  // Create the key ourselves with exclusive owner-only permissions. OpenSSL's
  // -newkey/-keyout path can create a 0644 key under a permissive umask.
  const tlsKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  try { await writeFile(join(directory, 'tls-key.pem'), tlsKey, { flag: 'wx', mode: 0o600 }); }
  finally { tlsKey.fill(0); }
  await writeFile(join(directory, 'tls-cert.pem'), '', { flag: 'wx', mode: 0o600 });
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-new', '-days', '30',
    '-config', opensslConfig, '-key', join(directory, 'tls-key.pem'), '-out', join(directory, 'tls-cert.pem')],
  { env: { PATH: '/usr/bin:/bin', OPENSSL_CONF: opensslConfig }, stdio: 'pipe', timeout: 15000 });
  const config = { profile: DEVELOPMENT_PROFILE, network: 'testnet-v1.0', address, port };
  await writeNewJSON(join(directory, 'sponsor.json'), config);
  const service = new ManagedSponsorship(join(directory, 'ledger'), {
    sponsor: algorandSponsor({ seedPath: join(directory, 'account.seed'), expectedAddress: address }), limits,
  });
  try {
    await writeNewJSON(join(directory, 'access.json'), service.provision({ paidThrough: Date.now() + 7 * 86400000 }));
  } finally { service.close(); }
  await checkSponsor(directory);
  return { profile: DEVELOPMENT_PROFILE, network: 'testnet-v1.0', address, origin: `https://127.0.0.1:${port}`,
    maxTransactions: 10, externalCalls: 0, next: 'FUND_NEW_ADDRESS_WITH_FREE_TESTNET_FAUCET_ONLY' };
}

export async function checkSponsor(directory) {
  await ownerDirectory(directory);
  const config = await privateJSON(join(directory, 'sponsor.json'));
  if (Object.keys(config).sort().join(',') !== 'address,network,port,profile'
      || config.profile !== DEVELOPMENT_PROFILE || config.network !== 'testnet-v1.0'
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('INVALID_TESTNET_SPONSOR');
  await ownerDirectory(join(directory, 'ledger'));
  let key, seed;
  try {
    key = await readReleaseFile(join(directory, 'tls-key.pem'), { privateFile: true, limit: 8192 });
    seed = await readReleaseFile(join(directory, 'account.seed'), { privateFile: true, limit: 32 });
    if (seed.length !== 32) throw Error('INVALID_TESTNET_SPONSOR_SEED');
    const certificate = new X509Certificate(await readReleaseFile(join(directory, 'tls-cert.pem'), { limit: 8192 }));
    if (!certificate.checkPrivateKey(createPrivateKey(key))) throw Error('PRIVATE_SPONSOR_TLS_MISMATCH');
    const encoded = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    let publicKey;
    try { publicKey = createPublicKey(createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }); }
    finally { encoded.fill(0); }
    if (algorandAddress(Buffer.from(publicKey.x, 'base64url')) !== config.address) throw Error('PRIVATE_SPONSOR_ACCOUNT_MISMATCH');
    await privateJSON(join(directory, 'access.json'));
    return { profile: DEVELOPMENT_PROFILE, checks: ['SPONSOR_DIRECTORY_PRIVATE', 'TLS_KEY_PRIVATE',
      'ACCOUNT_SEED_PRIVATE', 'TLS_CERTIFICATE_MATCH', 'ACCOUNT_ADDRESS_MATCH', 'ACCESS_FILE_PRIVATE'], externalCalls: 0 };
  } finally { key?.fill(0); seed?.fill(0); }
}

export async function serveSponsor(directory, optIn) {
  if (optIn !== '--live-testnet') throw Error('EXPLICIT_LIVE_TESTNET_OPT_IN_REQUIRED');
  await ownerDirectory(directory);
  const config = await privateJSON(join(directory, 'sponsor.json'));
  if (Object.keys(config).sort().join(',') !== 'address,network,port,profile'
      || config.profile !== DEVELOPMENT_PROFILE || config.network !== 'testnet-v1.0'
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('INVALID_TESTNET_SPONSOR');
  await ownerDirectory(join(directory, 'ledger'));
  const key = await readReleaseFile(join(directory, 'tls-key.pem'), { privateFile: true, limit: 8192 });
  const cert = await readReleaseFile(join(directory, 'tls-cert.pem'), { limit: 8192 });
  const seed = await readReleaseFile(join(directory, 'account.seed'), { privateFile: true, limit: 32 });
  seed.fill(0);
  const service = new ManagedSponsorship(join(directory, 'ledger'), {
    sponsor: algorandSponsor({ seedPath: join(directory, 'account.seed'), expectedAddress: config.address }), limits,
  });
  try {
    const server = await startManagedServer(service, { port: config.port, tls: { key, cert } });
    return { origin: server.origin, async close() { await server.close(); service.close(); key.fill(0); } };
  } catch (error) { service.close(); key.fill(0); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, directory, option] = process.argv.slice(2);
  try {
    if (action === 'doctor' && process.argv.length === 4) console.log(JSON.stringify(await checkSponsor(directory)));
    else if (process.argv.length !== 5) throw Error('USAGE');
    else if (action === 'init') console.log(JSON.stringify(await initializeSponsor(directory, Number(option))));
    else if (action === 'serve') {
      const server = await serveSponsor(directory, option);
      console.log(JSON.stringify({ origin: server.origin, network: 'testnet-v1.0', maxTransactions: 10 }));
      const stop = () => server.close().then(() => process.exit(0));
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } else throw Error('USAGE');
  } catch { console.error('PRIVATE_TESTNET_SPONSOR_FAILED'); process.exitCode = 1; }
}
