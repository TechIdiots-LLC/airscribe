# Changelog

## master
### ✨ Features and improvements
- _...Add new stuff here..._
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
- **`tools/probe-bumble.py`:** reaches a radio through Bumble, a Bluetooth stack in Python that drives a USB dongle
  directly, to find out whether the radio link can work on Windows and in a container without the system's
  Bluetooth.

### 🐞 Bug fixes
- _...Add new stuff here..._
- Upgrading a database from before transcripts had their own table no longer drops a finished transcript that
  didn't record which engine made it; it's kept as `unknown`.
