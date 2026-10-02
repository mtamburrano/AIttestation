# Publication readiness audit — 2026-10-02

The cumulative hardening changes received a final source and documentation sweep
covering onboarding/consent, parser and file inputs, contributor bootstrap, CI,
artifact policy, recovery, update authority and bounded operations. This is a
maintainer audit, not independent security or release
approval. No architecture rewrite or compatibility identifier change was needed.

Concrete findings closed during the sweep:

- Desktop discovery omitted the current ChatGPT `codex-cli/CodexCLI.app` runtime
  and `codex-cli/bin/codex` layout. Both are now explicit bounded probes alongside
  the legacy paths. Canonical executable aliases deduplicate, and detection still
  grants no authority. Synthetic current-only and current-plus-legacy fixtures
  cover discovery, explicit selection, consent and executable replacement checks.
- Late Connections discovery/preview responses could revive an obsolete selection
  and let Apply dispatch its operation under a different client. Every selection
  edit or new request now advances a revision; responses and Apply also check the
  exact client, executable, root, interpreter and candidate snapshot. Stale success
  and error responses are discarded, including changes back to the original choice.
  Fresh previews require fresh consent. Deferred in-memory fixtures exercise the
  shipped handlers, out-of-order requests, candidate changes and Apply without an
  edit event. The focused coding regression set passed 76 tests after these repairs.
- Streaming recovery still opened a FIFO before checking for a regular file.
  A timed subprocess reproduced the hang; nonblocking open now lets the existing
  type check reject it. Regular recovery and historical evidence semantics remain.
- The macOS CI lane requested a product-fixture output inside the checkout. It now
  runs outside the repository and copies only bounded reports to the upload area.
  The local lane passed coding lifecycle/native checks and 34 integration tests.
- The product-runner guide had an obsolete deadline, and a private guide implied
  arbitrary acceptance namespaces were supported. Both descriptions now match
  the implementation; the retained namespace allowlist is unchanged.

The discovery and asynchronous-selection findings were reproduced before repair.
Their focused tests extend the existing fixtures; no installed vendor client or
provider was exercised. Actual vendor hook emission is not established by runtime
discovery. The dual Codex TOML/JSON hook configuration still receives a precise
non-destructive conflict message; automatic merge or repair is not claimed.

The repository hygiene gate checks current tracked/nonignored files, public local
links, generated browser consistency and package/source membership. Four exact
hash-pinned exceptions cover deliberate negative secret-detection fixtures.
Original third-party licenses and historical protocol/crypto identifiers remain.
The license policy explicitly leaves unresolved file scope and rights as publication
decisions; the repository does not imply a blanket license grant or production
availability. This audit is not a certification of full Git history or every binary.

Run the final [offline readiness command](RELEASE-READINESS.md) with `--full` from
the clean committed revision. Its `readiness.json` is the execution record: it binds
the exact revision, checks, package provenance and external gates. Generate a new
report after these repairs and preserve the previous report at its original scope.
A failed or missing report is not a pass. The full suite covers all deterministic Node test
files sequentially; it does not run the provider/browser campaign. The separate
local CI reports retain the prior portable and native lane outcomes. The refreshed
readiness run covers the changed coding tests, clean-clone bootstrap, CI policy and
package checks; it does not imply a new native timing run or hosted Actions result.

The [performance checkpoint](PERFORMANCE.md) passed with fresh 10k/50k mixed-source
vaults. At 50k prompts: startup 3.42 ms, recent History 16.58 ms, peak RSS 202.44 MiB,
405.48 MiB checkpointed vault; startup read one header and no evidence records or
objects. Recovery verified all 100,000 records. Sixteen native paths passed with a
223.354 ms maximum sample. These warm-cache synthetic measurements remain scoped;
the subsequent recovery open-flag fix changes only nonregular-input handling.
The desktop path and dashboard selection repairs change none of those measured
vault or native admission paths, so the scale and native timing evidence is reused.

Independent review of the repaired final source remains required. The generated
report's external owner actions are unchanged: actual installed vendor hook
trust/emission when access is available; signed distribution and custody/native
acceptance; browser signing/publication when intended; and final version, rights,
license scope, brand, private security contact and publication approval. Unavailable
Claude access stays deferred. No subscription renewal, funding, DNS, hosting, paid
runner or repeat of automated lifecycle tests is required by this audit.

The offline package uses explicitly hashed local Go helpers and records that they
were not rebuilt from source. Signed release preflight still requires its exact
approved toolchain, source rebuild and legitimate release inputs. Hosted runner
differences and signed installed behavior remain untested here. Existing unchanged
Chrome/Firefox evidence retains its original scope; any warranted new real-browser
or provider battery belongs to a separately authorized later checkpoint.
