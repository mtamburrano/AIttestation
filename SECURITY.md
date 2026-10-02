# Security and privacy reports

Do not publish vulnerabilities, private evidence, credentials or raw diagnostics
in public issues. Use the repository's private vulnerability reporting channel
when enabled. A monitored private contact and response policy have not yet been
established for public release; establishing that channel is a publication gate.
Until it exists, send only a request for a private channel to the maintainer through
an already trusted contact, without exploit details or private data.

Useful reports identify the source revision, platform, affected boundary, expected
and observed behavior, and a minimal synthetic reproduction. Examples of relevant
boundaries include stale recording consent, forged source identity, vault or
recovery corruption, unintended disclosure, update trust and bounded parsing.
Keep test artifacts local until the maintainer provides a private transfer method.
No automatic upload or telemetry is part of the reporting workflow.

Local evidence is encrypted and private by default. Export is an explicit disclosure;
preview exactly what it contains. Content-free diagnostics still deserve review
before sharing. Never provide vault keys, recovery secrets, provider credentials,
browser profiles or a real client configuration. Test only resources you created
for the reproduction. Do not probe hosted services or other users' accounts.

Current support and untested boundaries are listed in [SUPPORT.md](docs/SUPPORT.md).
There is no public security response SLA, bug bounty or supported production release.
