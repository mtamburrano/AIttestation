# Private owner acceptance on macOS

This opt-in build uses the normal user's explicitly configured account with fresh
Attestamp state and a separate Keychain service. It reuses the private app, resident,
helper and integration setup. It has no sponsor, updater, agent API, notarization,
Store or release authority. Signing and installed-client testing are later owner
actions; synthetic tests do not exercise those boundaries.

## Prepare and sign later

Use Apple-silicon macOS 15.7+, Node 22.13+, Xcode tools and the existing approved
private Developer ID identity and helper provisioning profile. Build the local
native prerequisites as described in [private development](README.md). Do not use
or copy an existing acceptance namespace or test account's state.

Create a new owner-only configuration file outside the checkout. Start with the
existing private signing configuration, set `sponsor` to `null`, omit `agent` and
`namespace`, and add:

```json
"ownerAcceptance": {
  "profile": "pap-private-owner-acceptance/1",
  "namespace": "<12 fresh lowercase hex digits>",
  "account": { "username": "<normal macOS short name>", "uid": 501, "home": "/Users/<short name>" }
}
```

Use the actual account UID, not the illustrative `501`. Generate the namespace
with `node -p 'require("node:crypto").randomBytes(6).toString("hex")'`. The account
must match macOS's account record. Select a fresh, private Chrome 154 app copy under
that user's home, outside the state root; leave existing browser profiles untouched.
The launch uses a fresh Chrome profile and requires other Chrome copies closed.

Set `OWNER_CONFIG` to that configuration's absolute path, `OWNER_ROOT` to
`/Users/<short name>/.attestamp-owner-<namespace>` and `OWNER_CHROME` to the selected
Chrome `.app`. Run from the reviewed source checkout:

```sh
npm run dev -- init --owner-acceptance "$OWNER_CONFIG"
npm run dev -- signing-preflight "$OWNER_CONFIG"
npm run dev -- prepare "$OWNER_CONFIG" "$OWNER_ROOT/builds/build-1"
npm run dev -- doctor --owner-acceptance "$OWNER_CONFIG" --chrome-app "$OWNER_CHROME"
npm run dev -- start "$OWNER_ROOT/builds/build-1" --chrome-app "$OWNER_CHROME" --owner-acceptance
```

Initialization refuses any existing root. Keep the signed app at this final path
before installing hooks. Evidence and integration ownership journals live in
`$OWNER_ROOT/support`, with control and Chrome state in sibling directories. Keychain items use
`ai.provenance.owner.<uid>.<namespace>`. Existing private-test and agent commands are
unchanged. No live Sends, chain activity or signing upload is authorized by setup.

## Connect and remove

Open Dashboard → Connections → **Find installed clients**, select the intended
desktop/IDE/CLI executables, then review setup. Defaults are the configured account's
`.codex` and `.claude`; finding clients and previewing leave them unchanged. Only
explicit consent and Apply install the owned hook. Complete Codex's own trust prompt
and the documented client restart. Detection alone does not prove hook emission or
an active subscription. See [Mac connections](../coding/SETUP.md) for scope limits.
Firefox uses its standard per-user native-host directory, also only after preview
and consent; it still needs a designated profile and the separately approved XPI.

If Codex has both inline TOML hooks and `hooks.json`, preserve both. Before any
manual cleanup, select the known prior installation's journal and receiver path:

```sh
node spikes/development/inspect-codex-hook.mjs "/Users/<short name>/.codex" "/absolute/prior/support/coding-integrations.json" "/absolute/prior/Attestamp.app/Contents/MacOS/provenance-hook-receiver"
```

This reads bounded files, executes no hooks and prints no settings. Only an exact,
unique hook matching that journal and receiver is `MATCHED_ATTESTAMP_JOURNAL`.
`UNPROVEN`, a missing journal, or a failed check means ownership is not established.
A match is evidence for owner review, not permission to delete a file. Back up both
files and preserve unrelated settings; setup never merges or deletes the ambiguity.

Turn recording OFF, preview and apply removal for each coding/Firefox connection, then run
`npm run dev -- stop --owner-acceptance "$OWNER_CONFIG"` and close the private browser.
Removal preserves unrelated hooks and evidence. Keep the root and keys for restart
or export. To retire it, export first, verify hooks are removed, and delete only this
exact root and its exact Keychain service through an explicit owner action. Never
delete the production vault service or any retained acceptance/test namespace.
