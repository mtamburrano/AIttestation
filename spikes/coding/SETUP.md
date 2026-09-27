# Mac connections

Attestamp uses one local vault and one recording switch. New connections start
disabled. Turning recording ON covers only connections that you explicitly enable.
An ON label is not confirmation that a prompt was saved.

## Prepare once

Use the signed Mac application and a dedicated test account/profile for a private
walkthrough. Keep sponsor configuration absent (OFF). Do not reuse or reset an
existing vault, recovery secret, browser profile or signing key. The development
package contains a separate Firefox add-on identity; it is not a Store release.
Keep the application in its intended permanent location before registering hooks.

Open Dashboard → Connections, select a client, then preview installation. The
preview lists the exact file and the one owned hook/native registration. Confirm
the recording consent and apply the preview. If the file changes before applying,
preview again. Conflicts never restore an old copy over unrelated settings.

For Codex, the default is the user `~/.codex/hooks.json`. Existing inline hooks in
`config.toml` remain TOML; simultaneous inline and JSON definitions require manual
resolution. Complete Codex's own hook trust prompt and restart the client. For
Claude Code, the default is the user `~/.claude/settings.json`; restart the client
after registration. Custom user configuration folders and executable paths must
be selected explicitly. Script installations also require the actual interpreter
path. An executable or interpreter update requires a new preview and enrollment.
Project files and existing unrelated hooks are preserved.

Enrollment verifies the selected native executable's signature and pins its
CodeDirectory identity. Each submission validates the running process against
that identity. Script entrypoints are limited to 4 MiB and also require a pinned
native interpreter. An unavailable identity check leaves registration unchanged.
This establishes an explicitly enrolled local executable, not vendor authorship.

The only registered event is the official synchronous `UserPromptSubmit` command.
The bundled receiver exits with code 0 and no output. It allows at most 250 ms for
local authentication and an in-memory admission; it never waits for durable
storage, signing, anchoring, network work or provider acknowledgement. Unavailable,
busy, disabled or unsupported paths skip capture. They do not resend a prompt.
The client timeout is one second as a secondary fail-open ceiling.

The receiver uses native local transport; the resident runs the shared Codex and
Claude decoders. No additional Node process is started for each submission.
Connections reports the last observed attempt, including identity rejection,
unsupported input, timeout and backpressure. A never-observed hook remains distinct
from an observed failure. These short-lived hooks are not persistent connections,
and admission does not mean the prompt has been saved; check History for that.
Hook diagnostics contain bounded stage counters, without prompt text, paths,
client identifiers or raw error messages.

Removing or replacing an enrollment immediately retires its resident peer and
unreleased attempts. Other integrations keep running. Interrupted Firefox native
registration updates recover ownership from their before/after journal without
restoring an old configuration over unrelated edits or re-enabling recording.

## Firefox

The Firefox adapter targets Firefox 153 stable on Apple-silicon macOS with a
dedicated browser profile. Consult [validation coverage](VALIDATION.md) before
treating a target as an installed, verified configuration.
Preview/apply Firefox in Connections to register its per-user native host. Load
`Firefox Extension/manifest.json` through `about:debugging` for a temporary local
test. Grant ChatGPT site access and open Attestamp from the toolbar; controls are
in the sidebar. The observer, request decoder and evidence engine are shared with
Chrome. Firefox's own authenticated identity and observation profile are retained.

Temporary extensions disappear on Firefox restart. Persistent installation needs
a Mozilla-signed XPI for the matching private or distribution add-on ID. The
included `*-unsigned.xpi` is a build artifact, not a persistently installable or
approved release. Obtain separate owner approval for a signing submission before
uploading it. Do not change signature enforcement or copy another add-on's ID.

The manifest declares ChatGPT website content/activity and personal communication
data passed to the local application. Prompt evidence stays in the encrypted local
vault. The optional anchoring service receives blinded commitments, not prompts.

## One walkthrough

1. Record the exact Mac, browser, CLI, IDE and desktop versions and which surface
   actually emits the official user hook. CLI support does not imply IDE, desktop,
   remote, container, cloud, noninteractive or subagent support.
2. With recording OFF, submit a synthetic prompt on each enabled surface. No new
   evidence should appear. Live provider submissions require separate authorization.
3. With recording ON, submit distinct synthetic text and equal text twice. Check
   exact bytes and distinct sends in History. Hook evidence describes only the
   documented prompt field, without attachments, hidden context or provider receipt.
4. Exercise Chrome and Firefox together, then coding clients together. Toggle OFF,
   disconnect one source and disable one connection; other sources remain isolated.
5. Export a selected mixed-source receipt and verify it in the standalone verifier.
   Back up into a new recovery file and restore into a new empty destination. Check
   old evidence bytes and that recovery does not silently enable new connections.
6. Preview removal, apply it, and confirm only the owned entry disappeared. History,
   keys and exports remain. Reinstall through a new preview when desired.

Do the persistent Firefox restart step only after the matching signed XPI exists.
Record absent or unverified surfaces explicitly; never infer support from an
installed application or a synthetic identity fixture. Native admission latency
must report OFF, admitted, unavailable and busy paths with p50/p95/p99 and outliers.

Before scheduling the walkthrough, prepare all prerequisites together: a validly
signed Firefox installation, the selected local Codex and Claude Code versions,
a dedicated account/profile and a signed private Attestamp build. Record each
CLI/IDE/desktop entrypoint separately. Claude Code must expose the documented
`prompt_id` (2.1.196 or later). For persistent Firefox restart coverage, also
prepare the matching Mozilla-signed XPI under separate upload authorization.
Complete client hook trust prompts through the clients' own UI; do not bypass them.
Authorize any bounded live synthetic Sends separately before starting that step.

Official contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging),
[Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
