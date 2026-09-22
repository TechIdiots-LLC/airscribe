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
| Pluggable transcription: sherpa-onnx, whisper.cpp, any command, mock | working; not yet run against a real model |
| Radio registry, keyed by MAC, HTCommander model table | working |
| Python sidecar protocol + simulator | working, tested end to end |
| Real radio link (BlueZ RFCOMM control + SBC audio) | working — connects, decodes audio and disconnects cleanly against a real UV-Pro |
| Protocol assumptions (service UUID, GAIA framing, status bits, SBC parameters) | confirmed against a real UV-Pro — see [docs/bluetooth.md](docs/bluetooth.md#verified-against-a-real-uv-pro) |
| Audio frame codec (`sidecar/htframe.py`) | parses a real 248 kB / 799-frame capture, end markers included |
| Digital modes (AFSK/IRC/file transfer) | design only, see [docs/digital-modes.md](docs/digital-modes.md) |

Documentation: [installing](docs/installing.md) · [testing](docs/testing.md) ·
[segmentation](docs/segmentation.md) ·
[transcription](docs/transcription.md) · [Bluetooth link](docs/bluetooth.md) ·
[digital modes](docs/digital-modes.md)

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
  transcript-printing command also work.

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
