# Updating AirScribe

**Admin → Updates** shows the version running, any newer release with its notes, and an **Update to …** button. It
works for installs from the `.deb`, which includes the Proxmox template. An install from a git checkout is updated
as it was installed (`git pull`, `npm ci`).

The Admin button appears in the header for an admin (a password sign-in, or a token with the admin role). AirScribe
looks for new releases a minute after it starts, every 12 hours after that, and when you press **Check now**.
Settings, radios, transcripts and clips are kept. The server restarts, so the radios disconnect and reconnect, and
whatever is transmitted in that minute or so is missed.

The first release with Admin → Updates has to be installed by hand ([Proxmox](proxmox.md#updating)). After that,
Admin can update it.

## What happens

AirScribe runs as an account that can't install software, so the update is done by a small updater that can:
`/usr/lib/airscribe/airscribe-update`, as root, started by `airscribe-update.path` when AirScribe writes
`/var/lib/airscribe/update/request`. It is MediaRiffle's updater, adapted.

AirScribe only tells the updater which version you picked. The updater:

1. Refuses any version that isn't newer than the one installed.
2. Downloads that release's `.deb` and its `SHA256SUMS` from the project's own address on GitLab, never one the
   request names, and checks the one against the other.
3. Downloads the installed version's `.deb` too, to go back to.
4. Stops AirScribe, which releases the radios cleanly, saves a copy of its database, and installs the new version
   with `apt-get`, which keeps `/etc/airscribe/airscribe.config.json` and fetches any new dependency.
5. Waits up to three minutes for the new version to start and say so. If it doesn't, it puts the database back and
   reinstalls the old version.

Admin shows each step while it happens, and the page reloads once the new version answers. The updater's log is
`/var/log/airscribe-update.log`.

## Settings

In the `updates` section of the config file:

| Setting | Meaning |
| --- | --- |
| `updates.checkHours` | How often to look for a release. `0` looks only when you press **Check now**. 12 by default. |
| `updates.prereleases` | `true` to be offered pre-releases (`0.2.0-rc.1`) too. `false` by default. |

## When it doesn't work

- **"Waiting for the updater to start" stays.** The updater isn't watching: `systemctl status airscribe-update.path`
  should be active; `systemctl enable --now airscribe-update.path` if not.
- **"Couldn't read the releases".** The container can't reach gitlab.techidiots.net, or the project's releases
  aren't public.
- **"has no … with checksums to update from".** That release was published without `SHA256SUMS`. Install it by hand.
- **It went back to the old version.** The log says why; the release notes may say what the new version needs.

A snapshot before an update is still a good idea for a container (`pct snapshot`).
