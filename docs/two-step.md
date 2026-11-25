# Two-step verification

Tested through the API, and in Chromium with its virtual passkey authenticator
(setting up a passkey and the authenticator app, signing in with the second step,
Admin's check). Not yet with a real phone or security key.

A second step besides the password: a **passkey** (Face ID, Touch ID, Windows
Hello, an Android phone, a security key) or a 6-digit code from an
**authenticator app**, with ten one-time **recovery codes** for when both are
lost. It follows MediaRiffle's and WifiDB's, so the three sign in the same way.

## Who needs it, for what

| Who | Without two-step | With it |
| --- | --- | --- |
| Signed out | the public view ([publishing.md](publishing.md)) | — |
| Viewer | everything, live, read-only | the same; asked for at sign-in only if they choose that |
| Admin | everything, read-only, as a viewer | controlling the radios, and Admin |

Two checks, for two kinds of power:

- **Controlling the radios**: connecting and disconnecting, Controls, Channels
  (reading, writing, backups), the scanner's keys and waterfall, the beacon,
  transcribing again, deleting transmissions, placing channels on the Map, Map
  → Find. This needs a second step **taken in this session**: at sign-in, or
  afterwards when asked. Ticking **Remember this browser for 30 days** at that
  step means signing in on that browser asks only for the password for 30
  days.
- **Admin, which changes settings**: everything under Admin (users, invites,
  sign-in providers, RadioReference, storage, updates), and adding, removing or
  publishing a radio. Opening Admin asks for a passkey or code **of its own**,
  and that lasts 12 hours. The step at sign-in, or a remembered browser, never
  counts toward it, so a stolen session that's been open all day still can't
  change settings.

There's no admin-mode switch to turn on and off, as tippr has. Opening Admin
does the same job: the first visit asks, and the next 12 hours don't.

An admin with no two-step set up sees everything as a viewer does. The
console shows them where to set it up, and so does Admin.

## Signing in

Signing in is always a username and password, or Google, GitHub, Discord or
Facebook ([linked-logins.md](linked-logins.md)). A passkey or code is only ever
a second step, never a way in on its own, as in tippr.

The second step is asked for when something needs it: the first time a session
controls the radios, and when Admin's 12 hours are up. Reading and listening
never ask. On a remembered browser the radios don't ask either.

**Your account → Two-step verification → Ask when I sign in too** asks for it at
sign-in as well, for those who want that: then a passkey, or an authenticator or
recovery code, right after the password, unless the browser is remembered. A
half-finished sign-in waits 5 minutes. That step counts for the radios, not for
Admin. Turning it off needs a check in the last 10 minutes.

The password lockout ([accounts.md](accounts.md#signing-in)) counts wrong
codes too.

## Setting it up

**Your account → Two-step verification**, or Admin when it's not set up yet:

1. The password again: nothing else proves it's you yet.
2. A passkey, or an authenticator app (a QR code to scan, or the key to type).
3. The ten recovery codes, shown once, to copy or download.

The other kind can be added afterwards. Adding or removing a passkey, turning
the authenticator off, or making new recovery codes needs a check within the
last 10 minutes. Removing the last way to verify turns two-step off.

**Admin → Users → Reset two-step** clears another account's passkeys,
authenticator, recovery codes and remembered browsers, for someone who lost
them all. They set it up again.

## Passkeys need the HTTPS address

Browsers make and use passkeys only on a secure page, and a passkey belongs to
the name it was made on. Made on `https://airscribe.example.net`, it works
there and nowhere else, so not on `http://<container address>:8100`. The
authenticator app and recovery codes work on any address. An admin who signs in
on both should set up both.

Behind a reverse proxy, set `trustProxy` ([publishing.md](publishing.md#one-address))
so AirScribe sees the visitor's address and that the page was HTTPS.

## The settings file

- **API tokens** (`auth.tokens`) are for scripts, which can't use a passkey. An
  admin token passes both checks: keep it like a password.
- **The settings file's password** (`auth.passwordHash`) is the way back in when
  every admin's two-step is lost. It passes both checks, so it's accepted only
  from this machine or the local network, not through a proxy (a request that
  carries `X-Forwarded-For`).
- **`"twoStep": {"required": false}`** turns the requirement off: admins'
  accounts then control radios and open Admin with the password alone. Two-step
  still works for those who set it up.

```json
"twoStep": { "required": true, "adminHours": 12, "rememberDays": 30 }
```

## What's kept

- Passkeys: the credential ID, the public key, its signature counter, the name
  it was given and whether it syncs (iCloud Keychain, Google Password Manager).
  AirScribe never sees the private key.
- The authenticator app's secret, in the database, as tippr and MediaRiffle
  keep theirs. Anyone who can read the database can make codes, so keep its
  permissions as the package sets them.
- Recovery codes and remembered browsers as SHA-256 only, as invite links are.
