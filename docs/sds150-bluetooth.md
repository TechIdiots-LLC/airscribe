# The SDS150 over Bluetooth LE

Uniden's SDS150 talks to its U/AWARE phone app over Bluetooth Low Energy:
audio, what it is on, its screen and keys, and its waterfall. Uniden doesn't
document this link. This page describes it fully enough to write your own
client.

AirScribe's client is `sidecar/sds.py` (frames, commands, audio) and
`sidecar/bumble_link.py` (pairing and the link, through Bumble). It runs on a
real SDS150 through a CSR8510 (Bluetooth 4.0) USB dongle, and its audio
matches a radio's recording of the same call.

**How this was learned.** From Bluetooth traffic only: Android HCI snoop logs
of U/AWARE talking to a scanner, and Bumble's own logs of AirScribe doing it.
The app wasn't decompiled; its licence forbids that.

**Firmware.** The scanner's firmware version wasn't recorded. A later version
may differ. If something here doesn't match yours, compare it with a capture
(see [Capturing it yourself](#capturing-it-yourself)).

## At a glance

| | |
|---|---|
| Radio | Bluetooth LE only. No Classic and no A2DP: it doesn't play as headphones |
| Name | `SDS150:` and its serial number |
| Address | static random |
| Pairing | Just Works, LE Secure Connections, only from its Pairing menu |
| Centrals | one at a time |
| GATT | one vendor service with one characteristic; everything goes through it |
| Framing | `09 50 54`, length, payload, 16-bit sum, both ways |
| Commands | Uniden's remote command spec (as over USB), wrapped in frames |
| Polling | `GST` every 200 ms; its reply is the screen |
| Audio | Opus (CELT, wideband, 20 ms, mono), one packet per frame, while its squelch is open |
| Labels | system and channel as a transmission starts; system, department, channel, frequency and talkgroup when it ends |

Uniden's remote command spec, which the commands come from:
[SDS100/SDS200/SDS150 Remote Command Specification V2.00](https://info.uniden.com/twiki/pub/UnidenMan4/SDS100FirmwareUpdate/SDS_Series_RemoteCommand_Specification_V2_00.pdf).

## Finding it and pairing

**Turning Bluetooth on:** **Menu → Settings → Bluetooth Options → Set
Bluetooth Function → Enable**. It then advertises as `SDS150:<serial>` from a
static random address.

**Pairing only works from its Pairing menu** (**Bluetooth Options →
Pairing**). Anywhere else, it hangs up about 0.1 s after a pairing request.
Once paired, connecting needs nothing on the scanner.

**What pairing looks like:**
- It is NoInputNoOutput, so pairing is Just Works over LE Secure Connections.
  Its pairing response asks the central for its identity key only, and gives
  no keys of its own.
- It sends a Security Request on every connection, paired or not.
- When encryption starts, it goes quiet for longer than Bumble's default 720 ms
  supervision timeout allows. Use 4 s, which is what it asks a phone for. See
  [Link timing](#link-timing).

**It talks to one central at a time.** Close U/AWARE, or turn the phone's
Bluetooth off, before connecting anything else.

**Identity address:** pairing gives the scanner your identity address, and
that address must be the one you connect from. AirScribe connects from the
dongle's public address, which is the identity Bumble gives by default, as
BlueZ does. When it connected from its random address but gave the public one
as its identity, the scanner found the pairing on only some connections. On
the others it timed out (0x08) while encrypting. Phones use a resolvable
private address with a real IRK, which also works.

**Reset Pairings** (**Bluetooth Options → Reset Pairings**) clears every bond
on the scanner. After it:
- A central that tries its old key gets a Security Request and a hang-up
  (0x13) about 0.3 s later. Forget that key and pair again.
- A phone that kept its old key loops like that until it's unpaired in
  Android's Bluetooth settings. Removing the scanner in U/AWARE isn't enough.

**Half-finished pairings:** if pairing completes on the scanner but not on
the central, the scanner keeps a bond the central doesn't have. It then turns
away every new pairing. Reset Pairings clears it.

**A lost link isn't a refused key.** If the link drops while encrypting
(0x08, a timeout), keep the key: the scanner still has its side. Forgetting it
there leaves the scanner with a bond the central no longer has, which turns
away every new pairing. Forget the key only if the scanner hangs up (0x13) or
reports the key missing (0x06) or refused (0x05).

## Link timing

**What the scanner asks for.** Its L2CAP Connection Parameter Update requests:

| Central | It asked for | Timing |
|---|---|---|
| Android phone | 15 ms interval, latency 0, 4 s supervision timeout | after the phone set its own 30-50 ms |
| AirScribe (Bumble) | 30-50 ms interval, latency 0, **420 ms** timeout | 3-5 s after connecting |

**What happened when it was granted as asked** (420 ms at 50 ms):
- On a Bluetooth 4.0 dongle, every link timed out (0x08) within 1.5 s.
- With only the 4 s timeout kept, the 50 ms interval lost about a third of the
  audio.

**What AirScribe does:** it connects at 15 ms and 4 s, and grants any later
request no slower than 15 ms and no shorter than 4 s. The scanner has accepted
that.

**What the phone negotiated:**
- 2M PHY both ways;
- 251-byte LL packets (Data Length Extension);
- an ATT MTU of 517 (the scanner asks for 495).

A Bluetooth 4.0 dongle has none of the first two: 1M PHY and 27-byte LL
packets. See [Throughput](#throughput).

## GATT

From AirScribe's own service discovery. The handles are the ones seen, and may
not hold for every scanner, so look them up by UUID.

| Handles | What |
|---|---|
| 0x0001-0x0008 | Generic Attribute (0x1801): Service Changed (0x2A05), Client Supported Features (0x2B29), Database Hash (0x2B2A) |
| 0x0009-0x000F | Generic Access (0x1800): Device Name (0x2A00), Appearance (0x2A01), Peripheral Preferred Connection Parameters (0x2A04) |
| 0x0010-0x0013 | **Vendor service `3a5b9d10-f2ec-4f5c-bb2e-2f1a8d98a0a6`** |
| 0x0012 | **Characteristic `ab8c17d4-c1c5-4c91-8c56-7d01954c471e`**: read, write without response, notify |
| 0x0013 | its CCCD: write `01 00` to turn notifications on |

**How a client uses it:**
- Write your frames to 0x0012 without response.
- The scanner's frames come back as notifications on 0x0012.
- Nothing else is used.

**The scanner also searches the phone** for the same service,
`3a5b9d10-…`. It gets "not found" from a phone, and that's fine.

## Frames

Both directions use the same envelope:

```
09 50 54 | length (2, big-endian) | payload (length bytes) | checksum (2, big-endian)
```

The checksum is the sum of the payload's bytes, kept to 16 bits. The magic
and the length aren't counted.

**A client's payload** (to the scanner):

```
seq (2) | ack (2) | type (1) | data length (2) | data
```

- **`seq`:** the client's own count, starting at 0 and going up by 1 each
  frame.
- **`ack`:** the last `seq` heard from the scanner, or `FF FF` before anything
  has been heard.

**The scanner's payload** (to the client):

```
seq (2) | type (1) | data length (2) | data
```

- **No ack field.**
- **Its `seq` isn't contiguous.** It went up by 5 between ticks with nothing
  in between, so don't use it to count losses. Audio has its own counter.

**How frames arrive:**
- A frame may be cut across notifications, and one notification may hold
  several frames.
- Keep a buffer, find `09 50 54`, wait for the length, and check the sum. If
  the sum is wrong, drop a byte and search again.

**Worked example:** the client's first `GST`:

```
09 50 54  00 0c  00 00  ff ff  c0  00 05  81 47 53 54 0d  04 3f
magic     len 12 seq 0  ack -  C0  len 5  0x81 "GST\r"    sum
```

The sum is `00+00+ff+ff+c0+00+05+81+47+53+54+0d` = `0x043f`.

### Frame types

| Type | Way | What |
|---|---|---|
| `C0` | both | a command, or its reply: a flag byte, then text (see below) |
| `A0` | scanner | a transmission starts: `System,Channel` |
| `A1` | scanner | audio: a counter byte, then one Opus packet |
| `A2` | scanner | a transmission has ended: `System,Department,Channel, frequency,talkgroup,…` |
| `AF` | scanner | a one-byte tick, sent all the time, even when idle |

**The `AF` tick** comes several times a second. Its byte steps by 5 each time
(mod 256). Its meaning is unknown. It's a useful sign that the link is alive.

## Commands

A command is a `C0` frame whose data is `0x81`, then the command text, then
`\r`. The text is Uniden's remote command spec, as over USB.

### What the app sends

- **`GST` every 200 ms.**
  - Its reply is the screen, so this is how the app shows it.
  - It also carries the app's ack.
  - Audio comes without any other command.
- **`KEY,<code>,H` on a button's press, then `KEY,<code>,R` on its release.**
  - The scanner tells a press from a long press by the time between them.
  - The knob, and the app's arrow buttons, send `KEY,<,R` or `KEY,>,R` alone,
    with no `H`.
  - Each reply is `KEY,OK`.
- **`GW2,1,ON` every 300 ms while the waterfall is shown.** The reply is
  `GW2,` + 240 bytes of FFT levels + `\r`.

### What AirScribe adds

**`KAL`** (Keep Alive). The spec says it has no reply, and the scanner sent
none. During a transmission on a link of 27-byte packets, AirScribe sends
`GST` once a second and `KAL` on the other four polls. With 251-byte packets
it keeps sending `GST` every 200 ms.
- **The ack still goes out every 200 ms**, as the app's does.
- **Without the screen replies, there's room for the audio.** See
  [Throughput](#throughput).

Audio kept coming like that, so the scanner doesn't need `GST` at 5 Hz to
send it. Whether it needs any poll at all isn't known.

### Replies come in pieces

A reply's data starts with a flag byte:

| Flag | Piece |
|---|---|
| `0x81` | a whole reply, in one piece |
| `0x01` | the first piece of a longer one |
| `0x82` | its last piece |

Bit `0x01` marks the first piece and `0x80` the last. Join the pieces' text
in order. No reply longer than two pieces was seen. A long screen is usually
two.

Example, `KEY,OK` in one piece:

```
09 50 54  00 0d  00 9b  c0  00 08  81 4b 45 59 2c 4f 4b 0d  03 a0
                 seq    C0  len 8  whole "KEY,OK\r"
```

## The screen: `GST`

The reply is comma-separated (spec, GST):

```
GST,<DSP_FORM>,<line 1>,<mode 1>,<line 2>,<mode 2>,…,<MUTE>,<LED1>,<LED2>,<WF_MODE>,<FREQ>,<MOD>,<MF_POS>,<CF>,<LOWER>,<UPPER>,<COLOR_MODE>,<FFT_SIZE>
```

**`DSP_FORM`:** one digit per line, `1` for a line in the large font. There
are as many line/mode pairs as there are digits.

**Each line** is its text, then a mode string the same length:
- `*` marks a reversed character;
- `_` marks an underlined one;
- a space marks a plain one.

**Text** is Latin-1. Codes from 0x80 up, and below 0x20, are glyphs in the
scanner's own font: icons, and large digits drawn from pairs of codes (large
"9" = `f6 f7` over `fe ff`, for example). They have no Unicode equivalents.

**The fields after the lines:**

| Field | What |
|---|---|
| `MUTE` | `1` muted (squelch closed), `0` open |
| `LED1`, `LED2` | the alert LED and the charge LED |
| `WF_MODE` | `0` normal, `1` waterfall, `2` menu |
| `FREQ` | the waterfall's frequency, 8 digits in 100 Hz (`01011000` is 101.1 MHz) |
| `MOD` | modulation, e.g. `FMB` |
| `MF_POS` | the marker's column, 0-239 |
| `CF`, `LOWER`, `UPPER` | the span's centre and edges, 100 Hz units |
| `COLOR_MODE`, `FFT_SIZE` | as the spec has them |

The `FREQ` to `UPPER` fields are filled in only in waterfall mode.

**A real reply,** from the screen it shows straight after pairing (one
piece, flag `0x81`):

```
GST,1111111111,,,,,Bluetooth pairing       ,,completed               ,,,,,,,,Press Any Key           ,,,,,,1,0,0,,,,,,,,0,
```

## Keys

| Code | Key | Seen from the app |
|---|---|---|
| `M` | Menu | yes |
| `F` | Func | yes |
| `E` | E / yes / enter | yes |
| `.` | . / no | yes |
| `0`-`9` | digits | yes |
| `Z` | seen, not yet matched to a button | yes |
| `<`, `>` | knob left, right (`R` only) | yes |
| `L`, `^`, `V`, `Q`, `Y`, `A`, `B`, `C`, `T` | Avoid, Push, Vol, Sql, Replay, and the soft keys, as Uniden's other scanners take them | no: untried on an SDS150 |

The spec's key table is an image, so codes not seen in traffic are guesses.

## The waterfall

With the scanner in waterfall mode, `GW2,1,ON` returns 240 bytes of levels,
one per column, left to right. The app asks every 300 ms while the waterfall
is showing, and stops when it isn't. `GST`'s tail gives the span and the
marker that go with it.

## Audio

**Each `A1` frame** is a one-byte counter, then one Opus packet:

```
09 50 54  00 68  00 aa  a1  00 63  8a  b8 7d f0 1b 40 08 99 …
                 seq    A1  len 99 ctr Opus (98 bytes)
```

**The Opus packets:**
- **TOC `0xB8`:** config 23, which is CELT-only, wideband, 20 ms, mono, one
  frame per packet.
- **Size:** 50-100 bytes seen (variable bitrate).
- **Rate:** 50 packets a second while audio flows.
- **Silence:** `b8 ff fe` is its silent packet. It sends a few as a
  transmission starts.

**The counter** goes up by 1 per packet (mod 256). A jump means packets were
lost on the link.
- To keep the timing, put a silent packet where each lost one was.
- Don't fill a jump of more than a second's worth: it's more likely a new
  transmission than a loss.

**Decoding:** wrap the packets in an Ogg Opus stream, then decode it as any
Opus file (ffmpeg, libopus):
- `OpusHead`: version 1, 1 channel, pre-skip 0, 48000 Hz, mapping 0;
- one packet per page, the granule position going up 960 per packet.

`sds.ogg_opus()` builds it.

### Transmissions

**The scanner's squelch decides them:** audio comes only while it's open.
1. `A0` comes with the first audio packet, a moment before or after it.
2. `A2` comes about 0.2 s after the last.

AirScribe ends a transmission after 0.6 s without audio.

**Examples:**
- **`A0`:** `Springfield,Fire Dispatch`
- **`A2`:** `Springfield,Town of Springfield,Fire Dispatch, 154.250000MHz,,3`. The fields
  are system, department, channel, frequency (as the scanner writes it), and
  the talkgroup (empty here, a conventional channel). The last field's meaning
  is unknown.

## Throughput

**Audio alone needs about 200 LL packets a second on a Bluetooth 4.0 link.**
Each 60-110 byte audio frame, with its ATT and L2CAP headers, is 3-5 of those
27-byte packets. On top of that:
- the `GST` replies: 130-240 bytes each, five a second;
- the ticks.

At 15 ms there are 66 connection events a second, so the link must carry 3-4
packets an event.

**What was measured on a CSR8510:**

| Setup | Audio lost |
|---|---|
| 50 ms interval | about a third |
| 15 ms interval | about 16% |
| 15 ms, `KAL` in place of most `GST` during audio | no gaps heard |

**A Bluetooth 5 dongle** (2M PHY, 251-byte packets) carries several times
more, as the phone's link does: an audio frame fits in one packet. AirScribe
asks for both after pairing, when the dongle has them
([proxmox.md](proxmox.md#which-dongle) has one that works with Bumble).

**What was measured on a TP-Link UB500** (RTL8761B, Bluetooth 5.0): the link
came up with 251-byte packets both ways and 2M before pairing, without
AirScribe asking. With `GST` once a second during audio, three transmissions
of 4-7 s arrived with no frame missing.

## A session, start to finish

1. Scan for `SDS150:`; connect at 15 ms with a 4 s supervision timeout.
2. Pair (Just Works, Secure Connections) the first time, with the scanner in
   its Pairing menu. After that, encrypt with the kept key.
3. Exchange MTU, discover the services, find characteristic
   `ab8c17d4-…`, and write `01 00` to its CCCD.
4. Every 200 ms, send a `GST` frame with `seq` counting up and `ack` the
   scanner's last `seq`. Read the notifications as frames.
5. On `A1`, collect audio. On `A0` and `A2`, label it. When the audio stops,
   decode it.
6. If the scanner asks for slower link parameters, hold 15 ms and 4 s.
7. If nothing at all comes for a few seconds (no `AF` ticks either), the link
   is gone. Reconnect.

## Not known

- **Whether audio needs any poll at all.** It keeps coming with `GST` once a
  second and `KAL` between.
- **What the `AF` tick's byte means,** and why the scanner's `seq` skips.
- **The last field of `A2`.**
- **Most key codes,** beyond those the app was seen sending.
- **Other commands over this link,** beyond `GST`, `KEY`, `GW2` and `KAL`.
  The rest of the remote command spec probably works, but is untried.

## Capturing it yourself

**From a phone (Android):**
1. In **Developer options**, turn on **Bluetooth HCI snoop log** (full, not
   filtered). Restart the phone so it takes effect.
2. Use U/AWARE.
3. Run `adb bugreport` and find `btsnoop_hci.log` inside it. On a Samsung it's
   under `FS/data/log/bt/`.
4. Open it in Wireshark.

**From AirScribe (Bumble):** run the sidecar with
`BUMBLE_SNOOPER=btsnoop:file:/path/hci.log`. It's written when the process
stops.

**What to look for:**
- ATT writes to and notifications on handle 0x0012, which are the frames;
- L2CAP signalling, which is where the parameter requests are;
- SMP, the pairing.

**Keep captures to yourself.** A capture holds what the scanner was on, and
its serial number is in its name.
