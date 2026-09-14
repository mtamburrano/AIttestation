# Resident engine and independent scopes

The packaged runtime owns one `ResidentEngine`, protection session, encrypted
vault and authenticated browser connection. A SQLite exclusive lock in the
explicit support directory prevents a second engine from loading release state
or acquiring dispatch authority. The operating system releases the lock on crash.
Views can read or subscribe to state; detaching a subscriber or closing the
development page does not stop the engine. Explicit app exit drains interrupted
work and closes the bridge and vault.

## Contracts and admission

`POST /engine/state` returns `pap-resident-event/1`: current runtime epoch,
revision, preferences, validated capabilities, targets, enrolled scopes and
recent operations. `POST /engine/command` accepts `pap-resident-command/1`.
Both retain the product API's random bearer, exact Origin and Host checks.
The server supplies the trusted command origin; no request field can select it.
Content-script messages cannot invoke these commands. The internal surface
contract reserves desktop and privileged extension-panel origins for their own
authenticated integrations.

Each command has `profile`, `runtimeEpoch`, `adapterProfile`, a UUID `commandId`,
`expectedRevision`, `kind`, and exactly the fields listed below. Unknown fields,
old epochs, mismatched adapters and stale revisions are rejected.

| Kind | Additional fields | Behavior |
| --- | --- | --- |
| `ENROLL_SCOPE` | `target` | Enroll precisely the advertised adapter/session/tab/window/document/destination |
| `SET_PAUSE` | `paused` | Set the global override; pausing ends pending authority |
| `SET_DEFAULT` | `mode` | Set the integration default to Off, Continuous or Sealed |
| `SET_CONVERSATION_MODE` | `scope`, `mode` | Override the conversation, or use `null` to inherit |
| `PROTECT_AND_SEND` | `scope`, `operationId`, `text`, `editRevision` | Admit an immutable Sealed operation and run capture, sponsorship, confirmation and one dispatch in the engine |
| `CANCEL_OPERATION` | `operationId` | End future controlled release and retain evidence |
| `DEVELOPMENT_FREEZE` | `scope`, `operationId`, `text`, `editRevision`, `mode` | Run the historical development workflow using the same engine; accepted only from the development surface |

An enrollment target contains `adapterId: chrome-chatgpt`, `adapterEpoch` (the
current browser session), `tabId`, `windowId`, `tabEpoch`, and `destination`.
The caller copies an advertised target without its read-only `eligible` bit.
Every field must still match when admission executes. An existing enrollment of
the same current target returns its existing scope rather than another authority.

Retries reuse the entire command, including its UUID and expected revision.
Identical delivery returns the original acknowledgment even after state advances;
conflicting reuse rejects. A genuine second prompt has a new operation ID and
command ID, including when the exact text is unchanged. Byte storage can deduplicate
without merging the two signed prompt records. Acknowledgment means the operation
was durably admitted; its subsequent state indicates capture and release outcome.
No view must remain connected for those stages to finish.

A new cancellation command checks the operation, live version and durable release
journal before changing state or recording evidence. Stopped, cancelled or restored
operations and completed release attempts reject it. Replay of the identical
accepted command still returns its original acknowledgment without a write. Pending capture and
confirmation remain cancellable. Interrupting an active consumed attempt ends
future controlled release but retains its eventual observed, failed or unknown
outcome; it cannot claim that possible exposure was undone.

There are at most 32 current browser targets, 256 persistent conversation
preferences, 512 recent engine operations and 4,096 command deliveries per engine
lifetime. Finished recent operations may leave the engine summary while their
receipts remain in the vault. Delivery and operation IDs are not reused within
that lifetime; reaching the delivery limit requires a fresh engine epoch.
The text limit remains 256 KiB of exact, well-formed UTF-8 with no attachments.

## Policy, documents and interruption

Global pause takes precedence over conversation preferences, then the integration
default. The initial default is Sealed; it grants no enrollment or send by itself.
Changing the effective requested mode ends affected in-flight authority, even if
the mode later changes back. Off preserves history. A one-prompt Sealed command
uses strict admission even when the default is Continuous; it never downgrades
the pending operation to a retrospective send.

Duplicate tabs of an established conversation share its explicit preference but
have independent scope IDs, windows, document epochs, drafts and operations.
Before a new chat has a stable conversation identity, its override applies only
to that current scope and is not persisted or copied to other new-chat tabs.
Navigation never carries enrollment or a queued prompt to another conversation.
The worker changes the affected document epoch on navigation/reload; unrelated
tab lifecycle and focus notifications do not invalidate another healthy scope.
Dispatch still requires the pinned target to be active and supported, and the
content script must retain visibility throughout possible exposure.

Capability loss retains evidence and ends pending work without automatically
resuming it when the surface recovers. During an active consumed attempt, its
exact engine guard distinguishes its own authorized insertion from a lost
capability; this does not bypass destination, permissions or document checks.

The current adapter advertises strict text admission and no native-flow
Continuous observation. Requested Continuous therefore appears as effectively
unavailable. The development view explicitly retains historical Continuous
dispatch and Always Protect semantics. Normal ChatGPT Send observation, the
extension panel and resident Mac menu are separate integrations; these engine
contracts do not claim those interfaces are implemented.

## Persistence, recovery and compatibility

Preferences and recent operation metadata use `pap-resident-state/1` records in
the existing encrypted vault. `engine-pointer` contains only the current vault
event ID and is atomically published after the durable vault write. A state write
failure disables further engine authority until restart. Existing Keychain,
sponsorship, proof validation, release storage and recipient code are reused.

Restart clears unconsumed release authorizations and reconstructs operations from
the durable release journal. Incomplete operations become interrupted; consumed
attempts without a durable result become `OUTCOME_UNKNOWN`. No scope, queued send
or grant is restored. Old runtime commands reject, including commands whose reply
was lost. Receipts and already exported bundles retain their original claims.

The adapter advances to `pap-chatgpt-chrome/5`, extension 1.4.0, and dispatch to
`pap-chatgpt-release/2`, adding window and document correlation at both ends.
Earlier adapter contracts reject at pairing. Native peer identity, rendezvous
framing, observation records and export formats remain unchanged; historical
`pap-chatgpt-release/1` evidence is not relabelled.

The development view stores its local bearer and selected target identity in
per-tab session storage so reload can read authoritative state without choosing
another target. It persists no prompt bytes, send grants or pending commands.
`/close` detaches that view and leaves the engine available; the explicit
`/engine/exit` endpoint is used by the private development stop command.

## Local verification

Run `npm run test:chatgpt` for the engine, actual extension-worker, native-relay,
composer and confirmation regressions. `npm run test:product` includes
`resident-view-and-scopes`, which uses real authenticated product requests,
native frames, encrypted storage and the fixture sponsorship ledger. It checks
view closure, replay and unrelated document changes during one pinned operation.
`npm run test:recipient-browser` additionally reloads the actual development
view and checks shared cancellation and legacy receipt flows in an isolated
headless Chrome profile. All resources are temporary and explicitly injected;
none of these checks sends live prompts or transactions or changes a retained kit.
