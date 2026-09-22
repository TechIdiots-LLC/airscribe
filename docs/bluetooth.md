# Bluetooth link

## Why a Python sidecar

The radio's audio is Classic Bluetooth (RFCOMM), which Node cannot open and
browsers cannot reach. Python's standard library can: `socket.AF_BLUETOOTH` with
`BTPROTO_RFCOMM` is built in on Linux, so the transport needs no third-party
packages. The Node side only sees JSON lines (`src/sidecar.js`), so the backend
can be replaced without touching it.

## What the radio exposes

Taken from HTCommander upstream `main` (Dart), chiefly
`src/linux/runner/bluetooth_classic_plugin.cc`, `src/lib/radio/audio_engine.dart`
and `src/lib/radio/gaia_protocol.dart`. This corrects an earlier version of this
page that was written from the older C# code.

**Recognising a radio.** A device is a compatible radio when BlueZ lists the
vendor service `39144315-32fa-40db-85ed-fbfeba2d86e6` ("BS AOC") in its `UUIDs`.
This is what `sidecar/btinfo.py` checks, and it replaces name matching.

**Two RFCOMM channels, both found through SDP:**

| Channel | Service | Carries |
| --- | --- | --- |
| Control | Serial Port, `0x1101` | GAIA-framed commands and status |
| Audio | vendor BS AOC UUID above; falls back to Generic Audio `0x1203` on models without it | SBC audio |

The channel number differs per radio and must be looked up with an SDP query
(the reference does this in C with `libbluetooth`; from Python, `sdptool browse`
or BlueZ's D-Bus `Device1` are the options, not yet tried).

**Control framing (GAIA).** `FF 01 <flags> <len> <group_hi group_lo cmd_hi cmd_lo> <data>`.
`len` is the data length, `flags & 1` says a checksum byte follows, total frame
length is `len + 8 + checksum`. Command and group numbers are in
`gaia_protocol.dart`; the older `web/radio.js` in the HTCommander fork has the
same tables. The status packet carries the receive/squelch flags and RSSI.

**Audio framing.** `0x7E <cmd> <payload> 0x7E`, with `0x7D`/`0x7E` in the
payload sent as `0x7D, byte ^ 0x20`. `sidecar/htframe.py` implements and tests
this. Commands received: `0x00`/`0x03` audio, `0x01` end of audio, `0x02` ack,
`0x09` the radio echoing audio it is itself transmitting. To transmit, send
`escape(0x00, sbc_frame)`; to stop, send `7E 01 00 01 00 00 00 00 00 00 7E`.

**Codec.** SBC, 32 kHz, mono, 16 blocks, 8 subbands, loudness allocation. The
sender uses bitpool 40; one upstream analysis document assumes bitpool 18
(44-byte frames), so read the bitpool from the stream rather than assuming.

**Pairing.** Do it once with `bluetoothctl` or the desktop UI. Upstream's
[Paring.md](https://github.com/Ylianst/HTCommander/blob/main/docs/Paring.md)
notes that two Bluetooth devices must be paired in quick succession.

## Segmenting: the radio's own audio boundaries

The radio brackets each transmission itself: audio frames (`0x00`/`0x03`) begin
a run and a `0x01` frame ends it, and `0x09` marks audio the radio is itself
transmitting. This is the boundary to trust, and it is what
[src/segmenter.js](../src/segmenter.js) is built around — see
[segmentation.md](segmentation.md).

**A backend must therefore emit `audio-start` and `audio-end` around each run**,
with `transmit: true` for a `0x09` run. Squelch and energy remain a fallback,
never the primary signal.

## The UV-Pro

This project is developed against a **BTech UV-Pro**, the radio BenLink was
originally written for and the best-tested model upstream, so it is the one to
trust when the reference code branches per model. Nothing below is UV-Pro
specific — the service UUIDs and framing are shared across the supported
radios — but the UV-Pro is what any of it has actually been checked against.

First steps on the Ubuntu host, before any of this code can work:

```sh
bluetoothctl                     # scan on / pair / trust — two devices, in quick succession
bluetoothctl info <MAC> | grep -i uuid
```

The `info` output should list `39144315-32fa-40db-85ed-fbfeba2d86e6`. That is
what `scan` keys on, and seeing it confirms the pairing that the audio channel
depends on. `sdptool browse <MAC>` then shows the RFCOMM channel numbers the
next step has to resolve programmatically.

## What is not written yet

`BluezBackend.connect()` still raises "not implemented". Remaining:

1. SDP lookup of the two channel numbers.
2. Open both sockets, run `FrameReader`, decode SBC to PCM (`libsbc1` through
   `ctypes` is the likely route; upstream has a pure-Dart SBC decoder in
   `src/lib/sbc/` to check against).
3. Read enough GAIA status to report connection state and RSSI.

None of this can be validated without a radio, which is why the simulator was
built first: it exercises everything downstream of these items.

## Sidecar protocol

Requests `{"id", "cmd": "scan"|"connect"|"disconnect"|"ping", "mac"?}`; replies
`{"id", "ok", "result"|"error"}`. `scan` returns `{mac, name, radio}` rows.
Events:

- `{"event":"status","mac","state":"connected"|"disconnected","rssi"?}`
- `{"event":"audio-start","mac","transmit":bool}` — the radio opened a run
- `{"event":"audio","mac","rx":bool,"transmit":bool,"pcm":"<base64 s16le 32 kHz mono>"}`
- `{"event":"audio-end","mac"}` — the radio closed the run

Audio arrives as ~100 ms chunks. A backend that cannot produce the run markers
may send `audio` alone; segmentation then falls back to squelch and energy, and
is correspondingly worse at telling two quick transmissions apart.
