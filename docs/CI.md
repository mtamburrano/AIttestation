# Deterministic continuous integration

The workflow runs the portable lane on pull requests and manual dispatch only.
Native macOS checks require an explicit dispatch with the macOS input selected.
There is no push trigger, schedule, deployment, signing service or paid/self-hosted
runner assumption. Do not dispatch if it would require paid runner usage.

| Lane | Local equivalent | Checks |
| --- | --- | --- |
| Portable Node | `npm run ci:portable` | Current and clean-clone bootstrap, hygiene, generated browser consistency, dependency/notice inventory, CI policy and adversarial boundary corpus |
| macOS native | `npm run ci:macos` | Isolated coding lifecycle/native receiver and coding, Firefox, mixed-source integration regressions |

Both lanes use the same checked-in commands as local development. The portable
fixture paths use the OS temporary directory. The macOS lane needs Command Line
Tools; it uses disposable ad-hoc signatures, memory keys and synthetic clients.
Neither lane executes vendor clients, live providers, chain transactions, sponsor
services, installed browser batteries or owner configuration. GitHub infrastructure
downloads actions and the pinned Node runtime; the tests themselves need no
external services, package installation or advisory lookup.

Workflow permissions are limited to repository contents read, checkout credentials
are not persisted, and actions use immutable upstream commit pins. Concurrency
cancels superseded runs. Jobs have 8/12 minute limits and artifacts expire after
three days. The workflow is JSON-form YAML so local policy tests parse its exact
structure without installing another YAML parser. Its action versions are
[checkout 4.2.2](https://github.com/actions/checkout/releases/tag/v4.2.2),
[setup-node 4.4.0](https://github.com/actions/setup-node/releases/tag/v4.4.0), and
[upload-artifact 4.6.2](https://github.com/actions/upload-artifact/releases/tag/v4.6.2).

Each local run writes bounded content-free results to `artifacts/ci-portable/`
or `artifacts/ci-macos/` and refuses to overwrite existing evidence. For another run,
pass a fresh path: `npm run ci:portable -- /absolute/new-report-directory`.
Failures name the exact check; rerun its documented command locally. Native fixture
reports include reproduction commands and product/harness/external classifications.
No raw prompt, config file or arbitrary exception text is uploaded.
Native acceptance runs outside the checkout; only its three bounded report files
are copied into the upload directory after completion. This preserves the product
runner's refusal to create private fixture resources inside a repository.

`npm run check:dependencies` prints a deterministic repository bill of materials:
nine Go pins/checksums and notice hashes, the vendored TOML parser and license,
language requirements and project license policy digest. This is SBOM-style JSON,
not a claim of SPDX conformance, current vulnerability clearance, or a complete
shipping binary/toolchain attestation. The stricter distribution inventory remains
the release authority. Changed pins, notices or vendored bytes fail consistency
checks; there is no live advisory query in baseline CI.

The small [performance guardrail](PERFORMANCE.md) evaluator regression runs in the
portable lane. Full 10k/50k vault and native timing measurements are an opt-in local
release checkpoint, keeping routine PR jobs small.

Local validation does not prove a hosted Actions run. Hosted Linux execution and
native runner-image differences remain visible evidence boundaries until executed.

The adversarial corpus uses finite JSON key escapes, hook truncations, native frame
partitions, TOML token lookalikes and ZIP structural mutations. Fresh named pipes
check that file validation rejects nonregular inputs before a blocking read, with
a 1.5-second child-process kill limit. Reproduce it with
`node --test test/adversarial-boundaries.test.mjs`; it needs no sockets or clients.
