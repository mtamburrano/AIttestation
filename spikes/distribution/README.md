# macOS distribution and adapter maintenance

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
ad-hoc application, standalone verifier, uploadable **Attestamp for ChatGPT**
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

### Pre-publication release candidates

Use `releaseChannel: "release-candidate"` with `storeListingVerified: false` to
create a Developer ID signed and notarized reviewer artifact before the Web Store
listing can be published. The candidate UI, provenance, filename and install
guide identify it as non-production; its updater is disabled and it cannot supply
the production `installed-release.json` state. There is no in-place promotion:
after the listing is published and the installed boundary is validated, create a
fresh build from a `releaseChannel: "production"` config with
`storeListingVerified: true`.

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
   and includes the exact Go compiler identity. The prepare-only inventory has
   no Go compiler entry and cannot serve as signed-build approval.
   Review that `dependency-inventory.json` against the component notices
   and relevant advisories, including Node's embedded OpenSSL/V8/SQLite and the
   Go toolchain. Create an external approval JSON containing `inventoryDigest`
   (SHA-256 of the exact canonical inventory), `reviewer`, `securityApproved: true`,
   `licensesApproved: true`, and an ISO `expiresAt`. This file is an operator
   release assertion, not an independently cryptographic audit. A changed Node
   binary or module pin invalidates it. No release security/license approval is
   currently supplied. Resolve the Falcon wrapper/module-wide license coverage
   gap described in `DEPENDENCIES.md` before asserting license approval.
9. Complete the signed installed checks below in **Private Provenance Test**,
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
