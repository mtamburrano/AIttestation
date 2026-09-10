# Local demonstrator walkthrough

Use synthetic text and small synthetic attachments only. Supported path: macOS
13 or later, Google Chrome, this trusted local composer and its paired loopback
synthetic provider. No real provider, browser extension or external account is
connected. This is a disposable experiment, not a production protection product.

## Open without a terminal

1. Receive the developer-prepared folder for your Mac's architecture. Keep
   `Private Provenance Demo.app` intact; drag it to a chosen local folder.
2. Ensure Google Chrome is installed. Double-click the app. It opens the composer
   in a fresh isolated Chrome profile. Your usual tabs, extensions, login and
   keychain are not used. No Node installation, command, wallet or seed phrase is required.
3. This build has only an **ad-hoc local signature**, no Developer ID notarization
   and no App Store distribution. A downloaded copy may be blocked by Gatekeeper.
   Follow your Mac's normal approval process only if you trust the developer and
   this exact build. Do not disable Gatekeeper. If organizational policy prevents
   opening it, stop and record that limitation; a signed/notarized build is needed.
4. Record elapsed time from double-click to the composer, any OS approval prompts
   and any failed step. Automated launch/build measurements do not establish this
   human installation result.

The app uses two random loopback ports and fresh temporary encrypted storage.
It starts a separate local runtime. Use **Close local runtime** after saving
recovery; it also closes the isolated Chrome process. Closing that process likewise
stops the runtime. Keys live only in process memory.
Reopening always creates a fresh session. An interrupted session is recoverable
only to a previously exported snapshot, with its separate recovery secret.

## Rehearse the complete local flow

1. Choose **Offline rehearsal** and explicitly enroll this composer session. Its
   synthetic log signature is cryptographically checked but supplies **no public
   chain consensus or UTC timestamp assurance**.
2. Select **Sealed**, enter a new synthetic draft and choose a small binary file.
   Freeze it. The receipt says `PENDING_ANCHOR`; the provider sees nothing.
3. Validate confirmation. Observe `SEALED_NOT_SENT`. Edit the draft to demonstrate
   that it requires a new freeze and confirmation. Release the confirmed version.
   The separate provider frame displays a synthetic response; its exact DOM
   `textContent` is captured locally. Submission observation is not provider receipt.
4. Select **Continuous**, change the draft, and freeze. The app immediately
   records a release attempt and sends before anchoring. Validate confirmation
   afterward. Observe the pending anchor separately from submission status.
5. Select **Always Protect**, change the draft and uncheck the supported path.
   Freeze is rejected. Re-enable the path and freeze: rehearsal confirmation and
   exact-version release run automatically in the explicitly enrolled scope.
6. Save the evidence export. It contains plaintext; disclose it deliberately.
   Save the session trust configuration separately. For the fixture, selecting
   that key is an explicit test trust assumption, not independent public trust.
7. Create an encrypted recovery snapshot and save its separate recovery secret.
   Keep the pair associated but stored separately. A later snapshot has a new key.
8. Close the runtime, reopen the app, and select that package and secret in the
   recovery section. Restore creates a new vault under fresh local keys, checks
   the declared snapshot, preserves historical signatures, and restores **no send
   authorization**. Missing/wrong secrets fail. Latest state remains unproven.
   Use **Save restored evidence** to retain the recovered bytes and proof references;
   the disposable restore destination is closed after verification.
9. Select the original evidence export and separately selected trust file under
   verification. Read evidence integrity, key attribution, record inclusion,
   anchor and timestamp results separately. Unanchored records inherit no assurance
   from anchored ones. Export/verification require no payment or company service.

## Real Algorand confirmation

The default policy fails closed until a complete **new** Algorand proof matches
the frozen signed descriptor and the independently selected checkpoint. Reusing
the repository's archived transaction for a new version is rejected.

A developer must obtain explicit authorization for a bounded dedicated TestNet
run before submission. Select its independent checkpoint configuration before
enrollment and submission. Freeze the new draft, save its 36-byte blinded anchor
request, and give only that request to the authorized developer. The provider
receives no protected bytes while proof collection remains pending. Import the
resulting `pap-anchor-envelope/1` archive. The native verifier must return both
`CONSENSUS_VERIFIED` and `BLOCK_HASH_BOUND` before Sealed can release. Always Protect
automatically releases after successful import only if the current draft still
matches. Continuous can be confirmed after its release.

The app does not submit transactions, load account credentials or select trust
roots from a proof. Pending archive acquisition may be slow. The recorded old
TestNet experiment is evidence for the adapter, not for these new drafts.

## Record the owner walkthrough

Record build/CPU architecture, macOS/Chrome versions, launch and installation time,
OS prompts, successful modes, changed-version rejection, unsupported-path result,
export/restore time, and whether claim wording was understood. Record actual chain
confirmation/archive times only for an authorized live run. Keep unavailable
measurements empty; rehearsal timings cannot substitute for chain measurements.
