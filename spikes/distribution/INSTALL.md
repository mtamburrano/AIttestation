# Install, connect and remove Attestamp

These instructions apply to a Developer ID signed, Apple-notarized release or
release candidate. A release candidate is for pre-publication review only and is
not a production installer. A development build is not a consumer installer.
The current repository has no published/verified Web Store listing; its keyed
manifest matches the assigned draft item identity.

1. On an Apple-silicon Mac running a supported, security-patched macOS version,
   open the downloaded Attestamp disk image. Copy Attestamp.app and
   Attestamp Verifier.app to your Applications folder in Finder. Keep the free
   Attestamp Verifier app available for exports.
2. Open Attestamp and accept the normal macOS first-open confirmation.
   Do not bypass Gatekeeper or disable system protection. The app uses the local
   Keychain; no wallet, seed phrase, terminal or MCP configuration is needed.
3. Choose **Integrations** from the Attestamp menu, then **Enable connection**.
   This registers only this app's native connection for your macOS user. Choose **Open Chrome Web
   Store**, then add **Attestamp for ChatGPT** and accept its displayed permissions.
   Access is limited to chatgpt.com, native messaging and the trusted side panel.
   Incognito is unavailable.
4. Open the Attestamp sidebar and turn recording **ON**. Use ChatGPT's normal
   composer and Send; supported existing/new tabs and windows are followed
   automatically. Attachments, other sites/browsers, responses and unsupported
   inputs are outside this best-effort text recording contract.
5. Inspect effective connection and recording status separately. **Prompt saved**
   means durable local evidence; anchor status is asynchronous. Turn **OFF** to
   stop new capture while retaining history and bounded pending anchor work.
   New/recovered installations start OFF. Closing a view leaves the resident app
   running. Fresh pairing after restart never replays Send or backfills history.

In Settings, use **Check for updates**, then **Download verified update**. The app verifies
the signed release manifest, exact download bytes, signing team and Apple
notarization before opening the disk image. Close the running app, replace it in
Finder and reopen. This is a user-initiated update; there is no background
installation or automatic app replacement. Evidence stays in its existing local
store. Reconnection may be required if the app moved. Older application sequences
are rejected before opening the vault. A repair release has a new sequence and
must support the existing schema.

To remove the connection, open Integrations and choose **Remove connection**.
Review and export selected receipts or
choose to keep evidence on this Mac. Then remove the Chrome connection, remove
the extension in Chrome, quit Attestamp and move Attestamp.app to Trash in Finder.
The encrypted vault and Keychain items are retained, and Attestamp Verifier
continues to work. Reinstalling and enabling the connection restores access to local history;
fresh source/identity checks still apply. Do not delete the local evidence
store or Keychain items as a troubleshooting step.

**Disable connection** is reversible and also revokes new capture.
After re-enabling, inspect current connection status in the sidebar; restart
Chrome if needed. History counts prompts and known conversations. Review selected
evidence before export; local source corroboration is distinct from a portable
proof. Settings offers an encrypted recovery copy and a separate recovery key.
Keep those separately. The free verifier works without an anchoring account.

The support report is saved locally and contains only fixed status values and
bounded setup action counts. Nothing is uploaded automatically. Preview it before
sharing. Evidence exports contain selected private information; they are separate
from support reports.
