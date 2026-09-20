# Attestamp for ChatGPT

The supported integration is Apple-silicon macOS 15.7+, Chrome Stable major 153
and `https://chatgpt.com`. Turn recording ON in the existing sidebar or resident
Mac menu. All supported existing and new tabs/windows are followed automatically.
Use ChatGPT's normal composer and Send. Turn OFF to stop new capture; saved
evidence and bounded pending anchoring remain available.

ON is a preference, separate from connection, supported input, successful local
save and anchor assurance. Capture is retrospective, prospective-only and best
effort. A gap does not establish how many unobserved prompts were lost. No
component injects prompt text, clicks Send, blocks the user's event or backfills
history.

## Components

`runtime-main.mjs` is the fixed packaged entrypoint. It starts the app-bound
Keychain vault, authenticated native bridge, resident engine and optional
bearer-paired dashboard. `ChatGPTRecordingSession` in `session.mjs` stores exact
text and signed observations, groups receipts and manages bounded asynchronous
anchoring. The engine orders capture against the global recording preference.
Views have no arbitrary prompt-writing command.

See [ENGINE.md](ENGINE.md) for control, migration and OFF ordering,
[RECORDING.md](RECORDING.md) for extraction and delivery bounds,
[DASHBOARD.md](DASHBOARD.md) for the retained sidebar/menu/dashboard, and
[MIGRATION.md](MIGRATION.md) for removal and legacy compatibility inventories.

## Authenticated Chrome transport

Extension 2.1.0 negotiates adapter `pap-chatgpt-chrome/7`, page contract
`chatgpt-web-text/2026-09-20`, capture `pap-chatgpt-capture/3` and sidebar
`pap-chatgpt-panel/2`. Old active contracts reject. Native bridge profile 3,
bundle identities and cryptographic domains are unchanged.

The extension has only `nativeMessaging`, `sidePanel` and
`https://chatgpt.com/*` host permission. Its manifest key pins Store item
`medilhopfckldjgdnchfkpmfmfnkadca`; the upload omits the key. Incognito is disabled.
The sidebar uses a document-owned request channel and a fresh confirmation after
browser checks. It rejects one-shot controls and ambiguous non-tab contexts,
including popups that copy a sidebar URL and then depart or change their URL.
Origin, permissions, incognito exclusion and native
authentication remain required. Rejection diagnostics separately negotiate
`pap-chatgpt-panel-diagnostic/1`. See [sidebar trust and evidence](SIDEBAR.md).

Browser JavaScript reports identity as UNVERIFIED. The fixed native host verifies
its live Google-signed Chrome Stable parent. The app's peer validator independently
checks the exact signed Node relay, signed browser host and Chrome ancestry using
the paused socket's peer PID. Only that chain supplies browser/platform identity.

Each runtime creates an owner-only Unix socket, 256-bit token, epoch and
atomically published short-lived rendezvous. Peer authentication precedes exact,
constant-time token validation. The framing relay exposes no filesystem,
clipboard, signer or general command API. Authentication has an eight-second
deadline; pairing is explicitly acknowledged. EOF, malformed frames and failed
handshakes close transport. Worker reconnect delay is 1, 2, 4, 8, 16 then at most
30 seconds, reset only after pairing. Late callbacks retain their original port
and epoch. Reconnection never replays provider actions.

Up to 32 tabs have independent window/document/source identities, including
duplicate conversation tabs. URL/document changes, removal, permission or
transport loss revoke affected capture policies. Temporary unsupported markup
retains source identity but provides no capture eligibility. Restored capability
only allows future genuine Sends. Provider content cannot choose selectors,
control recording or supply signed extension updates.

## Anchoring, packaging and validation

After a durable local save, the engine attempts blinded managed anchoring.
Two independent configured operators must agree on the exact transaction, note,
round and header, with locally verified inclusion. Fast assurance is
SOURCE_CORROBORATED with SOURCE_REPORTED time; a later valid State-Proof archive
can add CONSENSUS_VERIFIED / BLOCK_HASH_BOUND assurance without rewriting history.
Timeout, disagreement and account/quota failure leave explicit pending status.
Neither an account nor a transaction ID alone supplies proof.

The collector's hard 20-second budget contains bounded concurrent GET-only
observers, no proxies or redirects. Observation retry reuses a transaction;
it never invokes sponsorship or broadcast. See the
[managed contract](../../managed/README.md) and
[Algorand verifier](../../anchor/algorand/README.md).

The fixed Mac launcher validates the complete signed bundle and runs only the
bundled Node and entrypoint with a sanitized environment. The
[distribution runbook](../../distribution/README.md) preserves signing,
Keychain entitlements, owned registration, package inventories and update trust.
Building does not install a native manifest into a user's profile.

`npm run test:chatgpt` and `npm run test:product` exercise actual page/worker
scripts, native framing, engine and encrypted temporary vault with explicitly
synthetic browser/platform/provider/anchor dependencies. They establish no live
provider, installed native ancestry or sidebar interaction acceptance.
The [testing guide](../../development/PRODUCT-TESTING.md) records those limits.
`npm run test:sidepanel-browser -- --manual-toolbar` additionally exercises real
Chrome 153 sidebar contexts in a disposable app/profile with a synthetic native
peer and memory keys. Its report distinguishes actual browser evidence from
fixture behavior; it does not establish signed macOS or live-provider acceptance.
