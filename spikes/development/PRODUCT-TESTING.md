# Local product testing and diagnostics

Use Node 22.13+ and local `/usr/bin/openssl`:

```sh
npm run test:product
npm run test:product -- --scenario recording-storage-gap
npm run test:product -- --list
npm run test:chatgpt
```

The runner creates fresh owner-only temporary resources and prints a
`reportDirectory` containing `report.html`, `result.json` and the exact
`diagnostics.json` preview. A sandbox must allow this run's Unix socket and
loopback HTTP; denial reports LOCAL_IPC_PERMISSION_DENIED.

The worker has an empty environment except fixed system PATH. It uses memory-only
test keys, a fresh encrypted durable vault and fresh sponsorship fixtures/ledger.
The network guard allows only the active fixture's registered local API/socket.
Unknown ports, external destinations and redirects reject. Existing app config,
HOME, proxies, credentials, Keychain, profiles and accounts are never defaults.
There is no live mode or fallback.

## Actual and synthetic boundaries

The fixtures use `startPackagedChatGPT`, `ChatGPTRecordingSession`, resident
engine, durable vault, actual page/worker/sidebar model, native framing and local
API. Browser DOM/API/platform identity and anchor verdicts are explicitly
synthetic. The runner separately checks real managed accounting with local
fixtures. No provider action is performed by Attestamp.

| Scenario | Expected invariant |
| --- | --- |
| recording-normal-send | Genuine intent, exact bytes, retry dedup, equal-text separate events, independent tabs, appearance assertion and retrospective export |
| recording-storage-gap | No save acknowledgement or provider replay on unavailable storage |
| recording-key-gap | No save acknowledgement or provider replay on unavailable keys |
| recording-connection-gap | Unavailable feedback without collecting disconnected input |
| panel-recording | Shared global toggle/status and Dashboard opening, no prompt-writing authority |
| dashboard-recording | Shared settings, history, export/recovery and integration controls |

PASS means the expected invariant held, including expected failure behavior.
Reports always identify SYNTHETIC_FIXTURE and liveEvidence: NOT_TESTED.
They establish no installed native ancestry/Keychain/sidebar, actual provider
markup or live Algorand acceptance.

## Focused and broader regression commands

| Command | Boundary |
| --- | --- |
| npm test | All Node tests, including crypto, old evidence readers, package policy, recovery, diagnostics and native compile guards |
| npm run test:chatgpt | ON/OFF engine, automatic sources, page extraction, removed API rejection, sidebar roles, native reconnect and fast collector |
| npm run test:product | Six isolated end-to-end product scenarios above |
| npm run test:dashboard-browser | Actual dashboard in fresh headless Chrome; selection/preview/export response races, hostile content, free verifier and narrow layout |
| npm run test:recipient-browser | Actual standalone recipient UI with legacy/local evidence and hostile inputs |
| npm run test:algorand | Go verifier/observer tests and fixed archived public proof; no transaction submission |
| npm run test:legacy-archive | Read-only fixed historical demonstrator export under independently selected trust |

Native/browser commands need their explicit local toolchain or Chrome binary.
The Go archive commands require the locally available pinned tools and fixed
archive. Missing dependencies or excluded platform checks must be reported;
synthetic assurance does not substitute for them. See the
[rework matrix](../browser/chatgpt/MIGRATION.md) for executed results.

All tests must use fresh paths, memory/generated fixture keys and scrubbed
environments. Ordinary regression work does not change a retained private kit,
Keychain, sponsor ledger, app registration or user browser profile. A separately
authorized installed checkpoint is described in [README.md](README.md).

## Report lifecycle

The worker has a 60-second deadline. Success exits 0, unexpected failures 1,
invalid options/refused output 2. Failures retain bounded fixed-code diagnostics.
A forcibly terminated run may leave its newly created fixture directory.

`--output /absolute/new/report-directory` requires a new canonical directory
outside a checkout. Existing data is never adopted, replaced or cleaned up.
Normal cleanup removes only that run's fixture keys/vaults/ledgers. The three
0600 report files remain until explicitly deleted. No report uploads automatically.

## Diagnostic privacy

Shared `spikes/diagnostics/local.mjs` accepts fixed allowlisted codes and six
opaque reference fields. HMAC pseudonyms use a fresh memory key; original IDs,
raw digests, transaction IDs, prompt bytes, URLs, DOM, paths, credentials, arbitrary
errors and keys never enter reports. Legacy dispatch codes/field names remain
only so saved diagnostic reports can be read; current recording creates no
dispatch operation.

The live buffer is bounded to 512 events, 256 KiB and 30 minutes. Timings are
relative rounded milliseconds, capped at 24 hours. Detailed BRIDGE_STATE events
require synthetic mode plus `--trace-synthetic`; no live environment or wire
flag enables injected authorities. Diagnostic failure cannot grant control.

Local diagnostics offers selection, exact preview and Save. A preview is immutable,
expires within two minutes, and is consumed once; at most four exist. New activity
cannot widen the reviewed export. Fixture results are capped at 320 KiB. Reports
remain separate from evidence exports and never contain vaults or recovery keys.

The private owner debug session remains opt-in and persists content-free events
across restart: 2,048 events, 512 KiB, 24 hours, at most 16 segments. SQLite/WAL
storage has separate strict size/ownership gates. Its explicit export/clear
controls do not change evidence, keys, recording or sponsor accounting.

Add only fixed scenarios using the existing runtime with explicitly injected
external dependencies and fresh resources. Development fixtures are excluded
from packaged products. Privacy and resource tests live in
`test/product-diagnostics.test.mjs` and `test/debug-session.test.mjs`.
