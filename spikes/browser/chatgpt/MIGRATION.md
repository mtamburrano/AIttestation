# ON/OFF migration and compatibility inventory

Baseline inspected before editing: `mvp` at
`0ca707e7f7aedb311d8f278c09c49ed39eb6eee8`.
The contracts below supersede executable controlled-Send behavior. Historical
signed evidence keeps its bytes and meaning.

## Remove / refactor / retain

| Boundary | Disposition | Result |
| --- | --- | --- |
| `spikes/release/` | Remove executor; relocate shared helpers | Runtime, grants, one-use dispatch, composer and demo removed. Diagnostics moved to `spikes/diagnostics/local.mjs`; exact text validation to `spikes/vault/text.mjs` |
| `spikes/demonstrator/` | Remove executable application | Server, session, store, UI, builder, live validation and CLI removed. Fixed testdata/results stay read-only; helper moved to `recipient/legacy-demo.mjs` |
| `browser/chatgpt/session.mjs` | Refactor | Only durable normal observations, history, free export/recovery and bounded async anchoring; no freeze/cancel/release methods or journal execution |
| `engine.mjs`, `engine-store.mjs` | Refactor/version | SET_RECORDING only; conservative state/2 migration, serial OFF cutoff, new policy tokens, bounded anchor workers/retries |
| Adapter, bridge and page/worker scripts | Refactor | Automatic sources across tabs/windows; validated normal prompt-request observation. No page insertion, click executor, release message handler or manual enrollment |
| Existing Chrome sidebar | Retain/refactor | Same sidePanel UI/permission and trusted-context checks; ON/OFF, effective status and Dashboard/History only |
| Product server/dashboard, Mac menu/host | Refactor | Remove technical composer and old endpoints/modes; retain authenticated controls, integration lifecycle, history/export/recovery/account/diagnostics and fixed launchers |
| Private CLI/runtime locator/preparation | Refactor/version | Dashboard URL and runtime locator/2; obsolete locator can be validated/replaced under lock without contacting old endpoint |
| Vault/crypto/key/recovery | Retain with record versioning | New local-record/2 labels; previous records remain authenticatable without mutation. Keys, hash domains, vault format and public proof identities unchanged |
| Recipient | Retain/refactor | New request-authoritative observation/6 plus historical strict transport/5, qualified transport/4 and DOM observation/3, observation/2 and historical observation/1 interpretation; no legacy Send; existing ON/OFF pending anchors retained |
| Managed account/ledger, Algorand proof | Retain | Durable reservations, same transaction retry, blinded payload, exact proof checks and free independent verification; asynchronous client attempts bounded across restart |
| Distribution/install/update trust | Retain/refactor resource selection | Remove release/demonstrator resource roots; include relocated diagnostics and legacy reader dependency. Preserve identities, signatures, dependency review, leak gates, release channels, update/rollback/schema policy and notices |
| Test/example/package entrypoints | Replace retired workflows | Recording/removal fixtures replace Sealed execution; actual dashboard/recipient UI and immutable legacy archive checks remain. No demo or consumer-composer build script |
| Active guides and historical reports | Rewrite/isolate | Root/browser/development/distribution/managed/vault/recipient guides describe ON/OFF. Historical readiness is explicitly separated from current installed acceptance |

Current wire versions: adapter/9, page `2026-09-21.1`, capture/5, sidebar/2,
resident command/event/state/2, desktop command/event/2, dashboard/2,
private runtime/2, local-record/2, normal observation/6. Extension version 2.3.2.
Native bridge/3, portable export formats, signing domains and frozen platform IDs
are unchanged. Earlier active extension/control contracts reject.

## Behavior and test matrix

| Requirement | Evidence |
| --- | --- |
| Existing/new/multiple-window and duplicate-conversation tabs follow automatically | `chatgpt-recording` actual page/worker/relay fixture; `chatgpt-browser-path` adapter lifecycle |
| Validated request authority, no draft modification/Send interference | `chatgpt-request-authority`, `chatgpt-recording`, `chatgpt-removal`: no-DOM and delayed request capture, DOM-only exclusion, original fetch/injection/click/prevention counters |
| Exact Unicode/BOM/line bytes, text bounds, unsupported operations | `chatgpt-transport`, `chatgpt-request-authority`, `chatgpt-recording`: 256 KiB, invalid Unicode, parent-linked history and attachments/multimodal exclusions |
| Separate distinct message IDs from duplicate provider requests | `chatgpt-request-authority`, `chatgpt-recording`: retry/reload/multitab/reopen deduplication, conflicting bytes and lost IPC acknowledgement |
| Durable save before acknowledgement; ordered OFF and stale rejection | `resident-engine` holds unfinished metadata save while queuing OFF and capture; `chatgpt-recording` storage/key/partial-write faults and OFF buffers |
| Conservative idempotent/crash-safe migration; recovered OFF | `resident-engine`: legacy table, orphan snapshot, pointer publication/restart, recovery with fresh keys; `debug-session` actual killed child/restart |
| Navigation, unsupported surface, permission, disconnect/reconnect gaps | `chatgpt-recording`, `native-bridge-lifecycle`: real framing/relay child, new epochs, unavailable/OFF/ON indicator recovery, stale refresh/ack rejection, bounded backoff |
| Queue/account/anchor failures independent of local evidence and Send | `resident-engine`: local save/export at 512-job saturation, two workers, bounded pending resumption while OFF and after restart, unfinished metadata exclusion, local account prerequisites versus durable external attempts, saved transaction reuse, six account/service failures |
| Fast confirmation and later proof | `fast-confirmation`, fixed `algorand-archive`; synthetic consensus-transition test with actual signed-log portable proof kept FIXTURE_VERIFIED |
| Legacy bytes/meaning, no executable authority | `resident-engine` immutable old observation and no submit/upgrade; `recipient` historical cancellation/unknown assertions; `legacy-archive` original/restored fixed proof |
| Least-authority controls and removed commands/resources | `chatgpt-sidepanel`, `chatgpt-removal`, `chatgpt-browser-path`: source roles, old controls/endpoints/page/native messages rejected and no executor in selected shipping sources |
| Export selection races, hostile input and independent recipient | `resident-dashboard`, `recipient`, real `dashboard-browser` and `recipient-browser` using fresh Chrome profiles |
| Diagnostic privacy, persistence and bounds | `product-diagnostics`, `debug-session`: canaries, fixed schemas, pseudonyms, opt-in retention, interrupted SQLite writes, file ownership and output limits |
| Native identity/keys, packaging/update safeguards | `macos-app-host`, `desktop-branding`, `private-development`, distribution/preflight/artifact/leak tests |

Names in this matrix refer to files under `test/`; ordinary Node tests end in
`.test.mjs`, browser/archive entrypoints in `.mjs`.
`npm run test:product` additionally runs six named product fixtures through
actual local components with explicitly synthetic external dependencies.

## Remaining legacy references and their purpose

- `recipient/legacy-observation.mjs`: frozen observation/2 schema, old
  Continuous mode, adapter/5 and page identity. Reading cannot create new capture
  or anchor jobs. New observations use the separate closed observation/6 schema.
- `recipient/portable.mjs`, `local.mjs` and dashboard historical labels:
  original Sealed/Always Protect/Continuous, cancellation and uncertain-outcome
  assertions are needed to interpret/export old signed receipts truthfully.
  No action is reconstructed from them.
- `recipient/legacy-demo.mjs` and fixed `demonstrator/testdata`: old export,
  proof-reference and recovery-index interpretation. The helper only parses,
  verifies and reconstructs a disclosure in memory. Testdata is not shipped.
- `vault/records.mjs`: old local-record/1 and pap-poc/1 labels
  (`trusted_local_composer`, Continuous) remain exact schema checks.
- `engine-store.mjs`: the one allowed legacy global Continuous migration is
  explicit. Old operations are discarded as control input; legacy journal files
  are never opened for execution.
- `development/runtime-state.mjs`: `composerURL` is accepted only to validate
  and replace an old private locator after the resident lock; no old endpoint is
  contacted.
- `diagnostics/local.mjs` and debug-session fixtures retain fixed old
  event/reference vocabulary so existing content-free reports remain readable.
  Those codes cannot activate a workflow.
- `test/fixtures/desktop-identities.json`, recipient/migration/removal fixtures and
  immutable proof vectors deliberately preserve old identities and negative
  examples. Historical `RESULTS.md` and
  `development/HISTORICAL-READINESS.md` describe their original baseline only.
- Software **release**, **sealed bundle**, signing, rollback and Swift
  `DispatchQueue` terminology describes distribution or platform primitives.
  Provider **composer** names describe ChatGPT's own observed input.

No fixed historical testdata or recorded results were rewritten. Active
documentation does not advertise the removed workflows.

## Execution and limits

Platform: Apple-silicon macOS 15.7.9, Node 22.23.1, headless Chrome
153.0.8010.37. Tests use scrubbed environments, fresh temporary directories,
memory/generated fixture keys, isolated local sockets/HTTP/TLS, and new
headless profiles with mock Keychain and external DNS blocked. Native compilation
and ad-hoc packaging use fresh output/cache paths; no Developer ID signing,
installation or retained-key authority is exercised.

Final complete Node run (`node --test test/*.test.mjs`): **311 passed,
0 failed, 0 skipped**. This includes real native host compilation, a fresh ad-hoc
app/recipient package, removed-resource checks, fixed identity validation and
offline verification from the packaged recipient. All six product scenarios
also passed. The earlier focused ON/OFF/compatibility/debug/package run passed
100 tests with no failures or skips. The focused recording/engine/account/
dashboard/removal run passed 70 tests; the subsequent full run includes additional
credential-checkpoint, ambiguous-request, metadata-save and stale-refresh
regressions. All preserve the original accounting and consent bounds.
Actual dashboard checks passed all eight disclosure-race scenarios and lifecycle,
privacy, account/export/recovery paths. Recipient UI and both fixed proof/archive
commands passed. The archive checks perform no network submission.

The initial broader run exposed stale fixture imports and resource inventories;
these were corrected without weakening acceptance checks. A dashboard test's
evaluation crossed its own Page.reload; bounded polling now waits for the new
document while retaining every disclosure assertion. Sandbox denial of local
sockets was rerun with the required local access and the same isolated fixtures.
The final package pass also corrected a missing Attestamp guide heading and made
the removal test check retired files instead of an untracked empty directory.

Go source tests were attempted in a new source/cache copy with Go 1.25.1,
GOENV/GOTOOLCHAIN fixed and GOPROXY/GOSUMDB disabled. Setup failed because the
local dependency cache lacks pinned `golang.org/x/crypto v0.52.0` (and
`x/sys v0.45.0` is also unavailable). No module was downloaded, no Go source
was changed and no production-toolchain result is claimed. The unchanged
locally available native verifiers passed fixed archive checks.

Installed sidebar trust rejection/interaction, real AppKit journeys, provider
markup, live capture/anchoring, production signing/notarization/Store publication,
other OS/browser versions and production-toolchain rebuilds remain unexecuted.
No retained kit, operational vault/Keychain/browser, ledger, provider account or
external transaction was touched. A synthetic PASS does not establish installed
acceptance.

Subsequent sidebar work reproduces the false rejection after authenticated fixture
pairing in real Chrome 153, then verifies the repaired control boundary. The
[sidebar evidence guide](SIDEBAR.md) records the actual metadata, control checks
and synthetic/OS-bound limits separately from the rework evidence above.
