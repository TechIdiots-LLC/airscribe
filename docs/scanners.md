# Scanners: a Uniden SDS150 over Bluetooth, or an SDS150, SDS100 or SDS200 through radiocli

An SDS150 can reach AirScribe two ways:
- **over Bluetooth**, as Uniden's U/AWARE app reaches it, with no cable or sound
  card (below);
- **through radiocli**, over USB and its headphone socket, which works for the
  SDS100 and SDS200 as well ([radiocli](#through-radiocli)).

## Over Bluetooth (SDS150)

Needs the `bumble` backend (docs/proxmox.md), as the scanner speaks only
Bluetooth Low Energy.

1. On the scanner: **Menu → Settings → Bluetooth Options → Set Bluetooth
   Function → Enable**.
2. **Radios → Scan for radios.** It's listed as `SDS150:` and its serial
   number; **Add** it (model *SDS150 (Bluetooth)*).
3. The first time, put the scanner in **Bluetooth Options → Pairing**, then
   **Connect**. It pairs without a PIN. After that, Connect needs nothing on
   the scanner.

The scanner talks to one device at a time: close U/AWARE on the phone first.
Its card shows what it's on. Each transmission is filed under the channel (or
talkgroup) and frequency it names, with its system and department as details,
then transcribed. It has no Controls or Channels, as a radio does; it has
**Screen** instead.

### Its screen, keys and waterfall

**Screen** on a connected scanner's card (admins) opens it as U/AWARE shows it:
- **The screen:** its text, line by line, with highlighting as the scanner
  draws it (reversed or underlined). The scanner draws its icons and large
  digits in its own font, so those show as marks; the waterfall's frequency is
  spelled out under the screen instead.
- **Soft keys:** the three under the screen, named from its bottom line.
- **The keypad:** Menu, Func, the digits, **.** (no) and **E** (yes), and the
  knob as ◀ ▶. Scrolling on the screen turns the knob too. A key is held as long
  as it's held on the page (up to 3 s), as the scanner tells a press from a long
  one.
- **Waterfall:** the scanner's 240-column spectrum, newest at the top, with
  its span and marker. Put the scanner in its waterfall mode to see one.
  AirScribe only asks for it while it's showing, 15 s at a time.

Keys with dashed borders (Avoid, Push, Vol, Sql, Replay, Service and the soft
keys) use Uniden's codes from its other scanners and haven't been tried on an
SDS150 yet. If one does the wrong thing, say which.

**If it hangs up while pairing, every time:** a pairing that got halfway (the
scanner kept it, AirScribe didn't) makes it turn away each new one. On the
scanner, **Bluetooth Options → Reset Pairings**, then **Pairing**, and connect
again. That clears its other pairings too, so a phone pairs again afterwards.

**If it won't stay connected:** after **Reset Pairings** on the scanner, the
pairing AirScribe kept is refused, and the scanner hangs up about 0.3 s later.
AirScribe forgets that pairing when it happens, so put the scanner back in
**Pairing** and connect again. A phone that kept its old pairing does the same
until it's unpaired in Android's Bluetooth settings; removing it in U/AWARE
isn't enough.

### How it works

Worked out from a capture of U/AWARE and an SDS150 (Android's HCI snoop log);
the app wasn't taken apart. `sidecar/sds.py` has the details:
- **The link:** the scanner advertises from a static random address. It pairs
  "Just Works" (LE Secure Connections). Its vendor service has one
  characteristic that notifies and takes writes without response, and
  everything goes through it.
- **Link timing:** AirScribe connects at a 15 ms interval with a 4 s
  supervision timeout, which is what the scanner asks a phone for. A few seconds
  in, it asks AirScribe for 30-50 ms and 420 ms. Granted as asked, the link
  dropped within 1.5 s, and at 50 ms a third of the audio was lost, so its
  request is granted no slower and no shorter than that. The journal shows
  both as `[bumble]` lines.
- **Addresses:** AirScribe connects from the dongle's public address, the
  identity it gives when pairing. From the random one, the scanner found its
  pairing on only some connections.
- **Frames, both ways:** `09 50 54`, a 2-byte length, the payload, and a
  2-byte sum of the payload's bytes.
- **Commands:** the remote command spec's, as over USB, each in a frame. The
  app sends:
  - `GST` (Get Status) every 200 ms. Its reply is the screen: each line's
    text and highlighting, which lines are large, the LEDs, mute, and in
    waterfall mode the span and marker (frequencies in 100 Hz steps).
    AirScribe does the same between transmissions. During one it sends `GST`
    once a second and `KAL` (Keep Alive, which has no reply) on the other
    polls: the screen is a fifth of what a Bluetooth 4.0 dongle carries, and
    without that, audio was lost.
  - `KEY,<code>,H` then `KEY,<code>,R` for a button: pressed, then let go. The
    knob, `<` or `>`, is `R` alone.
  - `GW2,1,ON` every 300 ms while its waterfall is shown. The reply is 240
    bytes of levels.
- **Replies come in pieces:** a flag byte before each, `0x01` on the first and
  `0x80` set on the last, so `0x81` is a whole one. A screen is usually two.
- **What the scanner sends:**
  - its system and channel as a transmission starts;
  - the audio, as Opus packets (wideband CELT, 20 ms, about 24 kbit/s);
  - a line with system, department, channel, frequency and talkgroup just
    after it ends.
- **Transmissions:** the scanner's squelch decides them, since audio comes
  only while it's open. AirScribe ends one after 0.6 s without audio and
  decodes it with ffmpeg.

**Tested:**
- the framing against bytes from the capture;
- decoding of real captured audio (it sounded right);
- a fake scanner on Bumble's virtual controller: connecting, polling,
  transmissions, keys, the waterfall, drops, reconnecting;
- reading the screen, and putting replies back together, against replies like
  the capture's;
- the page, with the simulator's pretend SDS150: its screen, a key pressed,
  scrolling as the knob, the waterfall, a phone's width.

- a real SDS150 through a CSR8510 (Bluetooth 4.0) dongle: pairing,
  reconnecting, the screen, and transmissions whose audio matched a UV-PRO's
  copy of the same call, with no gaps heard.

The keys and waterfall haven't been tried on the real scanner yet. The vendor
service's UUID isn't known, since the phone used its cached copy, so AirScribe
picks the characteristic by what it does.

## Through radiocli

Its USB cable carries commands but no sound.
[radiocli](https://github.com/albeebe/radiocli) handles it:
- it reads what the scanner is receiving over USB;
- it records the headphone socket through a sound input;
- it writes one WAV per transmission, with a `.json` beside it saying what the
  scanner said it was: system, department, channel, frequency, talkgroup,
  unit, P25 NAC, digital or analog.

AirScribe takes those recordings in. `tools/radiocli-upload.mjs` watches the
folder radiocli writes to and sends each recording to AirScribe, where it
becomes a transmission like a radio's:
- filed under the scanner's channel (or talkgroup) name and frequency;
- measured for static;
- transcribed;
- shown in the feed with its talkgroup, unit and digital mode;
- searchable by any of those.

radiocli is a separate, young project (MIT). Its author has run it only on an
SDS150 at firmware 1.00.37, from macOS. Its Linux and Windows builds haven't
met a scanner yet.

### Setting it up

1. **In AirScribe:** **Radios → Add a scanner**, pick the model and name it.
   Its card's **How to send** shows the command for step 3, with this
   scanner's id. A scanner has no Bluetooth address, so AirScribe makes up an
   id shaped like one, starting `02:`.
2. **On the computer the scanner is plugged into** (USB, and its headphone
   socket into a sound input): install radiocli and record.
   ```
   radiocli daemon --device <scanner port> --audio "<sound input>"
   radiocli audio record --device <scanner port> recordings
   ```
   The SDS100 and SDS150 headphone sockets can put the audio out of phase on
   the two sides, and a stereo cable mixed down to mono then cancels it. On
   the SDS150, set **Menu → Settings → Headphone L/R output → In Phase**;
   otherwise radiocli's `--channel auto` (the default) finds the right side. Its file name
   template, `--hang` and `--max-duration` don't matter to AirScribe.
3. **Next to radiocli:** copy `tools/radiocli-upload.mjs` from AirScribe
   (it needs only Node 22 or later) and run it on the same folder:
   ```
   node radiocli-upload.mjs --server http://<airscribe>:8100 --radio <scanner id> --user <name> recordings
   ```
   It signs in as an account that may manage radios, with the password from
   `AIRSCRIBE_PASSWORD` or asked for once. Instead of `--user`, set
   `AIRSCRIBE_TOKEN` to a token from the settings file's `auth.tokens`.

The computer can be the AirScribe host itself (the scanner's USB and the
sound input passed through to the container, as the Bluetooth dongle is), or
any other on the network.

### What the uploader does

- **What it sends:** every WAV in the folder (and the folders radiocli makes in
  it) whose `.json` is there too. It waits until both have been still for two
  seconds, since radiocli writes the `.json` last. It looks again every 5
  seconds (`--every`); `--once` makes one pass and exits.
- **What it does with each:**
  - **Taken:** moved to `uploaded/`, keeping radiocli's folders. With
    `--delete` it's deleted instead.
  - **Refused** (not a 16-bit mono WAV, a `.json` that isn't one): moved to
    `rejected/`, with the reason in a `.error.txt` beside it.
  - **AirScribe can't be reached, or has an error:** left in place, and tried
    again on the next pass.
- **When it stops:** if signing in fails or the scanner's id isn't known, it
  says so and stops, since waiting won't fix either.
- **Sent twice:** a recording sent again (the same scanner, the same start) is
  kept once. AirScribe answers with the transmission it already has.

### What AirScribe keeps

| From radiocli's `.json` | Becomes |
| --- | --- |
| `start` | when it started; without one, its length back from when it arrived |
| `channel`, else `talkgroup` ("TG 1201"), else `department`, else `frequency` | the channel it's filed under: the feed's channel filter, Insights, the Map |
| `frequency` ("851.012500MHz") | its frequency |
| `list`, `system`, `department`, `site`, `talkgroup`, `unit`, `nac`, `digital`, `modulation`, `rssi` | its details: talkgroup, unit and digital mode shown in the feed, the rest on hover; all searchable |

**Audio:** kept as recorded (48 kHz). A 16 kHz copy goes to the speech
models.

**Signal and static:** the scanner's signal reading is on another scale than
the handhelds' 0 to 15, so it stays in the details. It isn't used for the
**weak** tag. Static is measured from the audio as for any transmission;
radiocli's level normalising doesn't change that measure.

**Not handled yet:** the radios' packet decoding doesn't run on recordings.

### The API

`POST /api/radios/:id/recordings`, by an admin account or a token:
- **Body:** the WAV.
- **Header `X-Radiocli`:** the `.json`, base64-encoded (a header carries only
  ASCII).
- **Answers:**
  - `201 {id, duplicate: false}` when it's new.
  - `200 {id, duplicate: true}` when it was sent before.
  - `400` when it isn't a 16-bit mono WAV, has no `.json`, or the radio isn't
    a scanner.
  - `404` for an unknown id.
- **Size:** up to 64 MB, which is about 11 minutes at 48 kHz.

`POST /api/radios` with `{"model": "sds150", "name": "..."}` and no `mac`
adds a scanner and answers with its id. Connect and Disconnect are refused
for one.

### Tested

Against recordings and `.json` files made in the tests, in radiocli's
documented format:
- the API: a P25 talkgroup's details kept and searchable, a recording sent
  twice kept once, and each refusal;
- the uploader, run against a test server: sending, filing away, leaving a
  half-written recording, refusing a bad one, stopping on an unknown id, and
  signing in by account or by token.

Not yet with radiocli itself or a real scanner.
