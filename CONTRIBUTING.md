# Contributing to Zeus Extension

Thank you for helping. This repository is pre-alpha; reviews of the protocol implementation, tests and the popup UX are the most valuable contributions right now.

## Ground rules

- **Developer Certificate of Origin.** Every commit needs a sign-off (`git commit -s`), which adds `Signed-off-by: Your Name <you@example.com>` and certifies the statement at <https://developercertificate.org/>. There is no CLA.
- **Contracts first.** The wire protocol is specified in the `zeus` repository (`docs/spec`). If this code and the spec disagree, the prose of the spec wins: fix the code, or fix the spec in a pull request there and say so in the description. Never edit `schema/` by hand: it is a verified copy (`npm run sync:schema`).
- **Security-sensitive changes** (the consent gate, approvals, session release, the fetch proxy, anything that handles cookies or URLs) need a test that fails without the change and a line in the pull request on which threat in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) it protects.
- **No new run-time dependencies.** The shipped extension is code from this repository only (`npm run check` enforces it). Development dependencies need a stated reason.
- **No telemetry, no remote code, no broader permissions.** Every permission is justified in [docs/PERMISSIONS.md](docs/PERMISSIONS.md); the manifest check fails if the two disagree.
- Text for people goes through `_locales` (English and Bangla); error codes, event names and enum values are never translated.

## Setup

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build && npm run check
```

Node 22 and npm are required; pnpm is not used. To check the contract copies against the specs, keep the `zeus` repository next to this one (`../zeus`) or set `ZEUS_REPO`.

## Conventions

- TypeScript strict, ESM, no `any`, small modules. Browser globals (`chrome`, `browser`) are touched only in `src/lib/platform.ts`; everything else receives an injected `ExtApi`, which is what lets the tests run against `test/harness/mock-ext.ts`.
- Text from remote servers is data: sanitise it (`lib/sanitize.ts`) and put it in the DOM with `textContent` only (ESLint forbids `innerHTML`).
- URLs go through `redact_url` before they are logged. Never log cookies, headers or frame bodies.
- Every frame the extension sends is validated against the normative schema by the scripted daemon in the tests: if you add a message, the suite tells you when it is wrong.

## Releasing

Store builds come from `npm run build:store` on a tagged commit. The store assigns the extension id at the first upload; record it in `docs/EXTENSION_ID.md` and add it to the host manifest templates and the installer's allow-list before publishing.
