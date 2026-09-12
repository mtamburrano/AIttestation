# Attestamp macOS distribution and adapter maintenance

The distribution implementation is local and testable. A signed/notarized
release-candidate path is available for review, while Chrome Web Store
publication and the installed Chrome/provider boundary have not been validated.
`installed-release.json` is deliberately `null` in the repository.
The keyed development manifest matches the assigned Chrome Web Store draft item
`medilhopfckldjgdnchfkpmfmfnkadca`; publication and installed validation remain
required.
Do not promote a development build based on passing synthetic fixtures.

## Build inputs and outputs

`npm run build:distribution -- --prepare NEW_OUTPUT_DIRECTORY` creates a fresh
ad-hoc **Attestamp.app**, standalone **Attestamp Verifier.app**, uploadable **Attestamp for ChatGPT**
extension ZIP, exact dependency inventory and source-hashed build provenance. It
does not install anything, touch
Keychain items, open a browser, publish to a store or contact notarization services.
Its provenance explicitly says `AD_HOC_ONLY`, `notarized: false`, and that the
development native tools were not rebuilt by this packaging step. Build the pinned
Go tools first using the existing Algorand build command. Local fixture builds
are not evidence of a clean-machine consumer install.

For a signed build, copy `release-config.example.json` outside the repository and
provision every input described below. Set `releaseChannel` explicitly to
`production` or `release-candidate`, then run:

```sh
npm run build:distribution -- --release /absolute/private/release-config.json /absolute/new/output
```

The production builder refuses missing identities, an unconfirmed store listing,
a dirty source checkout, a mismatched release signing key, or missing/currently
expired dependency approval. A `release-candidate` build may keep
`storeListingVerified: false` for pre-publication reviewer validation, but it
still requires every signing, notarization, update-root and dependency-approval
input below. It produces a clearly labeled signed/notarized candidate with no
stable manifest or installed production-release state. It rebuilds the three shipped Go tools from the recorded
source with explicit offline module/cache settings. It creates a nested Keychain
helper bundle with a checked Developer ID provisioning profile, signs executables
inside out with hardened runtime, preserves the bridge's pinned identifiers, then
notarizes and staples both apps and the disk image. Node alone receives the JIT
entitlement; it receives no Keychain groups. The helper alone receives the fixed
Keychain group. No disabled library validation, debugging entitlement or broad
filesystem/browser permission is added.

Production `stable.json` authenticates the disk image's exact size/hash, sequence,
schema reader bounds, platform, expiry and hashes of the dependency inventory and
build provenance. It is signed with a separate Ed25519 release key. Candidate
builds instead emit `release-candidate.json`, retain a null
`installed-release.json`, and never create `stable.json` or an update-ready
production state. App bundles carry the pinned public key and update origin. The
private key is never copied into the bundle or provenance. Public output is
prepared locally; publishing is a separate operator action. Even a successful
signed build reports that installed validation is required.

### Offline local release preflight

Before either a candidate or production build, run the preflight from the clean
source checkout with the exact Node executable selected for dependency approval:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin /absolute/approved-node/bin/node \
  spikes/distribution/preflight.mjs /absolute/private/release-config.json
```

`npm run --silent preflight:distribution -- /absolute/private/release-config.json`
is also available when the selected Node is already on PATH. The command reads
only local build inputs and writes a single JSON report to stdout. To save it,
redirect stdout to a **new file outside the checkout** using the shell's
no-clobber option and `umask 077`. A report in the checkout would make the source
dirty. Exit status 0 means all local checks passed; status 1 means rejection.

The preflight shares the builder's channel/config, clean-source, exact dependency
inventory/approval, update-key and helper-profile validators. It binds the actual
running Node binary, embedded versions and LICENSE, the full selected extracted
Go toolchain, shipping build plan and local Go inputs to current security/license
approval. Git index flags that can conceal edits (`assume-unchanged` and
`skip-worktree`) are rejected. It rechecks source and dependency digests before reporting success.
Approval must be regenerated when these inputs change, including the build
plan's explicit `GOTELEMETRY=off` setting.

Both preflight and signed builds require owner-only (0600) config, approval and
update-private-key files. The helper profile, executable Node/Go files, Node
LICENSE and explicitly configured module-cache directory must have trusted
ownership and no group/other write permission. Paths must be absolute and
canonical, without symlinked ancestors; file inputs cannot be symlinks, hard links
or special files. Ancestors must also have trusted ownership and safe permissions
(root-owned sticky temporary directories are allowed). Config/approval reads are
limited to 16 KiB, the signing key to 4 KiB and the helper profile to 1 MiB.

On Apple-silicon macOS, every subprocess runs under `sandbox-exec` with network
and filesystem writes denied; Mach service lookups and Apple Events are also
denied to prevent delegated requests. `/dev/null` is the sole discard-device exception.
The preflight fails closed if that sandbox is unavailable, including environments
that prohibit nested sandboxes. Subprocess environments are allowlisted, Git
fsmonitor/hooks are disabled, Go uses the offline build environment, subprocesses
have a 15-second timeout, and the CLI has a two-minute deadline (a synchronous
subprocess can take up to its own timeout to exit). It does not query Apple,
Chrome, DNS, the update host, provider services or the operator's Keychain. It
does not compile, sign a release, submit, publish, install or modify inputs.

The `pap-release-preflight/1` report is under 2 KiB and contains only the validated
channel, fixed check/status/failure codes, and successful source/dependency
digests. It stops at the first rejected check and marks later checks `NOT_RUN`.
It excludes paths, filenames, private keys, profile contents, reviewer names,
signing/notary identities, credentials, evidence, vault/account identifiers,
environment values and raw subprocess errors. Preserve a report alongside the
exact reviewed inputs; it is a local snapshot, not release authorization.

Helper inspection validates the embedded CMS signature and typed profile
structure offline, including expiry, team, fixed helper app/group and all-device
distribution. Certificate trust/revocation, signing-identity availability,
notarization credentials, module-cache integrity/compilation, Store publication
and installed behavior remain build/release gates. The signed builder retains
its Apple profile decoding and signing checks. A synthetic self-signed profile
can exercise local preflight without establishing Apple trust.

`npm run test:distribution` covers the shared release contracts and preflight
regressions using fresh temporary Git repositories, synthetic toolchains,
generated test keys and CMS profiles. Tests do not use operator release configs,
Apple credentials, an existing module cache or a browser/profile.

### Offline artifact policy verification

From a trusted reviewed checkout, inspect the **complete prepared output
directory** with a separate public expectation file:

```sh
npm run --silent verify:distribution -- /absolute/prepared-output /absolute/public-artifact-policy.json
```

For an environment without inherited Node options or package-manager hooks:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin /absolute/trusted-node/bin/node \
  spikes/distribution/verify-artifacts.mjs /absolute/prepared-output /absolute/public-artifact-policy.json
```

The command writes one bounded JSON report to stdout; exit status 0 means the
artifact policy passed, and 1 means rejection. It reads local regular files only,
does not execute/import bundled code, and does not mount a disk image, install,
access Keychain or production state, or contact any service. Use canonical paths
without symlinked ancestors. The expectation file is public JSON, **not** an
operator release config, approval file or private key. An RC example is:

```json
{
  "releaseChannel": "release-candidate",
  "sourceDigest": "REPLACE_WITH_THE_64_HEX_DIGEST_OF_THE_REVIEWED_SOURCE",
  "sequence": 4,
  "version": "1.2.0",
  "teamId": "REPLACE_WITH_YOUR_TEN_CHARACTER_TEAM_ID",
  "updateOrigin": "https://updates.example.invalid",
  "updatePublicKey": "REPLACE_WITH_YOUR_43_CHARACTER_ED25519_PUBLIC_JWK_X"
}
```

Use the intended channel, version/sequence, team, origin and public root from the
reviewed release inputs. Obtain `sourceDigest` from the successful preflight for
those exact reviewed inputs, or calculate it directly from that checkout:

```sh
node --input-type=module -e 'import { sourceInventory } from "./spikes/distribution/inventory.mjs"; console.log((await sourceInventory(process.cwd())).sha256)'
```

Do not copy expectations from an untrusted package: an attacker can rewrite
unsigned metadata and its hashes together. For production, change
`releaseChannel` to `production` and specify the intended production values. For
development, supply exactly `releaseChannel: "development"` and `sourceDigest`;
omit the signed-release fields. Older prepare outputs without bundle inventories
fail closed and must be rebuilt.

The verifier checks these independent relationships:

- Channel/class, signing/notarization **claims**, measurements and file policy
  agree. RC has matching outer/bundled candidate metadata, a null installed-release
  marker, disabled updates, candidate Finder labels and guides, and no stable
  manifest. Its version and sequence must match expectations. Development cannot
  inherit either release channel. Production requires the installed production
  contract and a current Ed25519-signed stable manifest under the expected root.
- The source inventory matches the expected source digest; dependency inventory,
  complete bundle inventories, copied source and notices agree. Runtime/updater
  source is tied to that same reviewed digest, so a null marker alone cannot
  establish disabled updates. Production also authenticates the provenance and
  dependency digests and the exact disk-image hash/size; RC checks its measured
  disk-image hash/size. The recorded Go build plan and input-tree digests are
  checked without requiring the compiler, module cache or approval source file.
- Bundle/helper IDs, versions and executable paths retain the fixed identities.
  The keyed extension derives the pinned Store ID, native messaging allows only
  that origin, and the upload ZIP contains the same extension bytes with only
  the manifest's development key removed. Store packaging omits resource forks,
  extended attributes, quarantine and ACL metadata. Archive inspection occurs in memory.
- Extra channel files, stale staging, unsupported paths, links, hard links,
  special files, duplicate JSON/plist fields and ambiguous ZIP entries reject.
  Known private-key/credential filenames, PEM and DER private keys, private JWKs,
  token data and approval source JSON reject even under renamed files; compressed
  Store ZIP contents receive the same checks. The complete directory is checked
  again before success to catch changes during inspection.

`pap-artifact-policy-verification/1` reports contain only fixed check/failure
codes, the validated channel and successful public digests. A failure clears
digests/update status, marks later checks `NOT_RUN`, and never prints input paths,
secret contents or raw errors. Inspection is bounded to 50,000 filesystem entries,
32 directory levels, 1 GiB per file, 6 GiB total, 256 MiB retained small-file data,
16 MiB per JSON/Store ZIP and 256 ZIP entries. The CLI has a two-minute deadline.

A passing report is **not release approval**. It always reports
`releaseReady: false`, `appleTrust: "NOT_CHECKED"` and
`diskImageContents: "NOT_INSPECTED"`. Disk images are opaque hashed files here:
their internal payload and its correspondence to the adjacent bundles require a
separate inspection. Arbitrarily encoded secrets and filesystem extended
attributes are outside this scanner. Apple signing/notarization, provisioning
trust/expiry, current independent security/license approval, Store publication
and installed behavior remain separate release gates. Synthetic fixtures can
pass the artifact policy without possessing Apple signatures.

`npm run test:distribution` includes valid and tampered synthetic outputs for all
three channels, a real `ditto` Store ZIP check, and a macOS check with filesystem
writes, network, Mach lookups and Apple Events denied. The broader Node suite also
checks a newly prepared ad-hoc app against a source digest captured before its
build. All test state and generated keys stay in fresh test-only temporary
directories; no operator release input, installed state or external account is
used.

### Pre-publication release candidates

The candidate disk image is named `Attestamp-Release-Candidate-VERSION-SEQUENCE.dmg`.
Finder displays **Attestamp Release Candidate** and **Attestamp Verifier Release
Candidate** for its two apps. Their bundle directories remain `Attestamp.app` and
`Attestamp Verifier.app`.

Use `releaseChannel: "release-candidate"` with `storeListingVerified: false` to
create a Developer ID signed and notarized reviewer artifact before the Web Store
listing can be published. The candidate UI, provenance, filename and install
guide identify it as non-production; its updater is disabled and it cannot supply
the production `installed-release.json` state. Its lifecycle history and rollback
floor are stored separately from production, so reviewer restarts and integration
checks cannot advance production state. There is no in-place promotion:
after the listing is published and the installed boundary is validated, create a
fresh build from a `releaseChannel: "production"` config with
`storeListingVerified: true`.

## Consumer names and compatibility identifiers

Attestamp is the consumer name used by the desktop app, local composer, verifier,
extension and install/remove guidance. The demonstrator is named Attestamp Demo.
Display names and candidate filenames do not authorize changes to the technical
identities below. Any migration of these values needs separate compatibility and
trust review; branding alone must not orphan evidence, change authority or break
an existing registration/update contract.

| Retained technical identifier | Why it stays unchanged |
| --- | --- |
| `ai.provenance.*` bundle, executable-signing and native-messaging identifiers | Native launch and process-ancestry checks pin these identities. |
| `TEAMID.ai.provenance.evidence-vault`, `ai.provenance.evidence-vault` and `ai.provenance.keychain-helper` | Existing Keychain access group, service and provisioned helper identity. |
| `Library/Application Support/Private Provenance` | Existing vault, app lock, installation state and browser rendezvous location; renaming it would disconnect local history. |
| `Helpers/Private Provenance Keychain.app` | Fixed helper path checked by the native launcher; its visible bundle name is Attestamp Keychain. |
| `Private Provenance fixed-purpose ChatGPT bridge` | Native-host manifest description is included in exact registration ownership comparisons. Changing it would turn existing registrations into conflicts. |
| `medilhopfckldjgdnchfkpmfmfnkadca` and the extension manifest public key | Pinned Chrome Store identity and allowed extension origin. |
| `pap-*`, `PAP_*` and `PAP/…` identifiers, schema/profile names and hash domains | Portable evidence, bridge, release, installation and cryptographic compatibility contracts. |
| `Private-Provenance-VERSION-SEQUENCE.dmg` and `PrivateProvenance-Updater/1` | Production signed-update artifact naming policy and fixed transport identifier. Candidate filenames are separate and use Attestamp. |
| `private-provenance-notary` | Reserved operator credential-profile name; it is not an app display name. |
| `Private Provenance Test` | Existing designated Chrome test-profile identifier; these instructions do not rename or access that profile. |
| `private-provenance-spikes`, repository paths and `provenance-*` executable/export filenames | Internal package and file contracts retained independently of consumer display names. |

Update origins/keys, Apple/Google signing requirements, anchor trust roots and
provider/adapter contracts also remain unchanged. The regression fixture in
`test/fixtures/desktop-identities.json` pins technical identities independently
from visible branding. Local packaging and browser tests use temporary resources;
they do not satisfy signing, store publication or installed-provider release gates.

## Provisioning still required

1. Enroll the distributing organization in Apple Developer Program. In its
   Certificates, Identifiers & Profiles area, issue/import a **Developer ID
   Application** certificate with its private key on the release Mac. Record its
   displayed identity and ten-character Team ID. Verify it appears as valid in
   `security find-identity -v -p codesigning`. Neither currently exists here.
2. Register `ai.provenance.keychain-helper` for that team and configure its
   Keychain sharing entitlement for `TEAMID.ai.provenance.evidence-vault`. Create
   a **Developer ID** provisioning profile authorizing that exact helper app ID
   and group, and download it outside VCS. The builder checks the team, app ID,
   group, expiration and all-device distribution before embedding it in the
   helper bundle. If the App Identifier Prefix differs from the Team ID, stop:
   the current fixed group policy needs a separately reviewed configuration change.
3. Store notarization credentials in the release operator's Keychain under
   **private-provenance-notary** using Xcode/notarytool's credential setup. Supply
   the profile name, never an Apple password or API private key in repository
   configuration. The profile name is reserved; credentials have not been
   validated. Submission sends only the built public artifacts to Apple.
4. Create the Chrome Web Store developer account and upload
   `Chrome-Web-Store-upload.zip` as a draft. The package is the consumer-facing
   **Attestamp for ChatGPT** extension and intentionally has no `key`, so the Web
   Store can assign the listing identity. The assigned draft
   Item ID is `medilhopfckldjgdnchfkpmfmfnkadca`, and its public key is pinned in
   the keyed development manifest. The package must retain only `nativeMessaging`
   and `https://chatgpt.com/*`, with the declared icon assets; a successful upload
   is not identity approval.
5. Under review, compare the assigned identity with the intended release. The
   keyed development manifest, native-messaging allowed origin, adapter extension
   ID constants and current/previous compatibility fixtures are now pinned to that
   assigned identity. Run the relevant regression suite and record the Item
   ID/public-key match. Do not replace the upload package with the keyed development
   package, and do not leave a stale identity in any pinned check.
6. Complete the listing, privacy disclosures, permission justification and store
   review. Set `storeListingVerified` true only after the listing is published and
   installation succeeds with the reviewed identity, then perform a fresh
   `releaseChannel: "production"` build. A candidate, draft creation or upload
   success alone must never set it.
7. Provision an HTTPS update origin you control. Reserve `/desktop/stable.json`
   and `/desktop/Private-Provenance-VERSION-SEQUENCE.dmg`; redirects, credentials,
   query strings and compressed transfer representations are rejected. Generate
   an Ed25519 release-signing key outside VCS, owner-readable only (mode 0600),
   and record the public JWK `x` value. Keep an offline recovery copy under the
   operator's control. Rotating this root requires a separately reviewed trust
   transition; an unsigned server response cannot rotate it.
8. Supply an absolute Go executable and explicit pre-populated module cache.
   Generate the approval inventory with `npm run build:distribution -- --inventory
   /absolute/go /absolute/new-dependency-inventory.json`; this prints its digest
   and includes the complete extracted GOROOT plus the local Go input tree and
   shipping build plan. Use the extracted toolchain's direct `bin/go` path;
   symlinks and special files are rejected. The prepare-only inventory has
   no Go compiler entry and cannot serve as signed-build approval.
   Review that `dependency-inventory.json` against the component notices
   and relevant advisories, including Node's embedded OpenSSL/V8/SQLite and the
   Go toolchain. Create an external approval JSON containing `inventoryDigest`
   (SHA-256 of the exact canonical inventory), `reviewer`, `securityApproved: true`,
   `licensesApproved: true`, and an ISO `expiresAt`. This file is an operator
   release assertion, not an independently cryptographic audit. A changed Node
   binary, Go source/import, build command/flag/environment, toolchain input,
   module pin, checksum file or bundled notice invalidates it. Every regular
   file under GOROOT is bound, including compiler/linker/asm/cgo, standard-library
   sources, headers, lib data and defaults. The local Go tree deliberately also
   includes ignored files and development binaries; regenerate approval after
   rebuilding or changing them. Module replacements are forbidden and ambient
   workspaces are disabled. Offline module-cache verification and inventory
   rechecks before/after compilation and after app notarization reject changed
   inputs before final build provenance and the disk image are produced. The inventory also binds the
   copied Node LICENSE and GOROOT LICENSE/PATENTS. Previous inventory-profile
   digests cannot authorize this build. No release security/license approval is
   currently supplied. Falcon's
   module-wide MIT notice and deterministic-mode attribution are retained in
   `THIRD_PARTY_NOTICES.md`, alongside the supplemental V8 and Go runtime notices.
   The selected release baseline is Node v24.21.0 and Go 1.27.1; see
   `DEPENDENCIES.md` for current advisory findings, including x/crypto packages
   that are absent from the shipping tools. Invoke the selected Node binary and
   absolute Go executable explicitly, regenerate the inventory, and complete
   independent security/license review before asserting approval.
9. Complete the signed installed checks below in **Private Provenance Test**
   (the existing test-profile identifier retained as described below),
   using a specifically designated ChatGPT test account and synthetic text only.
   No live test has been run, and no existing conversations may be inspected.
   Do not reuse a default Chrome profile. Provision the account if that dedicated
   profile does not already have an approved test account.

## Installed technical validation

Automated checks: `npm test` covers signed metadata/download failure cases,
owner-only registration/removal, rollback gates, migration process termination,
native build seals, offline proofs and the existing core regressions.
`npm run test:distribution-browser` exercises the setup/removal and support-download
UI in a fresh headless profile using only synthetic loopback services. It does
not access `Private Provenance Test` or claim a store/OS/provider result.

Use the actual signed artifact and store extension on a clean test macOS user.
Cover the latest supported security-patched macOS 15.x and the current supported
macOS major on Apple silicon. Revalidate the then-current Chrome Stable; the
repository's pinned synthetic baseline is 153, not a claim about today's Stable.
Capture only content-free counts/durations and public version/build identities.
Record unexecuted checks as null, not zero or passed.

| Boundary | Required measurement/evidence |
| --- | --- |
| Installation | Finder copy/first-open steps, macOS permission prompts, Gatekeeper acceptance, no terminal setup |
| Store install | Actual listing/key match, permission prompt count, no unrelated-site/incognito access |
| Pairing | Time from explicit Enable to authenticated native pair, then successful local synthetic release |
| Restart | App and Chrome restarts; new pair/enrollment; old authorization unusable |
| Updates | Actual current/previous signed artifacts; tampered download/signature rejection; no unauthorized rollback |
| Migration | Known pre-upgrade export matches after interrupted migration and reopen; no restored send authority |
| Removal | Export opportunity, manifest removal, extension/app removal, evidence retained, verifier usable offline |
| Provider drift | Missing/changed composer/send controls, attachments, tab ambiguity and revoked permissions remove eligibility |

The diagnostic JSON records application action counts, while external OS/store
permission measurements remain null until these checks are performed. The
previous-browser fixture (152) and previous extension contract are deliberately
unsupported. The first release has no previously supported shipping artifact;
provide one before claiming a tested current/previous shipping matrix. Synthetic
legacy vault-reader fixtures cover versions 1 and 3 and preserve exact exports.

## Update and recovery behavior

Updates are user-initiated, verified disk-image downloads followed by Finder
replacement after quitting. There is no silent automatic replacement. A fixed
HTTPS origin receives the connection IP, standard transport metadata and a
constant updater user agent; there are no account tokens, evidence digests, paths,
filenames, vault IDs or telemetry payloads in requests. Time-based manifest expiry
uses the local clock and is freshness hygiene, not proof time. Managed anchoring
availability does not govern local update/export/verification.

The production native host holds a kernel lifetime lock shared with its runtime
child, so another app version cannot change the sequence or vault while an older
runtime remains active, including after host termination.
The installation state keeps an installed sequence and highest authenticated
update sequence. A failed or interrupted download never opens partial bytes,
never migrates the vault, and does not raise the installed sequence. Restart may
retry explicitly. App launch rejects an older installed sequence before opening
the vault. The vault also rejects missing, inconsistent or newer compatibility
metadata, and additive migrations commit atomically. Repair old behavior in a
new, signed sequence that can read the existing schema. Never restore an older
database, reset sequence metadata or resurrect signing/dispatch state to roll back
an app. Existing experimental binaries predate this distribution guard and are
not supported rollback targets. These checks assume the local OS and owner-only
state remain trustworthy; they do not resist an owner maliciously rewriting both
an old binary and all local state.

## Support and provider maintenance

Start with the locally saved support JSON. It allowlists status codes and bounded
action counts; arbitrary error text, DOM content, URLs, evidence IDs, raw hashes,
credentials and paths are excluded. It is never uploaded automatically. Do not
ask for a vault, browser profile, recovery secret, environment dump or raw crash
log. The user can continue to export and verify existing evidence independently.

On connection conflict, leave the existing manifest untouched. On unsupported
provider/browser state, leave protection disabled. Reproduce with synthetic
markup in a temporary profile, update the pinned adapter contract and fixtures,
then perform the real installed check before publishing a compatible signed
release/store update. Mutation/input notifications carry only a fixed drift
message; the authenticated runtime rechecks the state and revokes enrollment.
Selector compatibility remains a bounded client observation, not proof of
provider behavior or receipt. No unsigned remote selector/config update may
enable protection.

On migration failure, close the app and retain the vault plus its WAL. Use a
compatible signed repair build or owner-controlled recovery/export; never
delete evidence or keys to make an installation check pass. On an unknown send
outcome, ask the user to inspect only the synthetic test conversation during
validation; the app must never automatically resend.

Technical references: [Apple distribution notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[Apple provisioning profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles),
[macOS Keychain implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains),
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
and [Chrome host-scoped tab access](https://developer.chrome.com/docs/extensions/reference/api/tabs).
