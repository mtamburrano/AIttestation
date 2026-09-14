# Local product testing and diagnostics

From the checkout, using Node 22.13+ and the local `/usr/bin/openssl` executable:

```sh
npm run test:product
```

This is the routine development command. It works in the current user, creates
fresh owner-only temporary resources and prints a machine-readable summary with
`reportDirectory`. Open `report.html` in that directory to inspect the report;
`result.json` contains scenario results and `diagnostics.json` contains the exact
diagnostic preview. No process/socket orchestration or existing private test kit
is needed. A sandbox must permit this process's temporary Unix socket and loopback
HTTP server; a denied local socket produces `LOCAL_IPC_PERMISSION_DENIED`.

The worker starts with an empty environment except for a fixed system PATH. It
uses memory-only test keys, a fresh encrypted durable vault and a fresh sponsorship
ledger. Its network guard admits only the registered product API origin and native
Unix socket for the active fixture. Unknown local ports, external destinations
and redirects fail closed. Existing app configuration, HOME, proxies, credentials,
Keychain, browser profiles and sponsor accounts are never selected as defaults.
There is no live mode or live fallback.

## Components and evidence labels

The command uses `startPackagedChatGPT`, the authenticated product HTTP API,
`runNativeHost`, `ChromeBridgeController`, `ChatGPTChromeAdapter`,
`ChatGPTProtectionSession`, `ReleaseRuntime`, `DurableVault`,
`ManagedAnchoringClient` and `ManagedSponsorship`. It checks the durable one-use
attempt before the synthetic provider responds, and reads the exact evidence back
through the vault while checking that its on-disk files contain no prompt plaintext.

Only the provider reply, platform identity, sponsor signing/broadcast and
confirmation observations/verdict are injected. The collector itself is the real
two-source collector with an explicit observer fixture. The sponsor client uses
an in-process transport to the real ledger. The provider uses real native frames
through the real local relay. These fixtures establish no installed browser/DOM,
macOS peer identity, native Keychain, live provider or Algorand assurance.
Reports always say `SYNTHETIC_FIXTURE` and `liveEvidence: NOT_TESTED`.

The scenarios use the existing trusted-composer product API. They do not establish
normal ChatGPT Send, a side-panel journey or multi-tab acceptance. Those behaviors
need scenarios alongside their implementations.

## Target a failure

```sh
npm run test:product -- --scenario bridge-timeout
npm run test:product -- --scenario confirmation-unavailable
npm run test:product -- --list
```

| Scenario | Expected observed behavior |
| --- | --- |
| `sealed-success` | One synthetic submission, after confirmation and durable authorization consumption |
| `confirmation-unavailable` | Confirmation remains pending; no dispatch or authorization |
| `confirmation-rejected` | Invalid confirmation rejected; no dispatch or authorization |
| `bridge-timeout` | One attempt, unknown outcome, no automatic resend |
| `bridge-response-mismatch` | Mismatched reply rejected; unknown outcome, no automatic resend |
| `account-disconnected` | Account required; no sponsor broadcast or dispatch |

`PASS` means the expected scenario invariant held, including expected failures.
Unexpected failures use fixed reason codes, preserve the bounded diagnostic report
and exit nonzero. Success exits 0; failed scenarios exit 1; invalid options or a
refused output directory exit 2. Each command has a 60-second worker deadline;
an abrupt worker failure emits a fixed summary on stdout. A forcibly terminated
process may leave its fresh temporary fixture directory for manual inspection.

Use `--output /absolute/new/report-directory` to choose the report location.
The directory must be new, canonical and outside a checkout; existing data is never
adopted, replaced or cleaned up. Fixture keys, vaults and ledgers are removed on
normal completion. Only the three report files remain, with mode 0600. Saved
reports have no automatic expiry; delete the selected report directory when it is
no longer needed. No report is uploaded or shared automatically.

## Diagnostic contract and preview

`LocalDiagnostics` accepts an allowlist of lifecycle codes and six reference
fields: operation, runtime epoch, bridge connection, capture, confirmation and
dispatch. References are HMAC pseudonyms under a fresh in-memory key per collector;
the key and original identifiers are never exported. No raw content digest is
used as a correlation identifier. Components pass only known identifiers and
relative durations; they never pass a request, payload, URL, error object or DOM.
Collection is observational and cannot grant authority or change a release result.

An operation reference joins engine, vault and anchoring events. A dispatch
reference joins the durable attempt to adapter/bridge activity. The bridge
connection and shared runtime epoch tie those events to admission and reconnect
events. A capture reference joins the saved text to its operation without disclosing
the vault's original record identifier. Each confirmation attempt gets a new
reference; sponsor transaction IDs are omitted.

The in-memory event buffer is limited to 512 events, 256 KiB and 30 minutes.
Writes, selections and previews prune expired events and report how many were
dropped. Relative timings are rounded to milliseconds and saturated at 24 hours.
The collector keeps no persistent log files. Detailed `BRIDGE_STATE` events are
disabled by default; opting in requires both synthetic mode and
`--trace-synthetic`. There is no product setting, environment switch or wire
command to enable synthetic authorities or deeper traces in a live build.

In the real local product page, **Local diagnostics** is available even without
distribution setup. Refresh the selection, choose an operation/component and
preview before saving. Empty selections include all retained events. Operation
selections include only events associated with that operation; choose all
operations to include startup and connection events. The paired local API offers
the same selection/preview/export flow and retains its bearer/origin checks.

A preview stores an immutable snapshot for at most two minutes; at most four
snapshots are retained. Export consumes the chosen preview once. New events or
selection changes cannot silently widen an already previewed export. Exported
events contain no prompt text, keys, credentials, full URLs, raw hashes, filenames
or arbitrary exception/DOM strings. The fixture result is capped at 320 KiB and
the HTML preview is bounded by that fixed-size result. Reports remain separate
from evidence exports and never include the encrypted vault or its keys.

## Add a scenario

Add a fixed scenario name and expectations in `product-fixtures.mjs`. Reuse the
existing product entrypoint/API, explicitly inject each external dependency and
keep all resources under the supplied fresh fixture directory. New observations
should use a fixed event code, duration and opaque reference, with leakage tests
for any new boundary. The development fixture modules are excluded from packaged
product resources. Validate the collector, network guard, privacy and permissions
with `node --test test/product-diagnostics.test.mjs`.
