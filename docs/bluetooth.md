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

**Codec.** SBC, 32 kHz, mono, 16 blocks, 8 subbands, loudness allocation —
all four read straight out of a real stream's SBC header and confirmed.
**Received audio is bitpool 18**, giving 44-byte frames of 128 samples, which
is 4 ms each. Upstream's encoder uses bitpool 40 when transmitting, so the two
directions differ; read the bitpool from the stream rather than assuming
either.

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

## Verified against a real UV-Pro

Checked on 2026-09-21 against a BTech UV-Pro (firmware 0.8.12, 30 channels)
from a Windows VM with a USB Bluetooth adapter passed through, using
[tools/probe-radio.ps1](../tools/probe-radio.ps1). Everything below is
observed, not read from someone else's source.

**The BS AOC service UUID is right.** A paired UV-Pro exposes
`{39144315-32FA-40DB-85ED-FBFEBA2D86E6}`, named `BS AOC` in its own SDP
record. This is what `sidecar/btinfo.py` keys on to tell a radio from a
headset.

**The radio can appear as more than one Bluetooth device.** The unit tested
had two bonds, `38:D2:00:01:56:21` and `38:D2:00:01:56:51` — 0x30 apart, not
adjacent — each exposing its own copy of the services. This is presumably the
"pair two devices in quick succession" quirk upstream documents.

Worth knowing before you rely on it: when that host was later re-paired from
scratch, **only `...:51` came back**, and it alone carried the control and
audio services this project needs. So treat the second bond as something that
may appear rather than something to require, and do not compute one address
from the other.

**Services exposed per device:** SPP `0x1101` (control), HFP `0x111F`, and
the BS AOC vendor service (audio). Windows binds the first two to inbox
drivers and leaves BS AOC without one, which is correct — an RFCOMM service
is reached by socket, not through a driver.

**GAIA framing is exactly as described above.** `GET_DEV_INFO` (group 2,
command 4) sent as `FF 01 00 00 00 02 00 04` returned
`FF 01 00 05 00 02 80 04 00 00 01 00 8C`: the `payload + 8 + checksum` length
rule holds, the flags byte was 0 (no checksum), and the response carried the
request's command number with `0x8000` set.

**The HT status bit layout is confirmed.** `GET_HT_STATUS` (command 20)
returned `00-02-80-14-00-82-01-00-80`, which decodes through the reference
parser's offsets as power on, scanning, squelch closed, not receiving, not
transmitting, RSSI 0 — an idle handheld hearing nothing. **These are the
`is_in_rx` and `is_sq` bits the segmenter uses as its fallback signal**, so
that path is now known to be reading real fields rather than a guess.

The radio also reports `is_aoc_connected`, which was false throughout: the
audio channel is a separate RFCOMM connection that nothing had opened.

**The link must be up before an RFCOMM connect will work.** From cold, a raw
RFCOMM connect to the radio fails with "destination host was down" or simply
times out; once the link is established it connects in about 0.1 s. On Windows
opening the SPP COM port is enough to bring it up. **This is why the Linux
backend must call BlueZ's `Connect()` on the device before opening any
socket** — HTCommander's Linux code does exactly that, and now the reason is
clear rather than incidental.

**Channel numbers on the unit tested** were SPP/control on **4** and BS AOC
audio on **2**. These are per-device and must still be resolved through SDP —
do not hardcode them. Two things make them findable: the control channel
collides with the Windows SPP COM port, and **the audio channel identifies
itself**, because opening it flips `is_aoc_connected` in the HT status. That
second trick needs no audio and no SDP, and is what
[tools/probe-aoc.py](../tools/probe-aoc.py) uses.

**Python can open RFCOMM on Windows.** `socket.AF_BLUETOOTH` with
`BTPROTO_RFCOMM` and an `(mac, channel)` address works on Windows CPython, so
a Windows backend for the sidecar is feasible. Only RFCOMM is exposed, though
— `BTPROTO_L2CAP`, `BTPROTO_HCI` and `BTPROTO_SCO` are all absent — and there
is no SDP lookup, which is the real gap.

**Audio only flows when the radio has audio.** With the radio idle and
scanning, the AOC channel stays completely silent: 0 bytes over a 20 s
capture, with every status poll reporting `is_in_rx=False, is_sq=False,
rssi=0`. The channel being open is not enough; the squelch has to open.

**The audio stream parses, and the run markers are real.** A 45 s capture of
a scanned emergency group returned 248 kB and 799 frames, which
`sidecar/htframe.py` decoded without complaint: 796 audio frames (`0x00`) and
**three `0x01` end-of-audio markers**, one per transmission, carrying 2.0 s,
5.7 s and 14.5 s of audio. Status polls taken during the capture tracked it,
reporting `is_in_rx` and `is_sq` true with RSSI 6-10 while each station was
on the air and zero between them.

That is the segmentation design confirmed on the air rather than in theory:
the radio does bracket each transmission, and this project's own codec reads
those brackets. See [segmentation.md](segmentation.md#confirmed-against-a-real-radio).

**A note on the transport used.** These queries went over the SPP service as
a Windows COM port, not a raw RFCOMM socket, which is a convenient shortcut on
Windows but not what the Linux backend will do. The GAIA bytes on the wire are
the same either way, which is why the result transfers.

## Confirmed again on Linux

Pairing a UV-Pro to Ubuntu 24.04 with BlueZ (adapter `E0:D3:62:64:43:1D`)
resolved these services on `38:D2:00:01:56:51`:

| UUID | What |
| --- | --- |
| `00001101-…` | Serial Port (SPP) — the control channel |
| `0000111f-…` | Handsfree Audio Gateway |
| `00001200-…` | PnP Information |
| `000088a1-…` | vendor, purpose unknown |
| `39144315-32fa-40db-85ed-fbfeba2d86e6` | **BS AOC** — the audio channel |

Two details that matter for detection:

**Before pairing, the advertisement carries only `000088a1` and `0000111f`.**
BS AOC appears only once SDP has been resolved, which happens at pairing. So
keying on BS AOC — which is what `sidecar/btinfo.py` does — identifies
*paired* radios, and that is the right scope, because `bluetoothctl devices`
lists known devices. An unpaired radio would have to be recognised by
`000088a1` instead, if discovery of strangers is ever wanted.

**`Modalias: bluetooth:v000Ap0002d0003`** names Bluetooth SIG vendor `0x000A`
— CSR — which is why the control protocol is GAIA, CSR's own. It matches the
`VID&0001000A_PID&0002` seen on Windows, so both hosts agree.

The device class is `0x00200404`, an audio/video wearable headset, so BlueZ
shows it with a headset icon. That is cosmetic, not a sign it is being treated
as a plain headset.

Dropping the link immediately after pairing (`disconnected with reason 3`) is
normal — the bond is stored, and the link is re-established on demand.

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

The `info` output should list `39144315-32fa-40db-85ed-fbfeba2d86e6` (see
above — confirmed present on real hardware). That is what `scan` keys on, and
seeing it confirms the pairing the audio channel depends on. `sdptool browse
<MAC>` then shows the RFCOMM channel numbers the next step has to resolve
programmatically. The radio may present more than one bond; pair whatever
`scan on` actually shows rather than deriving an address.

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
