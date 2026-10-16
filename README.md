# Zeus Extension

The Manifest V3 browser extension of [Zeus](https://github.com/ArefinAlter/zeus), the session-aware download and file layer for AI agents. Chrome and Edge are the primary targets; Firefox is a build target.

**Status: pre-alpha.** The protocol and the extension side of every flow are implemented and tested against a scripted daemon. It has not yet been run against the real `zeusd` (the cross-repository conformance test is the next integration step).

## What it is for

- **Download rescue.** An interrupted browser download is offered to Zeus (`handoff.offer`), which finishes it with resumable, verified transfers.
- **Trust surface.** The popup shows approvals the daemon computed facts for. Only a human click in an extension page can approve; an agent cannot.
- **Session oracle.** After the user approves a site, and only for that site, the extension releases the cookies the browser would send, for at most 15 minutes, on a request from the daemon that passes the extension's own consent check.
- **In-browser fetch fallback.** When a server refuses the daemon, the user's own browser performs the (ordinary, credentialed) fetch and streams the bytes to the daemon under flow control.

It sends nothing anywhere except to the Zeus app on the same computer, has no analytics and bundles only a pinned local BLAKE3 hashing library. See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## Quick start

Requirements: Node 22 (npm 10 or later). pnpm is not used.

```sh
npm ci
npm run typecheck && npm run lint && npm test
npm run build            # dist/chrome and dist/firefox (development builds)
npm run check            # manifest, locale, contract and supply-chain invariants
```

Load `dist/chrome` as an unpacked extension (Chrome or Edge, Developer mode). Its id is stable (`docs/EXTENSION_ID.md`). Register the native host with the Zeus CLI, `zeus native-host install`; see [native-host/README.md](native-host/README.md).

| Script                                           | What it does                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`, `build:chrome`, `build:firefox` | Development builds into `dist/<browser>` (Chrome carries the dev `key`; source maps included)                              |
| `npm run build:store`                            | Store builds into `dist/store/<browser>`: no `key`, no source maps                                                         |
| `npm run typecheck`                              | `tsc --noEmit` over `src`, `test` and the build scripts (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `npm run lint`                                   | ESLint (typescript-eslint strict, type-checked) and `prettier --check`                                                     |
| `npm test`, `npm run test:conformance`           | Vitest. The conformance suite proves the protocol codec against the spec's own examples and sequence diagrams              |
| `npm run check`                                  | Manifest invariants, localisation parity, contract drift, generated-type freshness, pinned hashing dependency              |
| `npm run sync:schema`                            | Copy the normative contracts from the sibling `zeus` checkout (`../zeus` or `$ZEUS_REPO`)                                  |
| `npm run gen:types`                              | Regenerate `src/lib/protocol.generated.ts` from `schema/`                                                                  |
| `npm run gen:icons`                              | Regenerate the placeholder PNG icons                                                                                       |

## Layout

```
src/background/   service worker: link, consent gate, session oracle, fetch proxy, rescue, approvals
src/popup/        the trust surface        src/options/   settings
src/lib/          protocol, schema guard, errors, redaction, platform adapter
schema/           copies of the normative contracts (lock file + drift check) and spec examples
native-host/      host manifest templates and registration notes
_locales/         en and bn (Bangla) message catalogues
docs/             PERMISSIONS, PRIVACY, THREAT_MODEL, STORE_LISTING, ARCHITECTURE, EXTENSION_ID
test/             Vitest suites, the hand-written browser mock and the scripted daemon
```

## Contracts

The wire protocol is `zeus/docs/spec/02-native-messaging-v1.md` with the schemas in `docs/spec/schema/`. They win over this code. `schema/` here is a verified copy: `npm run sync:schema` refreshes it, `npm run check` fails when it drifts from the lock file or from a sibling checkout.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions need a DCO sign-off ([CONTRIBUTING.md](CONTRIBUTING.md)).
