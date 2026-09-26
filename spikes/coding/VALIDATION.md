# Mac integration validation

Recorded September 25–27, 2026, on Apple-silicon macOS. These results distinguish
local synthetic validation from installed vendor-client and release acceptance.
They do not establish public release readiness or universal IDE/desktop support.

## Executed checks

The consolidated suite passed **699/699 tests** before the final native identity
optimization. That completed evidence was retained when work resumed. Focused
regressions after the change passed **57/57 tests**, including registration,
real local sockets, private native guards and simultaneous Chrome/Firefox channels.
Final artifact/private-native checks passed **65/65 tests**; focused Dashboard and
coding checks passed **13/13**. These sets overlap and are not additive totals.

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
in size to the installed Codex binary. Each path has 60 samples.

| Path | p50 ms | p95 ms | p99 / max ms | Saved | Above 250 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| OFF | 66.37 | 83.02 | 132.44 | 0 | 0 |
| ON, admitted | 99.36 | 119.76 | 138.66 | 60 | 0 |
| Busy | 99.96 | 132.68 | 141.19 | 0 | 0 |
| Re-signed client | 99.45 | 125.98 | 161.19 | 0 | 0 |
| Resident unavailable | 21.20 | 25.27 | 26.28 | 0 | 0 |

All invocations exited 0 with empty stdout/stderr. The changed client was rejected
by native authentication before admission. Full executable hashing is performed
at explicit enrollment; per-prompt native validation checks the running code
against the enrolled CodeDirectory requirement. This follows Apple's
[dynamic validation contract](https://developer.apple.com/documentation/security/seccodecheckvalidity(_:_:_:)).
It pins the enrolled build, not a vendor endorsement.

Timing begins immediately before the already-running fixture client forks the
hook and ends after it exits. Cold startup of the separate 203 MiB fixture client
reached 1.55 seconds and is recorded separately; it is not hidden in the hook
percentiles. The 250 ms timer is an emergency bound, not a performance target.
About 100 ms median admission still needs measurement and perceptual evaluation
with actual interactive client hooks. Synthetic timing alone cannot establish
that the delay is imperceptible in those clients.

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
| Codex CLI | 0.136.0-alpha.2 | Version identified; actual interactive user-hook/trust path not exercised. |
| Codex desktop | 26.527.60818, build 3437 | Installed version identified; hook emission not established. |
| VS Code | 1.137.0 | Editor identified; extension version and actual hook emission not established. |
| Claude Code | Not available in the checked local install locations | Requires a selected version exposing `prompt_id` (2.1.196+), official trust/setup and an isolated interactive check. |
| Claude desktop | Not installed in the checked application location | No desktop coverage claimed. |
| Firefox | Reported 153.0.1, build 15326.7.27 | Installed signature fails strict macOS verification; browser execution stopped. |
| Firefox persistent add-on | No signed XPI | Requires separately authorized Mozilla signing and restart validation. |

The first Firefox attempts used a fresh profile but launched the installed app.
It started three updater processes from its existing installation-level update
cache before loading profile preferences. Those test-launched processes were
stopped. A subsequent strict signature check failed. No strict baseline exists,
so this record cannot attribute the invalid signature to the test or prove it
predated it. The installed app/cache was not repaired or cleared. The revised
harness verifies the app before launch, clones it, restricts writes to the fresh
test root and limits egress to loopback. It has not completed on a valid Firefox
installation; temporary sidebar/native and persistent restart checks remain open.

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
