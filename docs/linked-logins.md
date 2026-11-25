# Signing in with Google, GitHub, Discord or Facebook

People can link an outside account to their AirScribe account
([accounts.md](accounts.md)) and then sign in with it instead of their password.
Nothing is on until an admin turns a provider on. It works as in WifiDB and
tippr.

## For everyone

- **Link one:** your name in the header → **Signing in with another account**.
  Enter your password and press **Link a Google account** (or GitHub, ...); sign
  in at Google and you're sent back with it linked. One account from each
  provider.
- **Sign in with it:** the sign-in page shows **Or sign in with Google** (and
  the others that are on).
- **Signed in with one that isn't linked yet:** the page asks for your AirScribe
  username and password, and links it in the same step. That has 10 minutes.
  Without an AirScribe account, ask an admin for an invite: an outside account
  never makes one.
- **Unlink one:** the same page, **Unlink**, with your password.

An outside account only ever signs in to the AirScribe account it was linked to.
Nothing is matched by e-mail address: a Google account with the same address as
yours doesn't get into your account unless you linked it. A turned-off account
can't sign in with a linked one either.

## For admins

**Admin → Sign-in providers.** For each provider:

1. Make an OAuth app (a "client") in the provider's console; the page links to
   it.
2. Give it the **Redirect URI** the page shows, exactly:
   `https://<this server's address>/api/auth/google/callback` (and `github`,
   `discord`, `facebook`).
3. Enter its client ID and client secret, tick **Sign in with ...**, and Save.

| Provider | Console | Notes |
|---|---|---|
| Google | console.cloud.google.com → APIs & Services → Credentials → Create credentials → OAuth client ID (Web application) | Set up the OAuth consent screen first. Asks for `openid email profile`. Takes `http://` only for `localhost`. |
| GitHub | github.com → Settings → Developer settings → OAuth Apps → New OAuth App | The "Authorization callback URL" is the redirect URI. Asks only who it is (`read:user`). |
| Discord | discord.com/developers/applications → New Application → OAuth2 | Add the redirect URI under Redirects. Asks only who it is (`identify`). |
| Facebook | developers.facebook.com/apps → Create App → Facebook Login | Add the redirect URI under Valid OAuth Redirect URIs. Asks for `email public_profile`. |

**This server's address** is the one people (and so the providers) use to reach
AirScribe, such as `https://airscribe.example.com` behind a reverse proxy. Left
blank, it's the address the admin page was opened at, which is right when that's
the address everyone uses. A provider only sends people back to an address
registered with it, so a wrong one fails at the provider, with its own error.

**A privacy policy and terms.** Every AirScribe serves both, readable signed
out, at `https://<this server's address>/privacy.html` and `/terms.html`, linked
from the sign-in page. Give them to a provider that asks, as Google's
Branding page does before an app leaves Testing. **Admin → This server** names
who runs it and how to reach them, and both pages say so; left blank, they
send people to whoever invited them. Every page's footer links them, with
AirScribe's version for those signed in.

Turning a provider off stops sign-ins with it at once; the links stay, and work
again when it's turned back on. The secrets are kept in AirScribe's database
with its other settings, and never shown on the page again.

## How it works

- OAuth 2's authorization code flow, on the server, with PKCE for Google. The
  `state` sent to the provider has to come back to the browser that set the
  matching cookie, works once, and runs out after 10 minutes.
- Sign-ins under way, and outside accounts waiting to be linked, are kept in
  memory: a restart in the middle of one means starting it again.
- The links are in the `linked_logins` table: the provider, its own id for the
  person, the account, and the name and e-mail address it gave when linked
  (shown on the account page).

## Trying it without an OAuth app

`test/fixtures/oauth-fake.js` is a stand-in for all four providers, which signs
whoever it's told straight in and checks what a real provider checks (client ID
and secret, redirect URI, PKCE, a code used once):

```sh
node test/fixtures/oauth-fake.js 8102
```

Point each provider at it in the settings file, and use client ID `test-client`
and secret `test-secret`:

```json
"auth": {
  "providerEndpoints": {
    "google": {
      "authorize": "http://127.0.0.1:8102/google/authorize",
      "token": "http://127.0.0.1:8102/google/token",
      "userinfo": "http://127.0.0.1:8102/google/userinfo"
    }
  }
}
```

It signs in Alice A (id `1001`, alice@example.com) unless a POST to
`/<provider>/next` with `{"id": ..., "name": ..., "email": ...}` (or
`{"deny": true}`, to cancel at the provider) says otherwise.
