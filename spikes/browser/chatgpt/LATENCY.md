# Local runtime latency checks

Run `node test/runtime-latency.mjs --check` or
`node --test test/runtime-latency.test.mjs` with a clean environment. The fixture
creates a fresh private temporary vault containing 48 synthetic prompts and 320
retained records, plus a full 2,048-event durable debug journal. It uses the product
runtime, native framing, worker and content
scripts with synthetic platform/browser identities. Its sponsor is unavailable;
credential latency is an explicit 40 ms synthetic broker wait. No installed
profile, real Keychain account, owner vault, sponsor ledger or provider is used.

The report contains only fixed operation names, wall/CPU timings, counts and the
fixture configuration. It separately measures cold/warm receipt reads, selective
preview, engine/dashboard reads, capture, ON/OFF and debug controls. Debug-enabled
and debug-disabled paths, including concurrent History/dashboard/control requests,
must both stay below the 1,500 ms local response budget.
These are regression bounds, not claims about every Mac or the installed owner's
resources. Socket tests require permission to bind temporary Unix/loopback sockets.

The initial comparison on one development Mac found repeated receipt reads at
493 ms, preview at 524 ms, dashboard reads during the synthetic outage at
1,120–1,937 ms and ON/OFF work up to 944 ms. The updated snapshot cache and
asynchronous broker path reduced those same first-run measurements to under
1 ms, 2 ms, 60 ms and 79 ms respectively. CPU and wall measurements distinguish
the repeated index/receipt work from the injected broker wait. The exact timing
report is emitted by each execution; rerun on the target environment for current
measurements.

A final run with the full debug journal on 2026-09-22 measured the following wall
times. The initial comparison above used a smaller debug journal.

| Operation | Debug off | Debug on |
| --- | ---: | ---: |
| Engine state | 4 ms | 3 ms |
| Dashboard state | 55 ms | 63 ms |
| History during background work | 30 ms | 69 ms |
| Concurrent History/dashboard/OFF | 107 ms | 122 ms |
| Recording ON | 19 ms | 115 ms |
| Durable capture confirmation | 115 ms | 146 ms |
| Recording OFF | 60 ms | 114 ms |
| Debug control | 7 ms | 7 ms |
| Single debug event | <1 ms | 8 ms |

Cold history was 29 ms, warm history under 1 ms, and selective preview 2 ms.
All eight latency/receipt regressions, 320 browser/engine tests, 42 debug-session
tests and 32 real-Chrome synthetic scenarios passed. These runs used Node 26.5.1
and Chrome 153.0.8010.53 with fresh temporary resources.

Additional tests exercise the actual framed asynchronous broker over descriptors
owned by a synthetic parent process, an unused loopback TLS sponsor port, a locked
credential response and disconnect during lookup. Receipt tests cover delayed
admission beyond the former timeout, lost native replies, late success after
control/navigation changes, exact source rejection, equal-text distinct Sends,
stable-ID deduplication and restart. Cache tests cover another database writer,
changed ciphertext, failed commits, custody reopen and full export verification.
Compatibility checks cover an older engine without receipt-query support, and a
committed descriptor whose caller receives a post-commit error.

No live provider Send, installed rebuild or external transaction is part of these
checks. Independent review and a separately resumed owner checkpoint are needed
to validate the installed experience.
