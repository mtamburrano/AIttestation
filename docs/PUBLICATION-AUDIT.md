# Publication readiness audit — 2026-10-02

The cumulative hardening changes received a final source and documentation sweep
covering onboarding/consent, parser and file inputs, contributor bootstrap, CI,
artifact policy, recovery, update authority and bounded operations. This is a
maintainer audit by the implementing agent, not independent security or release
approval. No architecture rewrite or compatibility identifier change was needed.

Concrete findings closed during the sweep:

- Streaming recovery still opened a FIFO before checking for a regular file.
  A timed subprocess reproduced the hang; nonblocking open now lets the existing
  type check reject it. Regular recovery and historical evidence semantics remain.
- The macOS CI lane requested a product-fixture output inside the checkout. It now
  runs outside the repository and copies only bounded reports to the upload area.
  The local lane passed coding lifecycle/native checks and 34 integration tests.
- The product-runner guide had an obsolete deadline, and a private guide implied
  arbitrary acceptance namespaces were supported. Both descriptions now match
  the implementation; the retained namespace allowlist is unchanged.

The repository hygiene gate checks current tracked/nonignored files, public local
links, generated browser consistency and package/source membership. Four exact
hash-pinned exceptions cover deliberate negative secret-detection fixtures.
Original third-party licenses and historical protocol/crypto identifiers remain.
The license policy explicitly leaves unresolved file scope and rights as publication
decisions; the repository does not imply a blanket license grant or production
availability. This audit is not a certification of full Git history or every binary.

Run the final [offline readiness command](RELEASE-READINESS.md) with `--full` from
the clean committed revision. Its `readiness.json` is the execution record: it binds
the exact revision, checks, package provenance and external gates. A failed or
missing report is not a pass. The full suite covers all deterministic Node test
files sequentially; it does not run the provider/browser campaign. The separate
local CI report records portable and native lane outcomes; no hosted Actions run
has been claimed or dispatched.

The [performance checkpoint](PERFORMANCE.md) passed with fresh 10k/50k mixed-source
vaults. At 50k prompts: startup 3.42 ms, recent History 16.58 ms, peak RSS 202.44 MiB,
405.48 MiB checkpointed vault; startup read one header and no evidence records or
objects. Recovery verified all 100,000 records. Sixteen native paths passed with a
223.354 ms maximum sample. These warm-cache synthetic measurements remain scoped;
the subsequent recovery open-flag fix changes only nonregular-input handling.

Only the generated report's owner actions remain: actual installed vendor hook
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
