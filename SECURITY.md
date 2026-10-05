# Security policy

This extension can release a signed-in user's cookies to a local program, so security reports are taken seriously.

## Reporting a vulnerability

Please report privately through GitHub: **Security > Report a vulnerability** on this repository (<https://github.com/ArefinAlter/zeus-extension/security/advisories/new>). Do not open a public issue or pull request for a suspected vulnerability.

Include the affected version or commit, the browser and version, a description and impact, steps or a proof of concept, and whether you want to be credited. Do not include real cookies, tokens or personal data.

You can expect an acknowledgement within 5 working days. We aim to triage within 10 working days and to fix confirmed high-severity issues before public disclosure, coordinating a date with you. This is a volunteer, pre-alpha project: these are targets, not guarantees.

## Scope

In scope, in particular:

- any way for a web page, another extension or an agent to cause a release of cookies or to approve a request (the release gate in `src/background/consent.ts`, the sender checks in `src/background/ui.ts`);
- leakage of cookies or URLs with secrets into logs, storage, notifications or any frame other than `session.response`;
- the in-browser fetch proxy sending bytes for an origin the user did not approve, or labelling bytes with wrong offsets;
- native-messaging framing and validation errors that desynchronise or crash the worker;
- cross-site scripting through file names or other remote text in the popup or notifications;
- a manifest that grants more than [docs/PERMISSIONS.md](docs/PERMISSIONS.md) states.

Out of scope: an attacker who already runs arbitrary code as the user or controls the browser profile (documented residual risk in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)); a compromised Zeus daemon (it is the user's own program and is given the leases it asks for); findings in development-only dependencies; social engineering.

## Supported versions

There are no releases yet. Only the `main` branch receives fixes.
