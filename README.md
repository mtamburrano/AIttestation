# Attestamp

Attestamp records supported outgoing prompt requests in ChatGPT Web on Apple-silicon
macOS with Chrome. One resident app owns the encrypted evidence vault, app-bound
keys, recording preference and asynchronous anchoring.

- **ON** automatically follows supported existing and new ChatGPT tabs/windows.
  It extracts exact new user text from validated provider requests, saves signed
  encrypted evidence, then attempts blinded anchoring. DOM interaction and provider
  acknowledgement are not prerequisites for local saving.
- **OFF** stops new capture. Saved history and bounded pending anchor work remain.
- Use ChatGPT's own composer and Send. Capture and anchor failures never control,
  inject, block or replay that Send.

New and recovered installations start OFF. Recording is prospective and best
effort: it does not establish complete history, authorship, ownership, event truth,
human interaction, provider receipt, non-retention or pre-egress protection. Unsupported input and
connection/storage failures can leave gaps.

## Product and trust boundaries

The existing Chrome sidebar offers global ON/OFF, effective status and
Dashboard/History. The optional local dashboard adds account connection,
integration management, selective export, recovery and private diagnostics.
Closing a view leaves the resident engine running.

The first supported contract is macOS 15.7+ arm64, Chrome Stable major 153 and
`https://chatgpt.com` text up to 256 KiB. Attachments, responses, voice, edits,
regeneration and unrelated/background requests are outside capture. Native peer
authentication, exact source/document checks and versioned contracts fail closed.
Synthetic tests do not establish installed sidebar trust or live provider behavior.

Read the [browser contract](spikes/browser/chatgpt/README.md),
[recording and extraction rules](spikes/browser/chatgpt/RECORDING.md),
[engine and migration contract](spikes/browser/chatgpt/ENGINE.md), and
[rework inventory](spikes/browser/chatgpt/MIGRATION.md).

## Evidence and free verification

The [vault](spikes/vault/README.md) retains exact bytes, signatures, blinded
commitments and encrypted recovery. [Managed anchoring](spikes/managed/README.md)
receives blinded commitments and operational metadata; it receives no evidence
plaintext, raw digests, openings or vault keys. Local save and anchor assurance
are separate states. Two-source corroboration and later State-Proof verification
have different assurance limits.

[Attestamp Verifier](spikes/recipient/README.md) independently reads portable
exports without an account or company service. Select and preview the exact
disclosure before saving it. Historical signed evidence keeps its original bytes
and meaning through isolated readers; historical Send workflows are removed.

## Development and validation

Use Node 22.13+ and fresh temporary resources:

```sh
npm test
npm run test:chatgpt
npm run test:product
npm run test:dashboard-browser
npm run test:recipient-browser
npm run test:algorand
```

See [local product testing](spikes/development/PRODUCT-TESTING.md) for fixture
isolation, privacy, prerequisites and evidence limits. Ordinary tests use no
retained installation, native Keychain data, provider Sends or new transactions.
The [private setup guide](spikes/development/README.md) describes separately
authorized installed checks.

The [distribution guide](spikes/distribution/README.md) retains signing,
notarization, dependency inventories, package leak checks, Store identity,
consented installation, update signatures and rollback/schema safeguards.
An ad-hoc build or release candidate is not a published production installation.
No public deployment or funded service is supplied by this checkout.
