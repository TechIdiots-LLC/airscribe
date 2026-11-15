# Changelog

## master
### ✨ Features and improvements
- _...Add new stuff here..._
- **`bumble` Bluetooth backend:** reaches radios through a USB dongle that Bumble drives directly, for an LXC
  container, where the system's Bluetooth can't work, and in time Windows. The radio handling is the BlueZ backend's,
  unchanged; only the Bluetooth underneath differs. Set `sidecar.backend` to `bumble`, `sidecar.python` to a Python
  with Bumble, and `sidecar.transport` to the dongle (docs/proxmox.md). In an unprivileged Proxmox container it
  connected to a UV-Pro, read its battery and channel names, and recorded its transmissions; one dongle served two
  UV-Pros at once.
- **`tools/probe-bumble.py` in a container:** in an unprivileged Proxmox container it paired with a UV-Pro, found
  its channels and captured its audio (docs/bluetooth.md; docs/proxmox.md has the steps). A capture is also saved
  as raw SBC, which ffmpeg turns into a WAV, and a dongle or channel that won't open says why.
- **Rename a radio:** a Rename button on each radio, so two of the same model, which scan in with the same name, can
  be told apart. The feed, the radio filter and exports show the new name, past transmissions included.
- **The feed pages, and searches everything:** 50 transmissions at a time with **Load older** and a count ("Showing
  50 of 1,234"). The search box and the radio filter ask the server, so they cover the whole history rather than
  the rows that happened to be loaded, and Export takes everything they match. A transmission arriving or being
  transcribed redraws only its own row, so a clip being played isn't stopped by another arriving.
- **Map:** a view with each channel where an admin placed it (Place, then click the map; drag to move). A channel
  lights up while one of the radios is receiving on it and pulses when its transmission has been saved; its popup
  shows what it said lately and opens the feed on it. Base maps are MapLibre styles (`map.styles`), by default the
  colour-relief, dark colour-relief and OpenStreetMap styles from tiles.wifidb.net; a dark browser starts on the dark
  one, and the choice is remembered. MapLibre GL JS 6 is served by AirScribe itself (public/vendor).
- **Insights:** a view beside the feed, for the last day, week, month or everything, for one radio or channel:
  a word cloud of what was said (common English words and a model's own annotations such as "(static)" left out;
  unit and call numbers kept), transmissions per hour or day, busy hours by weekday, and each channel's
  transmissions and airtime. A word or a channel opens the feed on it. The header now switches between Feed,
  Insights and Admin.
- **Play new, and a channel filter:** the feed can be filtered to one channel (every channel heard is listed, with
  its frequency), and **Play new** plays each transmission that joins the feed as it arrives, one after another, so
  the filters decide what is heard: one radio, one channel, a search, no chirps. A clip plays once its transmission
  has ended and been saved, not live; playing another clip by hand pauses it, and the queue waits.
- **Cleanup:** **Hide no speech** in the feed leaves out transmissions shown as "(no speech recognised)", such as a
  radio's chirp; it's remembered per browser, and Export follows it. An admin can **Delete** a transmission from its
  row, with its transcripts and audio. **Admin → Storage** shows how much is kept, deletes by age and/or no speech
  after showing what would go, and can keep only the last N days automatically (off until set). A transcription
  queued or running for a deleted clip saves nothing.
- **Transcription on the GPU, confirmed:** the `openvino` engine runs on an Arc A750 from an unprivileged Proxmox
  container, with Ubuntu 24.04's own Intel compute runtime; docs/proxmox.md has the steps as they were run.
- **Template:** new containers have the `en_US.UTF-8` locale, so `pct enter` no longer brings locale warnings to
  every apt command, and the login message says to run `apt update` before the first `apt install`.

### 🐞 Bug fixes
- _...Add new stuff here..._
- **Signing in has its own page.** The sign-in form no longer sits above radios and transmissions that can't be used
  yet; it covers the page until it's done, asks for a username only when one is set and for an API token where only
  tokens are, and a Sign out button joins the header.
- A radio that stopped answering is reconnected by the server's retry, instead of the retry finding the dead link and
  doing nothing.
- Admin → Updates no longer offers a CI or local build (`0.1.0+ci…`) the release it was built on, which would have
  been a step back; the updater refused it anyway.
- Changing the password with `tools/configure.mjs` as root no longer leaves the settings file unreadable to the
  service.

## 0.1.0
### ✨ Features and improvements
- **Proxmox LXC template and a .deb:** each release carries `AirScribe-v<version>-proxmox-amd64.tar.zst`, Proxmox's
  Ubuntu 24.04 template with Node 24 and AirScribe installed, and `airscribe_<version>-1_all.deb` for Ubuntu 24.04
  and Debian 12. A new container sets its port and a sign-in password at its first boot, from
  `/etc/airscribe/firstboot.env` or made for it and left in `/root/airscribe-first-login.txt`
  (docs/proxmox.md). Releases are built, boot-tested and published by GitLab CI.
- **Admin → Updates:** an admin sees the version running and any newer release with its notes, and can update to
  it from the browser. A root-only updater downloads the release's .deb, checks it against the release's
  `SHA256SUMS`, installs it with the database saved, and puts the old version back if the new one doesn't start
  (docs/updating.md). Installs from the .deb and the Proxmox template only.
- **Transcription on an Intel GPU:** the `openvino` engine runs Whisper and SenseVoice through OpenVINO GenAI on an
  Intel Arc card, and moves to the CPU, saying so in the log, when the GPU won't load the model
  (docs/transcription.md).
- **`whisper-server` engine:** runs whisper.cpp's server, which loads the model once and keeps it, instead of
  whisper-cli for every clip. With whisper.cpp built for Vulkan, it is the second way onto an Intel GPU, through
  Mesa's driver rather than Intel's runtime (docs/transcription.md).
- **`tools/probe-bumble.py`:** reaches a radio through Bumble, a Bluetooth stack in Python that drives a USB dongle
  directly, to find out whether the radio link can work on Windows and in a container without the system's
  Bluetooth.

### 🐞 Bug fixes
- Upgrading a database from before transcripts had their own table no longer drops a finished transcript that
  didn't record which engine made it; it's kept as `unknown`.
