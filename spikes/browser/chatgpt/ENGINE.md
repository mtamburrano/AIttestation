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
| adapterProfile | pap-chatgpt-chrome/7 |
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
new tokens. A stale delivery cannot revive across OFF/ON, navigation, disconnect
or restart.

A save acknowledgement follows the encrypted signed text and observation writes
and durable engine metadata. Storage uncertainty fails closed and reports a gap.
A capture durably accepted before OFF remains evidence. Workers stop taking text
snapshots once they receive OFF; stale in-flight buffers cannot become new evidence
after the engine cutoff. A failed preference write also disables capture until
restart. No provider action waits on storage, IPC, account or anchoring.

The engine keeps at most 512 queued/active anchor jobs and runs at most two at a
time. A full anchor queue leaves new durable evidence saved with PENDING anchoring;
it does not reject capture. An insertion-order cursor fills freed slots from
durable history, considering each observation once per runtime. Metadata still
being saved is excluded. Restart resumes eligible pending history without a retry
loop or a backlog of unobserved text.

Each observation has at most three persisted external submission/confirmation
attempts across restarts. Missing local configuration or account credentials
consumes no attempt. The attempt is committed immediately before an external
request; remote rejection and ambiguous outcomes still count. A saved transaction
is reused. OFF permits that bounded work to finish, but account disconnect
separately removes service access. Old observation profiles are read-only and
never enter this queue.

## Persistence and migration

The encrypted `pap-resident-state/2` snapshot contains only revision, recording
and migration reason. `engine-pointer` publishes the vault record ID after a
durable write, atomic rename and directory fsync. Interrupted migration can leave
an unreferenced snapshot; retry deterministically migrates the original pointer.
No old journal, grant, attempt or provider action is executed.

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
`pap-chatgpt-observation/4`. Legacy schemas remain isolated read compatibility.
Native framing, bundle identities, cryptographic domains and portable export
formats retain their established identities.

The private development locator is `pap-private-runtime/2` with only
`dashboardURL`. After acquiring the resident lock, startup can replace an old
validated locator without contacting its obsolete endpoint.

## Validation

Engine tests cover migration tables, repeated/interrupted migration, recovered
OFF, command ordering/idempotency, stale capture, bounded anchor retries,
account failure, free export and singleton ownership. Page/worker tests cover
automatic sources and exact-byte capture. The full behavior matrix and actual
test results are in [MIGRATION.md](MIGRATION.md).
