# Privacy policy

Effective 2026-10-05. This is the text for the store listing's privacy policy field.

**Zeus Extension collects no data and sends nothing to any server.** It has no analytics, no telemetry, no crash reporting and no account.

## What the extension does with your information

| Information                                                                                                                | What happens                                                                                                                                                                                                            | Where it goes                                                                             | How long                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Details of a download the browser could not finish (its address, size, file name without folder, the browser's error code) | Sent to the Zeus app running on your computer **when a download is interrupted and the Zeus handoff is on**, or when you press "Finish with Zeus"                                                                       | Only to the Zeus app on the same computer, through the browser's native-messaging channel | Kept by the Zeus app as part of its download record (in its own local database), not by the extension. The extension keeps no URL: it stores only an opaque offer key and the browser's download number.                     |
| Cookies for **one website you approved**                                                                                   | Read from your browser **only after you approve that website for Zeus** (you choose once, 24 hours, or a plan) and only when the Zeus app asks for them for a download of yours. At most 15 minutes of use per release. | Only to the Zeus app on the same computer                                                 | **Not stored by the extension, not logged, not sent anywhere else.** They exist in the browser's memory for the moment of the transfer. The Zeus app also holds them in memory only, for at most 15 minutes, and wipes them. |
| Your decisions (which sites you allowed, for how long; which you blocked)                                                  | Stored locally in the extension's storage so the extension can check them before releasing anything                                                                                                                     | Stays in your browser profile                                                             | Until the choice expires or you revoke it in Settings or in the Zeus app                                                                                                                                                     |
| A random identifier for this browser profile                                                                               | Created once and stored locally. It lets the Zeus app send a job to the browser profile whose cookies it needs.                                                                                                         | Only to the Zeus app on the same computer                                                 | Until the extension is removed                                                                                                                                                                                               |
| Two settings (offer interrupted downloads; show notifications)                                                             | Stored locally                                                                                                                                                                                                          | Stays in your browser profile                                                             | Until you change them                                                                                                                                                                                                        |

## What the extension never does

- It never sends cookies, URLs, file names or any other data to a remote server, to the extension's authors or to anyone else.
- It never reads your browsing history, your open tabs or the content of web pages, and it has no content script.
- It never releases cookies for a website you did not approve, and never for a plain `http` site (except `localhost`).
- It never reads or modifies your finished downloads.
- It never overrides the browser's security decisions: a download the browser blocked as dangerous is not offered to Zeus.

## Your control

- **Settings** (the extension's options page) lists every site you approved, with a Revoke button, and every site you blocked.
- Removing the extension removes everything it stored. The Zeus app keeps its own records; manage them in the app.
- The browser's own extension controls can withdraw the optional site and cookie permissions at any time; the extension stops using them immediately.

## Third parties

None. The extension contains no third-party code at run time: the shipped files are built from this repository with no run-time dependencies (`npm run check` enforces this).

## Changes and contact

Changes to this policy are recorded in the repository history. Questions and reports: see [SECURITY.md](../SECURITY.md).
