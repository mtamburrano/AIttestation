# Free local receipts and recipient verification

The local dashboard includes retained receipt history, explicit receipt selection,
an evidence-byte toggle, a disclosure preview and a local download. Saving uses the
exact immutable preview; subsequent activity cannot silently broaden the export.
The preview lists all signed records, evidence object lengths, shared proof counts,
source relationships and up to 4096 bytes of each selected text. Signed metadata
includes public keys, local times and record links even when evidence is withheld.

Redaction creates new signed bytes with an explicit `redacted_from` relationship.
The original remains immutable. Exporting the derivative does not include source
bytes or inherit the original's anchor/release assurance. The relationship is a
key assertion; the verifier does not claim the replacement is a proven substring
or transformation of withheld content.

Historical `release-cancelled` observations retain their frozen version ID and record
digest. Receipt history and selective exports include that original signed record
only with the matching signed frozen observation, mode and signing key. The
recipient displays it as `CLIENT_ASSERTION_ONLY`, with provider non-egress
`NOT_PROVEN` and release control `UNKNOWN`. It adds no authorship, event-truth,
timestamp or anchor assurance, and cannot establish the latest state or recall a
transaction that was already submitted. Missing observation bytes produce no
cancellation assertion; no evidence is inferred from omitted records.

Legacy cancellations without a reliable digest link remain immutable. History
lists each as **Unassociated cancellation**, selectable on its own for export.
Unknown targets, incompatible modes and mismatched signing keys cannot attach a
cancellation to a prompt. Neither timestamps, record order, matching text nor a
version ID alone supply the missing association. Recipient verification reports
unassociated cancellations on their own signed records, and a selected prompt
without its cancellation makes no cancellation claim. Recovery preserves these
records and classifications; no migration rewrites or re-signs historical evidence.

## Recipient use

The consumer build includes a separate **Attestamp Verifier.app** in its
Recipient folder. Copy that folder to a clean Mac, open the app, select the export,
and optionally select a checkpoint obtained through a separately trusted channel.
There is no account, subscription, vault, signing key, wallet or company endpoint.
The app uses a local loopback page and a bundled Node/native verifier. Its fixed
native launcher validates the bundle before running its sole entrypoint and has
no Keychain broker. Current developer builds are ad-hoc signed; Developer ID signing
and notarization remain distribution requirements before consumer release.

Developers can build it separately with `npm run build:verifier -- NEW_DIRECTORY`
after building the pinned Algorand native verifier, or use
`npm run verify:evidence -- export.json independently-selected-trust.json`.
The macOS builder requires a self-contained Node runtime (such as the installed
Node 22 release binary) and rejects dependencies on external non-system dylibs.
This prevents a copied app from silently depending on Homebrew on the recipient's Mac.
Omit the trust file to inspect local evidence with indeterminate anchor assurance.
CLI exit code 1 means input/runtime rejection, 2 means one or more dimensions are
incomplete, unsupported, invalid or lack full archived assurance, and 0 means all
selected records have valid local evidence and full supported archived assurance.
Always inspect individual dimensions; no exit code proves event truth or authorship.

The selected trust JSON has the existing `profile`, `network`, `genesis` and
`checkpoint` fields. The checkpoint authenticity is an explicit recipient
assumption. The verifier does not bootstrap from genesis or contact a service to
choose roots. Exported trust fields in older demonstrator files are ignored.

## Format and assurance

`pap-portable-evidence/1` is canonical JSON containing `disclosure`, `anchors` and
`publicProofObjects`. The disclosure retains signed records and deduplicated exact
evidence bytes. Each anchor has the network-neutral envelope fields with
`proofDigest` replacing `proof`. Each public proof occurs once as canonical bytes
in the existing canonical base64url chunk encoding. Its address is
SHA-256(`PAP/public-proof/v1\0` || bytes). Record-specific Merkle paths stay in
references. Verification caches only matching profile, network, root and proof
addresses after checking every record's own inclusion path.

Locally, archive bodies are separate encrypted vault objects reused by content
address. Small signed observations reference them; recovery retains those same
objects and references. Fast confirmation bodies are also stored separately.
Their signed historical reports remain client assertions for recipients; they do
not independently establish that the two operators were observed. Later archived
State-Proof verification under selected trust can establish consensus inclusion
and separately bind the full-header timestamp. It never rewrites prior release
authorization or upgrades the assurance used at release time.

New `pap-local-record/2` uses LOCAL_RECORD and local_evidence_store labels with
the existing commitment/signature domains. Text capture, signed observation,
public-proof and derivative types remain. Derivatives carry exactly one
`redacted_from` relationship with source record/object digests.

The reader retains `pap-local-record/1`, `pap-poc/1`, old disclosure and
demonstrator exports. Their signed bytes, IDs, modes and assurance are not
rewritten. Ordinary captures cannot become control assertions by containing JSON.
`legacy-observation.mjs` is the closed normal observation/2 reader; `portable.mjs`
interprets historical observation/1 assertions without signer, network submission
or writable journal authority. Old readers reject new profiles as unsupported.

Reports separate structure, integrity, key attribution, evidence availability,
anchor assurance, timestamp assurance and release control. Missing evidence is
incomplete; missing proof/checkpoints are indeterminate; unsupported profiles
cannot pass. Cryptographic mismatches invalidate the affected dimension. Multiple
conflicting anchor results remain visible and aggregate to indeterminate.
Selection never proves global completeness or latest state. Release-control
results describe signed client assertions, not independent evidence of egress.

New ChatGPT transport observations use `pap-chatgpt-observation/5`:
`normal-request-observed` binds the decoded new user text and authenticated source
under `chatgpt-new-user-text/2`, with `inputMethod: "provider-request"`. It makes
no claim that a trusted click or Enter occurred. `normal-acknowledgement` separately binds an early
client-observed handoff or inline start to the same descriptor digest, event,
source and signing key. The verifier reports `OBSERVED_ONLY`, explicit transport
coverage and unknown provider receipt. Neither HTTP status nor acknowledgement
proves provider receipt or authorship. Missing ack never erases saved evidence.
Historical observation/4 retains its human-qualified request meaning through
`qualified-observation.mjs`. Historical observation/3 stays DOM intent/appearance through `dom-observation.mjs`;
observation/2 and /1 retain their original meanings and immutable signed bytes.
All legacy readers lack recording/Send authority. See the
[capture contract](../browser/chatgpt/RECORDING.md).

## Hostile input limits and offline behavior

Imports are at most 16 MiB, with 128 records, 128 evidence objects, 128 anchor
references, 8 shared public proof objects and 12 MiB combined decoded bytes. One
proof is at most 8 MiB; independent trust is at most 64 KiB. JSON depth is capped
at 32 and duplicate names are rejected, including escaped duplicates. Encoded
chunks, exact schemas, digests, duplicate references and unselected objects are
checked. At most 8 distinct native validations execute, each capped at 5 seconds
and 64 KiB output. The graphical app isolates each verification in a 256 MiB V8
heap process with a 30-second deadline and bounded output; only one import runs
at once. These are processing limits, not promises of constant memory usage.

No archives are extracted, paths followed from metadata, URLs fetched or evidence
rendered as HTML. UI output uses text nodes under a restrictive same-origin CSP.
All browser traffic is to the local verifier. The native verifier consumes stdin
and performs offline proof validation only. Tests use fresh temporary vaults,
memory-only keys, new browser profiles and recorded public TestNet archives.
