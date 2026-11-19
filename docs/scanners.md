# Scanners: a Uniden SDS150 (or SDS100, SDS200) through radiocli

A Uniden SDS scanner doesn't connect to AirScribe the way the handhelds do.
Its USB cable carries commands but no sound, and its Bluetooth sends audio only
to Uniden's own app. [radiocli](https://github.com/albeebe/radiocli) handles it
instead:
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

## Setting it up

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

## What the uploader does

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

## What AirScribe keeps

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

## The API

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

## Tested

Against recordings and `.json` files made in the tests, in radiocli's
documented format:
- the API: a P25 talkgroup's details kept and searchable, a recording sent
  twice kept once, and each refusal;
- the uploader, run against a test server: sending, filing away, leaving a
  half-written recording, refusing a bad one, stopping on an unknown id, and
  signing in by account or by token.

Not yet with radiocli itself or a real scanner.
