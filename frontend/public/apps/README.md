# App builds handed out at the venue

Drop the installers here and they appear on `/hyfitgames/tools/apps/`, each with
its own QR code for phones to scan:

```
public/apps/judge/      → the judge app
public/apps/checkin/    → the check-in app
```

Any `.apk` in the folder counts. When there is more than one, the page serves
the **most recently modified** file and lists the rest as older builds, so
dropping a new build in is the whole release process — nothing to rename, no
page to edit.

The filename is shown to whoever is installing, so give it a version:
`hyfit-judge-1.4.2.apk` reads better than `app-release.apk`.

## Why the QR has to be built in the browser

The QR encodes an absolute URL, and it has to be one the *phone* can reach — a
`localhost` link works on the laptop showing the page and nowhere else. So the
page reads the host out of the address bar, and if that host is loopback it
offers the machine's LAN addresses instead. Open the page over the LAN (or pick
a LAN address on it) before pointing a phone at the screen.

`npm run dev:lan` binds the dev server to `0.0.0.0` so the LAN can reach it.

## Android will ask twice

These are sideloaded builds, not Play Store installs. Chrome warns about the
download, and Android then asks for "install unknown apps" permission for
Chrome. Both are expected; there is no way to suppress either from this side.

Files in these folders are ignored by git — builds do not belong in the repo.
