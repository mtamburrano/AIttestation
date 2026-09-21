// This contract is loaded from the trusted checkout, never from an inspected
// bundle. Source membership is separately authenticated by the reviewed digest.
export const applicationResourceDirectories = ['diagnostics', 'vault', 'anchor', 'browser', 'recipient', 'distribution'];
export const managedResourceFiles = ['spikes/managed/client.mjs', 'spikes/managed/protocol.mjs'];
export const recipientSourceResources = [
  'spikes/vault/format.mjs', 'spikes/vault/records.mjs', 'spikes/anchor/verifier.mjs', 'spikes/anchor/merkle.mjs', 'spikes/anchor/native-verifier.mjs',
  ...['portable.mjs', 'normal-observation.mjs', 'strict-observation.mjs', 'qualified-observation.mjs', 'dom-observation.mjs', 'legacy-observation.mjs', 'verify.mjs', 'server.mjs', 'main.mjs', 'recipient.html', 'recipient.js', 'recipient.css']
    .map(name => `spikes/recipient/${name}`),
];

export function copyApplicationResource(path) {
  const parts = path.split('/');
  return (applicationResourceDirectories.some(name => path === `spikes/${name}` || path.startsWith(`spikes/${name}/`))
      || managedResourceFiles.includes(path))
    && !parts.some(part => part === 'testdata' || part === '.DS_Store')
    && !/(?:^|\/)bin\/(?:live|sponsor)(?:\/|$)|(?:^|\/)cmd\/sponsor(?:\/|$)/.test(path);
}

export function generatedSourceResources(recipient, channel) {
  return recipient ? ['spikes/anchor/algorand/bin/verify'] : [
    ...['verify', 'fast-verify', 'fast-observe'].map(name => `spikes/anchor/algorand/bin/${name}`),
    'spikes/distribution/installed-release.json',
    ...(channel === 'release-candidate' ? ['spikes/distribution/release-candidate.json'] : []),
  ];
}
