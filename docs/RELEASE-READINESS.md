# Offline release readiness

From a clean committed Apple-silicon macOS checkout, run:

```sh
npm run readiness -- /absolute/new-readiness-report
```

Prerequisites are Node 22.13+, Git, macOS Command Line Tools and the three existing
offline Go helpers (`verify`, `fast-verify`, `fast-observe`) built under
`spikes/anchor/algorand/bin/`. The command hashes and copies those explicit local
inputs into a fresh source clone. It never downloads dependencies or reads a Go
cache. The development builder records `sourceRebuiltNativeTools: false`: this
rehearsal does not approve prebuilt helpers for signed distribution. The existing
signed release builder still requires an approved exact toolchain and source rebuild.

The gate strips inherited credentials/app settings, uses a fresh HOME and temporary
source clone, runs contributor smoke/hygiene, dependency checks, distribution/leak/
verifier regressions, the [upgrade/recovery rehearsal](RELEASE-REHEARSAL.md) and
isolated coding lifecycle acceptance, then builds a fresh
development package and standalone verifier. Existing artifact policy checks bind
source and dependency inventories, exact package content, channel behavior, native
identities and leak checks. The packaged verifier reads a fresh synthetic receipt
offline; ad-hoc signatures are checked without invoking the app or Keychain.

For the final consolidated regression checkpoint, add `--full`; this runs every
deterministic `test/*.test.mjs` once, with files run sequentially to avoid resource
contention in timing/native fixtures, instead of the focused distribution set. It does
not launch the real-browser/provider campaign. Existing unchanged browser evidence
is reused at its original scope. Native fixture acceptance remains available through
`npm run test:coding-acceptance`; do not repeat it merely between unrelated edits.
Run or reuse the [performance guardrails](PERFORMANCE.md) at their own release
checkpoint; the full readiness suite validates the guardrail evaluator without
rebuilding unchanged 10k/50k fixtures between tasks.

The new output directory retains `readiness.json`, `release-manifest.json`,
`repository-dependencies.json`, `artifact-policy.json`, the bounded coding report
and `development-package/`. Focused runs also retain the release-rehearsal report;
full runs cover the same test bodies in the consolidated suite. Failures retain a named check and safe classification;
they never become PASS by omitting a missing local prerequisite. The fresh working
clone is removed. Reports never overwrite an existing directory.

`spikes/distribution/release-plan.json`, `CHANGELOG.md` and versioned release notes
form a dry-run skeleton. The existing release example's version/sequence remain
drafts. Channel artifact names come from the real distribution contract, including
historical compatibility names. The manifest binds their source, dependency and
note digests. It creates no signed manifest, Store listing, deployment or publisher.

A PASS means the offline checks passed. `releaseReady` stays false and `authority`
stays NONE. The separate `ownerActionRequired` array batches installed vendor
trust/emission, signed distribution, browser publication and the final publication
decision. It calls for no repeated automated scenarios, subscription renewal, DNS,
hosting, funds or paid infrastructure. Real release preflight still fails closed
without actual signing, notarization, license/security approvals and channel inputs.
