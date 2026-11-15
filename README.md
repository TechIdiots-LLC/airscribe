# AirScribe

*Writes down what is on the air.*

A web front end for Bluetooth handheld radios. A server pairs with the radios,
listens to each one, splits the audio into one clip per transmission using the
radio's own start/end-of-audio markers, transcribes every clip, and shows the
text with audio and text downloads in a browser.

Rebuilt from the web/voice work in an HTCommander fork as a server-side
application, because browsers can only reach a radio's Bluetooth LE control
channel, not the Classic Bluetooth audio channel that transcription needs.

```sh
npm install
npm run simulate        # fake radio + mock transcriber, no hardware needed
# then open http://127.0.0.1:8100 , Scan, Add, Connect
```

## Status

| Piece | State |
| --- | --- |
| Web UI: radios, live status, transcript feed, search, downloads | working (against the simulator) |
| Segmenting audio into one clip per transmission | working; replaying a real 3-transmission capture yields 3 clips |
| Pluggable transcription: sherpa-onnx, whisper.cpp (per clip or a warm whisper-server), any command, mock | working; not yet run against a real model |
| Intel GPU transcription through OpenVINO or whisper.cpp's Vulkan backend | OpenVINO working on an Arc A750 from a Proxmox container; whisper.cpp with Vulkan not yet run on a GPU |
| Proxmox LXC template and .deb, built and boot-tested by GitLab CI | working |
| Radios from an LXC container: the `bumble` backend, a USB dongle without the system's Bluetooth | working: in an unprivileged Proxmox container it connected to a real UV-Pro and recorded its transmissions, see [docs/proxmox.md](docs/proxmox.md) |
| Admin → Updates: install a newer release from the browser | working against local releases; see [docs/updating.md](docs/updating.md) |
| Radio registry, keyed by MAC, HTCommander model table | working |
| Python sidecar protocol + simulator | working, tested end to end |
| Real radio link (BlueZ RFCOMM control + SBC audio) | working — connects, decodes audio and disconnects cleanly against a real UV-Pro |
| Protocol assumptions (service UUID, GAIA framing, status bits, SBC parameters) | confirmed against a real UV-Pro — see [docs/bluetooth.md](docs/bluetooth.md#verified-against-a-real-uv-pro) |
| Audio frame codec (`sidecar/htframe.py`) | parses a real 248 kB / 799-frame capture, end markers included |
| Feed: paging, search, channel filter, Play new, cleanup; Insights; Map of channels | working (checked in a browser against simulated radios and seeded data) |
| Accounts, roles and invite links; sign-ins kept across restarts | working (checked in a browser), see [docs/accounts.md](docs/accounts.md) |
| Signing in with Google, GitHub, Discord or Facebook, once linked | working against a stand-in provider; not yet against the real ones, see [docs/linked-logins.md](docs/linked-logins.md) |
| Map → Find: a channel's place from RadioReference and the FCC licence | working against a stand-in for RadioReference's API; not yet with a real account, see [docs/radioreference.md](docs/radioreference.md) |
| Public page, delayed publishing, RSS | design only, see [docs/publishing.md](docs/publishing.md) |
| Digital modes (AFSK/IRC/file transfer) | design only, see [docs/digital-modes.md](docs/digital-modes.md) |

Documentation: [installing](docs/installing.md) · [accounts](docs/accounts.md) ·
[linked sign-ins](docs/linked-logins.md) · [Proxmox template](docs/proxmox.md) ·
[updating](docs/updating.md) · [testing](docs/testing.md) ·
[publishing](docs/publishing.md) ·
[segmentation](docs/segmentation.md) ·
[transcription](docs/transcription.md) · [Bluetooth link](docs/bluetooth.md) ·
[finding channels](docs/radioreference.md) · [digital modes](docs/digital-modes.md)

Developed against a **BTech UV-Pro**, which is also BenLink's original target
and the best-tested model upstream.

Tests: `npm test` (44 Node tests) and `npm run test:py` (13 Python tests).
The store and API tests need Node 22.5+ (`node:sqlite`) and report as skipped
on older Node. Neither suite needs a radio or a speech model.

## Requirements

- Node 22.13+ or 24
- Python 3 on the same host as the radios
- Ubuntu 22.04 / 24.04 with BlueZ for real radios (Windows can run the
  simulator; the Windows Bluetooth backend is not planned yet)
- `ffmpeg` with the SBC decoder, to turn the radio's audio into PCM
- For transcription: `pip install sherpa-onnx` and a model — see
  [docs/transcription.md](docs/transcription.md). whisper.cpp and any
  transcript-printing command also work, and OpenVINO or whisper.cpp built
  with Vulkan runs on an Intel GPU.

## Configuration

Copy [airscribe.config.json.sample](airscribe.config.json.sample) and pass it with
`--config`. The server binds to `127.0.0.1`; binding anywhere reachable is
refused unless `auth.tokens` is set (send `Authorization: Bearer <token>`, or
open the page with `?token=<token>`).

## Layout

- `src/` Node server: `api.js` routes, `manager.js` pipeline, `segmenter.js`,
  `stt/` engines, `store.js` SQLite, `sidecar.js` child-process client,
  `models.js` radio table
- `sidecar/` Python helpers (JSON lines on stdio): the Bluetooth backend, the
  sherpa-onnx transcription worker, the audio frame codec, and their tests
- `public/` the web UI (no build step)
- `tools/` diagnostics — `bringup-linux.sh` checks an Ubuntu host is ready and
  browses a radio's SDP; `probe-radio.ps1` sends read-only GAIA queries over
  Bluetooth SPP; `probe-aoc.py` finds the BS AOC audio channel and captures its
  frames through the project's own codec

## License

Apache-2.0, matching HTCommander, so code can move between the projects
freely. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## Credits

The radio protocol comes from the work of Kyle Husmann (KC3SLD) and the
[BenLink](https://github.com/khusmann/benlink) project, via
[HTCommander](https://github.com/Ylianst/HTCommander) by Ylian Saint-Hilaire.
See [NOTICE.md](NOTICE.md). An amateur radio licence is required to transmit.

The Map's Find uses the [RadioReference.com](https://www.radioreference.com)
database through its web service, with the user's own Premium account; data
courtesy of RadioReference.com.
