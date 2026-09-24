# Resident ON/OFF engine

One resident engine owns global recording consent, source-bound capture,
encrypted evidence, anchoring and history. Closing the sidebar or dashboard
does not stop it. Explicit app exit revokes new capture and drains active work.

## Versioned controls

`POST /engine/state` returns `pap-resident-event/2`: runtime epoch, adapter
profile, revision, recording preference, migration reason, validated capabilities,
current sources and recent saved observations. `POST /engine/command` admits
only `pap-resident-command/2` with these exact fields:

| Field | Value |
| --- | --- |
| profile | pap-resident-command/2 |
| runtimeEpoch | Current engine UUID |
| adapterProfile | pap-chatgpt-chrome/9 |
| commandId | Fresh UUID, retained for identical transport retry |
| expectedRevision | Displayed nonnegative integer revision |
| kind | SET_RECORDING |
| enabled | Boolean |

The HTTP server supplies the trusted origin after exact Host/Origin/bearer checks.
Desktop and extension-sidebar controls have their own authenticated transports.
A content script cannot issue controls; a sidebar cannot submit text observations.
Unknown fields, old profiles/epochs, stale revisions and conflicting command-ID
reuse reject. An identical command retry returns its original acknowledgement.
At most 4,096 commands are retained per engine lifetime; a new epoch clears them.

There are no manual enrollment, per-conversation preference, prompt admission,
freeze, release, cancellation or provider-retry APIs. Old commands and endpoints
reject. The adapter automatically establishes current sources across up to 32
supported tabs/windows; source identity is not consent.

## Ordered OFF cutoff

Capture and preference changes share one serial queue. A capture must match the
current runtime, browser session, tab/window/document, destination and policy
token when it reaches that queue. OFF clears all current tokens and publishes
revocation before acknowledging its durable preference write. Later ON generates
new tokens. A stale delivery cannot revive across OFF/ON, replacement documents,
disconnect or restart. Already-admitted events may settle across same-document
navigation with their original source: the worker must challenge the exact
isolated document's pending event, and the engine checks the retired token against
the current tab/window/epoch and consent. Retired authority is bounded and grants
no new admission on the old route.

A save acknowledgement follows the encrypted signed text and observation writes.
The normal path also finishes its engine metadata commit. If that metadata write
fails after the evidence commits, the engine disables new capture while the exact
event's local receipt remains saved. A failed or lost response alone is never a
terminal recording gap. The page shows **Save confirmation pending · Check
History** until an exact receipt confirms the save or a proven local rejection
establishes a gap.

The relay dispatches each payload once, then reconciles using only its immutable
event ID. The authenticated native receipt query also binds the original source,
including the exact document, tab, window and browser session. Queries cannot
capture evidence, restore consent or send provider input. `POST /capture/receipt`
accepts `{eventId}` on the authenticated local dashboard and returns
`PROMPT_SAVED` with its receipt ID, or non-terminal `SAVE_PENDING`. Absence is
not a rejection. Signed deduplication associations retain additional event IDs
for the same stable provider message across restarts without copying its evidence
or inventing a link from text, time or order.

The native handshake advertises `pap-chatgpt-capture-receipt/1`. A worker paired
with an older engine retains pending status and late-reply handling without
sending it an unsupported receipt query.

The worker retains up to 512 content-free receipt bindings and bounded late reply
correlations. Each document keeps at most 16 pending event views; polling uses
read-only receipt requests. Expiry or eviction never changes uncertainty into a
failure. A late exact success updates its receipt and the still-current event's
feedback. OFF, a replacement document, page exit or a newer Send cannot be
overwritten by an earlier event's feedback; durable receipt lookup remains separate.
A capture durably accepted before OFF remains evidence. Workers stop taking text
snapshots once they receive OFF; stale in-flight buffers cannot become new evidence
after the engine cutoff. A failed preference write also disables capture until
restart. No provider action waits on storage, IPC, account or anchoring.

The engine keeps at most 512 queued/active/scheduled anchor jobs and runs at most two at a
time. A full anchor queue leaves new durable evidence saved with PENDING anchoring;
it does not reject capture. An insertion-order cursor fills freed slots from
durable history, considering each observation once per runtime. Metadata still
being saved is excluded. Temporary service/quota/credit or confirmation timeout failures schedule at most
two retries, after five and thirty seconds. The saved anchor identity and cumulative
attempt journal apply to every retry. Restart resumes pending history in a fresh
bounded batch, including observations whose earlier batch exhausted its retries;
invalid proof results, missing configuration and missing credentials do not
automatically retry. No job can replay a provider request.

Anchor batches yield to the event loop, including immediately rejected service
requests. Managed credentials use asynchronous, ordered exchanges over the same
app-bound Keychain broker; no credential cache bypasses subsequent Keychain lock
checks. Disconnect invalidates pending credential lookups before submission.
Synchronous vault custody operations fail closed if that broker is already busy,
so frames from the two paths cannot interleave.

Native fast and archival proof verification use asynchronous child processes in
the resident runtime, with the same independent proof validators and report
checks as offline verification. At most two verifiers run concurrently, with
empty child environments, bounded output and the existing 10-second fast and
30-second archival timeouts. Capacity exhaustion leaves fast confirmation
pending for the existing bounded retry policy. Captures and debug/control
requests do not wait for these child processes.

Each observation has at most three automatic submission/confirmation calls per
runtime, rather than a permanent abandonment limit. An authenticated explicit
`POST /managed/anchor` can retry a pending observation after service recovery.
Missing local configuration or account credentials consumes no attempt. The
cumulative attempt number is committed immediately before external work; remote
rejection and ambiguous outcomes still count and reopening never resets the count.
Managed service reservations retain the same account/payload identity and their
three-broadcast lifetime cap. A known transaction is only reconciled, including
without account credentials. OFF permits bounded anchor work to finish; account
disconnect separately removes service access. Pre-ON/OFF observation/2 is read-only and never enters this queue; historical
ON/OFF observation/3 and /4 retain their bounded pending anchor workflow.

## Persistence and migration

The encrypted `pap-resident-state/2` snapshot contains only revision, recording
and migration reason. `engine-pointer` publishes the vault record ID after a
durable write, atomic rename and directory fsync. Interrupted migration can leave
an unreferenced snapshot; retry deterministically migrates the original pointer.
No old journal, grant, attempt or provider action is executed.

Startup loads and migrates the pointed state without appending a new snapshot;
the new runtime epoch invalidates prior commands and source tokens. The current
vault guardrail permits 512 signed records, including internal state and anchor
records. Fewer than two free slots makes new prompt capture unavailable because
both exact text and its signed observation must fit. A fixed
`VAULT_CAPACITY_EXHAUSTED` code distinguishes this condition from parser limits,
disk errors and uncertain saves. Capture checks the pair before writing text.
The engine remains available for History, selective export, independent verifier
access and encrypted recovery; automatic anchor work is suspended. A capture
whose text and descriptor filled the last slots still has an exact saved receipt,
even though there is no room for an additional engine snapshot.

At capacity, OFF atomically writes and fsyncs an owner-only
`engine-recording-off` revocation latch outside the signed evidence inventory.
The latch can only force OFF. Explicit ON must persist its signed state and pointer
before removing and fsyncing the latch. An interruption before latch removal
preserves OFF on restart. No retained evidence is deleted or rewritten to reclaim space.
Restoring a full recovery snapshot preserves the capacity condition. An earlier
checkpoint with space is writable after explicit ON, but does not represent newer
history; the full retained vault and its recovery snapshot must remain preserved.

| Previous state | New preference |
| --- | --- |
| No pointer, including a restored recovery vault | OFF |
| Valid state/2 | Restore its explicit boolean |
| Valid state/1, unpaused global Continuous, empty conversation exceptions | ON |
| Off, paused, Sealed/Always Protect, any conversation exceptions | OFF |
| Unknown/future/malformed or uncertain state | OFF |

Migration is versioned and idempotent. Old history does not imply consent. A
restored recovery installation requires explicit ON; ordinary restart can retain
the already-consented new preference after fresh source/identity checks.
Migration preserves signed historical objects without rewriting their bytes.

Recent state lists the last 512 observation versions; the vault retains history.
Source policies, command acknowledgements and undelivered captures are not
restored. New signed records use `pap-local-record/2` and normal observations use
`pap-chatgpt-observation/6`. Stable provider message identities are indexed from
signed transport history so retries return the original receipt across restarts. Legacy schemas remain isolated read compatibility.
Native framing, bundle identities, cryptographic domains and portable export
formats retain their established identities.

The vault caches only a validated, decrypted index for its current SQLite
connection. Any external database commit, local index write, failed index commit,
key rotation, close or custody reopen invalidates the appropriate snapshot.
Writers use detached copies with the original optimistic conflict baseline;
nonce reservation and FULL synchronous commits are unchanged. Receipt summaries
cache verified observation groups by that opaque snapshot revision. Object reads
still authenticate ciphertext; explicit export and full verification still read
and verify the selected evidence or complete retained history.

The private development locator is `pap-private-runtime/2` with only
`dashboardURL`. After acquiring the resident lock, startup can replace an old
validated locator without contacting its obsolete endpoint.

## Validation

Engine tests cover migration tables, repeated/interrupted migration, recovered
OFF, command ordering/idempotency, stale capture, bounded anchor retries,
account failure, free export and singleton ownership. Page/worker tests cover
automatic sources and exact-byte capture. The full behavior matrix and actual
test results are in [MIGRATION.md](MIGRATION.md).
