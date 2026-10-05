# Native host registration

The extension talks to `zeus-native-host` through the browser's native-messaging channel. The browser starts the host only if a **host manifest** named `dev.zeus.native_host` is registered and names this extension (spec 02 section 3).

**You normally do not do this by hand.** The Zeus CLI performs the registration:

```
zeus native-host install     # registers the host for every installed browser, per user
zeus native-host status
zeus native-host uninstall
```

The files here are the templates the CLI fills in, and the reference for doing it manually.

## Templates

| File                                         | Browser                       | Placeholders                                                                             |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `dev.zeus.native_host.chrome.json.template`  | Chrome, Chromium, Edge, Brave | `__HOST_PATH__` absolute path of `zeus-native-host`, `__EXTENSION_ID__` the 32-letter id |
| `dev.zeus.native_host.firefox.json.template` | Firefox                       | `__HOST_PATH__`, `__ADDON_ID__` (`zeus@zeus.invalid`)                                    |

`allowed_origins` takes exact `chrome-extension://<id>/` entries (Chrome rejects wildcards). `allowed_extensions` takes add-on ids. The extension ids are recorded in [../docs/EXTENSION_ID.md](../docs/EXTENSION_ID.md): the **dev** id is for unpacked builds loaded from `dist/chrome`; the store id differs and is known only after the first store upload.

## Where the manifest goes (per user, never system-wide)

| Browser | Windows                                                                                                            | macOS                                                                                        | Linux                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Chrome  | registry value `HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.zeus.native_host` = path of the manifest file | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.zeus.native_host.json` | `~/.config/google-chrome/NativeMessagingHosts/dev.zeus.native_host.json` |
| Edge    | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\dev.zeus.native_host`                                           | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`                         | `~/.config/microsoft-edge/NativeMessagingHosts/`                         |
| Firefox | `HKCU\Software\Mozilla\NativeMessagingHosts\dev.zeus.native_host`                                                  | `~/Library/Application Support/Mozilla/NativeMessagingHosts/`                                | `~/.mozilla/native-messaging-hosts/`                                     |

## Developer setup

1. `npm run build` in the repository root.
2. Load `dist/chrome` as an unpacked extension (Chrome: `chrome://extensions`, Developer mode, Load unpacked). Its id is the dev id because the dev manifest carries the dev public key.
3. Run `zeus native-host install` and register the dev id as a development extension. The host additionally checks `argv[1]` against its own allow-list file and accepts a development id only when that file lists it under `dev_extensions` (spec 02 section 13.1), so a development id must never be shipped in a release allow-list.
4. Open the extension popup: the status line shows "Connected to Zeus" once the daemon is running.

## Troubleshooting

| Popup says                                | Meaning                                                         | Fix                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Zeus app not found                        | The browser reports "Specified native messaging host not found" | Run `zeus native-host install`; check the registry value or file path above                              |
| Zeus does not recognise this extension    | The browser reports the host is forbidden for this origin       | The extension id is missing from `allowed_origins` (store builds have a different id than the dev build) |
| Connection paused after repeated failures | Five connections in a row lasted under two seconds              | Fix the host, then press "Try again now"                                                                 |
