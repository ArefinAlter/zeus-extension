# Extension identity

Native messaging pins the extension by its identifier (spec 02 section 13.1), so the id has to be stable in development and known when the store build is published.

## Chromium family (Chrome, Edge, Brave)

Dev extension id: `nfiaihlklfadnbcfadmhbmddabmafilo`

- Chrome derives an extension id from a public key: the first 16 bytes of the SHA-256 of the DER-encoded `SubjectPublicKeyInfo`, each hexadecimal digit mapped to a letter `a` to `p`.
- The dev build (`npm run build`) carries that public key as the manifest `key` (committed in `src/manifest.dev.json`), so every developer who loads `dist/chrome` unpacked gets the id above.
- The key pair was generated once with Node `crypto` (RSA-2048). **Only the public half was kept.** The private key was held in memory, never written to disk and discarded, so nobody (including the maintainers) can sign an update under this id. That is intentional: the dev id exists only to make `allowed_origins` deterministic during development.
- The store build (`npm run build:store`) omits `key`. The Chrome Web Store assigns its own id on first upload and signs releases with a key it holds. **That id is not known until the first upload.** At release time:
  1. Upload the store build, read the assigned id from the developer dashboard.
  2. Add it to `native-host/dev.zeus.native_host.chrome.json.template` (`allowed_origins`) and to the allow-list the Zeus installer writes next to `zeus-native-host`.
  3. Record it below.
- Edge add-ons and Brave use the same Chromium manifest. Edge Add-ons assigns its own id for store builds as well.

`npm run check` recomputes the id from `src/manifest.dev.json` and fails if it differs from the value recorded above, and it fails if a store build carries a `key`.

### Host manifest

`allowed_origins` takes exact `chrome-extension://<id>/` entries; Chrome rejects wildcards. The templates in `native-host/` use the placeholder `__EXTENSION_ID__`; the `zeus native-host install` command substitutes the ids it was given. Spec 02 section 13.1 additionally requires the host to check `argv[1]` against its own allow-list file and to accept development ids only when that file lists them under `dev_extensions`, so the dev id above must be listed there on developer machines and must **not** be shipped in a release allow-list.

## Firefox

Add-on id: `zeus@zeus.invalid` (`browser_specific_settings.gecko.id`, written into `dist/firefox/manifest.json`). Firefox host manifests use `allowed_extensions` with that id. For an AMO-listed build Mozilla keeps the id from the first signed upload, so it must match what is submitted.

## Recorded store ids

| Store            | Id                                     | Date recorded |
| ---------------- | -------------------------------------- | ------------- |
| Chrome Web Store | not yet assigned                       |               |
| Edge Add-ons     | not yet assigned                       |               |
| Firefox AMO      | `zeus@zeus.invalid` (chosen, unsigned) | 2026-10-05    |
