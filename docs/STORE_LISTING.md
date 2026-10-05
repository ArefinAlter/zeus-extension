# Store listing (draft)

Text for the Chrome Web Store, Edge Add-ons and Firefox AMO. Not published; the extension id is assigned at the first upload (see [EXTENSION_ID.md](EXTENSION_ID.md)).

## Name

Zeus: finish failed downloads

## Summary (132 characters maximum)

Finish downloads your browser could not, with Zeus on your own computer. Nothing is sent to any server.

## Description

Zeus Extension connects your browser to the **Zeus app** on your computer, a free, open-source download manager built for people who work with AI agents and large files.

**What it does**

- **Rescues interrupted downloads.** When your browser gives up on a download (the network dropped, the link timed out), Zeus can finish it with resumable, verified transfers, and shows you the result with a checksum.
- **Asks before using your sign-in.** Some downloads need you to be signed in to a website. Zeus asks you, in this extension's popup, whether it may use your session for that one website: once, for 24 hours, or never. Cookies are read only for the site you approved, for at most 15 minutes at a time, and never stored.
- **Works with expired links.** If a signed download link expired, the extension can ask your browser for a fresh one, with your consent.
- **Keeps you in control.** The Settings page lists every site you approved and lets you revoke it. Approvals can only be given by you, with a click, never by a program or an AI agent.

**What it does not do**

- It sends nothing to the internet except what you ask Zeus to download. No analytics, no telemetry, no account.
- It never touches finished downloads, never reads your history or your tabs, and never overrides your browser's safety warnings.

**You need the Zeus app.** The extension talks only to the Zeus app on the same computer. Install it from the project page, then run `zeus native-host install` once to connect it to this browser.

Languages: English, Bangla (বাংলা).

## Category and tags

Productivity. Download manager, resume downloads, local-first, privacy.

## Single-purpose statement

See [PERMISSIONS.md](PERMISSIONS.md).

## Data disclosures (Chrome Web Store "Privacy practices")

- The extension does **not** collect or transmit user data to the developer or to any third party.
- It handles "web history" (the address of an interrupted download) and "authentication information" (cookies for a site the user approved) **locally**, passing them only to the Zeus app on the same computer, for the user-requested purpose of finishing a download. See [PRIVACY.md](PRIVACY.md).
- Certifications: not sold or transferred to third parties; not used for unrelated purposes; not used to determine creditworthiness.

## Firefox AMO

`browser_specific_settings.gecko.data_collection_permissions.required = ["none"]`. Minimum Firefox 140. Source code submission: the package is built unminified from this repository with `npm run build:store`.

## Screenshots to prepare

1. Popup with a pending approval (the three scope buttons).
2. Popup showing a completed rescue notification and the job list.
3. Settings page listing approved sites with Revoke.
4. The same popup in Bangla.
