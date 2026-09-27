# Mac integration validation

Recorded September 25–27, 2026, on Apple-silicon macOS. These results distinguish
local synthetic validation from installed vendor-client and release acceptance.
They do not establish public release readiness or universal IDE/desktop support.

## Executed checks

The consolidated suite passed **715/715 tests**, with no skips, on September 27.
It includes six install/remove cycles for each coding client beside Chrome,
removal and OFF/ON during authentication, bounded rejection diagnostics, and
Firefox interrupted update/remove recovery before and after manifest replacement.
Concurrent unrelated edits remain conflicts and are preserved. Tests use fresh
temporary directories, explicit configuration roots, memory keys and synthetic
services; inherited credentials and settings were removed from the test process.
The earlier 699-test run and overlapping focused sets remain historical evidence.
The subsequent native watchdog change was validated by the native harness below.

The mixed-source fixtures exercise exact text, distinct equal submissions,
Claude prompt replay, immutable legacy rows, bounded History/search, selected
export, standalone verification and recovery. Browser coexistence exercises
separate authenticated channels to one vault, cross-source token rejection,
OFF/ON invalidation, disable and continued Chrome capture after Firefox disconnects.
Browser/platform identities in those fixtures are explicitly synthetic.

Real **Chrome 153.0.8010.53** passed 32 capture checks in a fresh profile with
synthetic intercepted provider responses. Real Dashboard and
sidebar checks also passed, including two-window ON/OFF, popup/tab/iframe rejection,
copied-URL attacks, recovery controls and export without service access. The
new connection flow passed preview-without-writes, explicit consent, apply,
disable and owned-manifest removal in a fresh temporary directory. Dashboard and
sidebar runs used disposable application copies. The
sidebar harness must activate its own disposable application before opening a
popup. These checks use memory keys and synthetic native identity, not production
Keychain or installed native-host attestation.

## Native hook timing

The native harness uses a fresh ad-hoc-signed application, real macOS kernel peer
identity and signature checks, a synthetic enrolled native client, memory keys
and a fresh vault. The final run used a **213,500,936-byte executable**, comparable
in size to the installed Codex binary. Hardware: Apple M1 Pro; macOS 15.7.9
(24G830), Darwin 24.6.0; Node 22.23.1. Each ordinary path has 60 samples.
One/five/fifteen-minute load averages were 6.26/6.97/5.98 before the run and
7.25/7.15/6.08 afterward. Raw samples and stage measurements are retained in
[`native.json`](../../test/evidence/mac-hook-admission/native.json).

| Path | p50 ms | p95 ms | p99 / max ms | Saved | Above 250 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| OFF | 28.53 | 34.77 | 45.97 | 0 | 0 |
| ON, admitted | 58.85 | 73.33 | 89.68 | 60 | 0 |
| Busy | 57.61 | 69.39 | 84.00 | 0 | 0 |
| Re-signed client | 55.50 | 67.66 | 85.97 | 0 | 0 |
| Resident unavailable | 21.20 | 27.29 | 58.20 | 0 | 0 |

All **309 invocations** exited 0 with empty stdout/stderr. Nine additional boundary
attempts cover stalled stdin, malformed JSON and oversized stdin (three each);
all saved nothing. Their maximum hook durations were 230.20, 75.73 and 29.44 ms.
An earlier stalled-input experiment measured 274.80 ms with a 250 ms timer, so
the watchdog now fires at 200 ms to reserve startup/scheduling margin. The final
harness asserts that every measured invocation stays within 250 ms. This finite
measurement does not guarantee scheduling on an arbitrarily stalled machine.

The changed client was rejected
by native authentication before admission. Full executable hashing is performed
at explicit enrollment; per-prompt native validation checks the running code
against the enrolled CodeDirectory requirement. This follows Apple's
[dynamic validation contract](https://developer.apple.com/documentation/security/seccodecheckvalidity(_:_:_:)).
It pins the enrolled build, not a vendor endorsement.

The receiver now uses native transport directly; the authenticated resident runs
the shared vendor decoders. Per-invocation Node startup has been eliminated without
removing bundle, resident, receiver, enrolled-client or process-ancestry checks.
The prior ordinary ON result was 99.36 ms median / 119.76 ms p95.

| ON stage | p50 ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| Native startup | 6.40 | 10.45 | 11.52 |
| Bundle signature | 13.68 | 15.42 | 17.32 |
| Rendezvous and connect | 0.24 | 0.32 | 0.35 |
| Resident signatures | 4.40 | 9.42 | 19.66 |
| Input encoding and send | 1.76 | 2.46 | 2.79 |
| Admission round trip | 29.36 | 39.30 | 60.78 |
| Peer validation within that round trip | 28.94 | 38.91 | 60.26 |
| In-memory admission within that round trip | 0.03 | 0.05 | 0.19 |
| Release round trip | 0.13 | 0.30 | 0.48 |

Nested measurements overlap; their percentiles must not be added. Timing probes
are compiled into the disposable fixture, never enabled by a production flag.
Timing begins immediately before the already-running fixture client forks the
hook and ends after it exits. Cold startup of the separate 203 MiB fixture client
reached 1.51 seconds and is recorded separately; it is not hidden in the hook
percentiles. The 250 ms ceiling is an emergency bound, not a performance target.
The improved 59 ms median still needs measurement and perceptual evaluation with
actual interactive client hooks. Synthetic timing alone cannot establish that
the delay is imperceptible in those clients.

## Bounded storage

The isolated warm-cache benchmarks contain a mixture of Chrome, Firefox, Codex
and Claude observations with 4 KiB pages. Neither startup read evidence records or
objects; each read one header. Recent History read 25 records/40 objects, paging
15/15 and selective search 7/7 at both sizes.

| Prompts | Startup ms | Recent ms | Page ms | Search ms | Peak RSS MiB | Disk MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 2.77 | 18.72 | 7.83 | 4.81 | 158.64 | 80.94 |
| 50,000 | 3.96 | 17.20 | 6.57 | 3.67 | 167.67 | 405.46 |

These are synthetic local measurements, not cold-disk or universal performance
guarantees. The benchmarks were not rerun merely to resume the interrupted work.

## Installed coverage and remaining prerequisites

| Surface | Observed version | Evidence / remaining check |
| --- | --- | --- |
| Chrome | 153.0.8010.53 | Real isolated capture, Dashboard and sidebar passed. |
| Current ChatGPT desktop Codex runtime | App 26.908.70816 (9275); runtime 0.154.0-alpha.6.2 | Exact bundled binary version and OpenAI signature verified; actual hook emission/trust remains untested. |
| VS Code Codex extension | 26.917.62051; bundled runtime 0.155.0-alpha.16.3 | Exact bundled binary version and OpenAI signature verified; actual IDE hook emission remains untested. |
| Optional global Codex CLI | 0.151.0 in the recorded owner inventory | Separate entrypoint; no hook-emission claim from the desktop or IDE binaries. |
| Older Codex.app | 26.527.60818; runtime 0.136.0-alpha.2 | Separate unused installation; does not establish the current unified desktop's capabilities. |
| Claude Code VS Code extension | 2.1.283; bundled runtime 2.1.283 | Exact binary version and Anthropic signature verified; actual IDE hook emission remains untested. A global CLI is not required to select this surface. |
| Claude desktop | Not installed in the checked application location | No desktop coverage claimed. |
| Firefox | 153.0.1; buildID 20260727124451 | Strict app signature and real temporary-extension sidebar checks passed; packaged native-host chain remains unverified. |
| Firefox persistent add-on | No signed XPI | Requires separately authorized Mozilla signing and restart validation. |

The corrected Firefox harness verifies and clones the installed app, uses a fresh
profile/HOME, keeps Firefox's sandbox, and enables Mozilla's nonlocal-network
automation guard. It uses Firefox 153's explicit Remote Agent system-access opt-in
only to automate extension pages. Background startup, a real button opening exactly
one sidebar, and the real sidepanel's ordinary-tab rejection all passed. The
earlier invalid-app-signature observation is cleared for this installed app; its
cause remains unknown. This does not establish extension signing or the native
chain. No installed app/cache repair or signature-enforcement bypass was used.

Current verified CodeDirectory identities (these pin builds, not hook coverage):

| Binary | CDHash | Vendor team |
| --- | --- | --- |
| ChatGPT desktop `Contents/Resources/codex` | `328d6fff18136f9a45750d30e793622de20a84b1` | `2DC432GLL2` |
| Codex VS Code `bin/macos-aarch64/codex` | `7de864b4e3332438092c6ef5f8ac7926dcd04187` | `2DC432GLL2` |
| Claude VS Code `resources/native-binary/claude` | `3250f2eaeece15c055bbce96c9ca345b5d404465` | `Q6L2SF6YDW` |

One executable/interpreter is enrolled per coding client. Switching between the
different Codex desktop/IDE binaries requires a new preview/enrollment and any
renewed vendor trust. Their simultaneous interchangeability is not supported by
these measurements. The primary desktop runtime lives in ChatGPT.app, which is
checked before the older Codex.app during bounded default discovery.

All other checks used fresh temporary resources, memory keys or uniquely signed
synthetic native fixtures. No provider Sends, chain transactions, retained owner
vault/Keychain resets, signing-service uploads or publication were performed.

Use the single prerequisite bundle and walkthrough in Mac connections (`SETUP.md`
in the source tree; `Mac Connections.md` in the generated package).
Resolve installed-client and Firefox coverage before claiming the expanded Mac
package is accepted. Windows, Linux, remote/container clients, noninteractive
invocations and subagents remain outside verified coverage.

## Repeatable commands

Use Node 22.13 or later. Each harness creates its own temporary resources; native
and browser checks require macOS plus their stated local applications/toolchain.
Do not substitute operational storage, signing configuration or browser profiles.

```sh
npm test
npm run test:mac-integrations
node --test test/artifact-policy.test.mjs
node test/mac-hook-native.mjs /private/tmp/NEW-native-report.json --large-client
node test/vault-scale-benchmark.mjs --child 10000 4096 --mixed
node test/vault-scale-benchmark.mjs --child 50000 4096 --mixed
npm run test:capture-browser
npm run test:dashboard-browser
npm run test:sidepanel-browser
node test/firefox-browser.mjs
```
