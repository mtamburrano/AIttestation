# Install, connect and remove

These instructions apply to a Developer ID signed, Apple-notarized release with
a published Chrome Web Store listing. A development build is not a consumer
installer. The current repository has no provisioned production signing identity
or Web Store listing.

1. On an Apple-silicon Mac running a supported, security-patched macOS version,
   open the downloaded Private Provenance disk image. Copy both apps to your
   Applications folder in Finder. Keep the free Verifier app available for exports.
2. Open Private Provenance and accept the normal macOS first-open confirmation.
   Do not bypass Gatekeeper or disable system protection. The app uses the local
   Keychain; no wallet, seed phrase, terminal or MCP configuration is needed.
3. Choose **Enable Chrome connection** in the local app page. This registers only
   this app's native connection for your macOS user. Choose **Open Chrome Web
   Store**, then add the published extension and accept its displayed permissions.
   Access is limited to chatgpt.com and native messaging. Incognito is unavailable.
4. Open one empty, active ChatGPT tab. Refresh the paired tab in the app and
   enroll it. Compose protected text in the local app. Provider-page drafts,
   attachments, other sites and other browsers are outside this protected path.
5. After restarting Chrome or the app, refresh and enroll again. Interrupted
   submissions are never sent again automatically. An unknown outcome is not
   confirmation that the provider received nothing.

Use **Check for updates**, then **Download verified update**. The app verifies
the signed release manifest, exact download bytes, signing team and Apple
notarization before opening the disk image. Close the running app, replace it in
Finder and reopen. This is a user-initiated update; there is no background
installation or automatic app replacement. Evidence stays in its existing local
store. Reconnection may be required if the app moved. Older application sequences
are rejected before opening the vault. A repair release has a new sequence and
must support the existing schema.

To remove the connection, expand **Remove the connection or get support** and
choose **Prepare to remove connection**. Review and export selected receipts or
choose to keep evidence on this Mac. Then remove the Chrome connection, remove
the extension in Chrome, quit the app and move the app to Trash in Finder. The
encrypted vault and Keychain items are retained, and the Verifier continues to
work. Reinstalling and enabling the connection restores access to local history;
it does not restore past permission to send. Do not delete the local evidence
store or Keychain items as a troubleshooting step.

The support report is saved locally and contains only fixed status values and
bounded setup action counts. Nothing is uploaded automatically. Preview it before
sharing. Evidence exports contain selected private information; they are separate
from support reports.
