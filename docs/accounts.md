# Accounts, invites and signing in

Everyone who uses AirScribe can have an account of their own: a username, a
password and a role.

| Role | May |
| --- | --- |
| viewer | read and listen to everything, unpublished transmissions included, and change nothing |
| admin | everything: controlling the radios, deleting, and Admin (settings), each behind two-step verification ([two-step.md](two-step.md)) |

## The first account

A new install has one way in: the password in the settings file
(`auth.passwordHash`; a new Proxmox container leaves it in
`/root/airscribe-first-login.txt`). Sign in with it, open **Admin → Users**, and
add an account for yourself as an admin, or make yourself an invite. The
settings file's password keeps working beside accounts, as the node's own admin
with no account of its own. That makes it the way back in if every admin account
is lost: `node tools/make-password.mjs` prints a hash for `auth.passwordHash`.

A node with nothing in the settings file listens only on this machine
(127.0.0.1), and anyone there may use it without signing in. Its first account
has to be an admin, and once that exists, everyone signs in. It may then listen
on the network, as an admin account counts as a credential.

API tokens (`auth.tokens`) are unchanged: they're for scripts, and an
`<audio>` link or a page opened with `?token=`.

## Invites

**Admin → Users → Invite someone** makes a link that makes one account, as a
viewer or an admin, for 1 to 30 days (7 by default). Send it to the person: they
open it, choose a username and a password, and they're signed in. The link works
once and is shown only when it's made: AirScribe keeps only its SHA-256, so the
database alone can't be used to join. Invites not yet used can be taken back.
The invite is after the `#` in the link, so it doesn't reach a web server's
logs.

## Admin → Users

Each account's role can be changed, its password set, its browsers signed out,
and the account turned off (it's signed out at once and can't sign in until it's
turned back on) or deleted. **Add an account** makes one directly, with a
password to pass on.

The last enabled admin account can't be made a viewer, turned off or deleted, so
accounts never lock every admin out.

## Your account

The name in the header opens it: change your password (which signs out every
other browser signed in to the account), set up two-step verification
([two-step.md](two-step.md)), link Google, GitHub, Discord or
Facebook to sign in with ([linked-logins.md](linked-logins.md)), set your
callsign for APRS and a radio's beacon (**Amateur radio**,
[packets.md](packets.md#your-profile-and-a-radios-beacon)), or sign out
everywhere but here.

## Choices on the pages

What you choose on the pages is kept with your account, so it follows you to
another browser, or to the server's other address (its IP and its domain name
are two sites to a browser, each with its own storage). That's the Map's base
map, layers, tab, radio, hours and hidden channels, Roads on the map, the
feed's Hide silent, and the states ticked in Uniden's database
(`public/prefs.js` lists them). Speaking findings aloud, and its voice, stay
with the browser: they're about the device.

They're read before the page draws (`GET /api/account/choices`) and saved a
moment after each change (`PUT`, a key and a string, or null to forget one).
The first time an account signs in somewhere, the choices already made in that
browser are kept for it. Signed out, and on a server without accounts, they're
kept in the browser only, as before.

## Signing in

- Five wrong passwords in a row lock an account for 15 minutes; twenty wrong
  tries from one address in 15 minutes make that address wait.
- An account's username takes only that account's password. The settings
  file's password works with any other name, or with none.
- A browser stays signed in for 12 hours after it was last used. Sign-ins are
  kept in the database (only a hash of each), so a restart or an update signs
  nobody out.
- A changed role, an account turned off, or a new password takes effect at once,
  on every browser.
