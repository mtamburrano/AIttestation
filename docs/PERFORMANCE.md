# Release performance and boundedness guardrails

```sh
npm run test:performance
```

This opt-in suite extends the product runner and `test/vault-scale-benchmark.mjs`.
It creates separate fresh 10k and 50k synthetic mixed-source vaults, each with two
real signed records per prompt, then runs the existing native hook fixture in its
quick mode. It uses memory keys and disposable ad-hoc native identities. No owner
vault, vendor client, provider, chain, sponsor service or Keychain is accessed.
Apple-silicon macOS and Command Line Tools are required for native evidence.

The default PR lane checks the small guardrail evaluator test; it does not build
50k prompts. Run the full command at a release checkpoint or after changing these
boundaries. Reuse its evidence when those boundaries are unchanged. One path can
be repeated through `npm run test:product -- --scenario performance-scale-50k`
(also `performance-scale-10k` and `performance-native`). An explicit fresh report
path is supported with `--output /absolute/new-performance-report`.

The bounded product JSON/HTML report names failing paths and contains measurements,
limits and counts. It never contains exact prompt text, keys or vault paths. A
missing, nonnumeric, failed or timed-out result cannot become PASS. Fixture files
are removed on normal completion. An externally killed benchmark may leave only
its newly created OS-temporary fixture directory; remove that run's directory
when no longer needed.

| Hard gate | Limit and rationale |
| --- | --- |
| Startup | Zero evidence records/objects read, at most two headers. Existing measurements read one header, independent of archive size. |
| History/page/rare and common search | At most 40 records and 60 objects per view, including five-receipt responses. The existing scale benchmark already enforces these structural limits. Full materialization and record iteration are explicitly forbidden during ordinary views. |
| Selected export | Five receipts/ten records; at most 60 records/80 objects read; at most 1 MiB output. Ordinary per-bundle product limits remain unchanged. |
| Local operation ceiling | 1,500 ms for startup, views, selected export and verification. Existing runtime tests use this budget; historical scale views were below 25 ms. This catches large regressions, not small timing changes. |
| Peak process RSS | 768 MiB, including fixture creation, crypto and full recovery. Historical 50k measurement was about 157 MiB. This is a coarse retention/allocation alarm. |
| Synthetic vault and backup size | At most 16 KiB per prompt for each. Historical vault storage was about 8.3 KiB per prompt. This fixture-specific bound is not a user archive quota. |
| Full streamed recovery | Exact twice-prompt record count and valid chain; export and verification each at most 180 seconds. Throughput is informational. No whole-vault JavaScript materialization is permitted. |
| Process ceilings | 600 seconds per scale child (including dataset creation), 120 seconds for native fixture, 22 minutes for the whole runner. No dependency downloads. |
| Native hooks | Existing 250 ms per-sample fail-open deadline across 16 paths, exact saved counts and authentication rejections. Quick mode uses three samples per path. |

Timing percentiles, capture/recovery throughput and measured RSS/disk below those
ceilings are informational. The native three-sample percentiles are a smoke signal,
not a statistically meaningful tail guarantee. Filesystem caches are warm; startup
excludes module loading, GUI and real Keychain access. Historical reference data is
in [the scale measurements](../spikes/vault/scaling-benchmark.json). Prefer the
read-count invariants over cross-machine millisecond comparisons. A failed bound
needs investigation; do not silently raise it to accommodate a regression.
