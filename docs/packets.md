# Packets: APRS, and the radios' own location sharing

Packets reach AirScribe two ways, and either is enough:

- **The radio's own modem.** These radios have a packet modem (a TNC). It
  decodes AFSK 1200 packets on the channel the radio is listening to, APRS
  among them, and the BSS packets these radios send each other (messages, and
  a shared location). Each comes to AirScribe over the Bluetooth control link:
  as a notification, the way HTCommander gets them, or as a KISS frame on the
  same link, the way APRSdroid and TAK-UV-CORE do.
- **AirScribe, from the audio.** AirScribe runs a 1200-baud AFSK modem of its
  own (`src/afsk.js`) on everything a radio plays, so an APRS packet the radio
  can be heard receiving is decoded whether or not the radio's modem hands it
  over. It can't read BSS packets, whose format isn't known beyond what the
  radio's modem reports.

AirScribe keeps each packet, shows it in **Packets**, puts a station with a
place on the **Map**, and shows it with the transmission it came in.

Nothing is transmitted: this only listens.

## Setting it up

Put a radio, or its second channel with dual watch on, on the APRS frequency:
**144.390 MHz** in North America (144.800 in Europe). A radio scanning voice
channels decodes a packet only on a channel it stops on.

Set the radio's squelch (**Controls → Squelch**) so it stays closed when
nothing is there. With the squelch opening on noise the radio records a
steady run of hiss: the feed fills with transmissions marked **static**,
seconds long and back to back, and there's nothing in them to decode. A
packet sounds like a short buzzy burst, not hiss. Hiss that keeps coming with
a signal reading of several bars can also be local noise (a USB charger, a
computer close by) rather than the squelch; unplugging the radio's charger is
a quick test.

At connect AirScribe asks the radio to report its status changes (as
HTCommander does). A packet the radio's modem decodes then arrives as a
notification (DATA_RXD), in numbered fragments that are put back together.
The control link is the radio's serial port service, which also works as a
KISS TNC (that's what APRSdroid and TAK-UV-CORE connect to), so a packet may
instead come as a KISS frame between the replies: FEND, a type byte (0 for
data), the AX.25 frame with FEND and FESC escaped, FEND. AirScribe reads both
as the status poll reads the control channel, within about a second, and
skips any bytes that start neither, so a frame can't put the replies after it
out of step. (Before, a KISS frame there was read as a broken reply, and
could leave the next few replies unreadable, enough to have the radio taken
for gone.)

## Two decoders

Each packet in **Packets** says what decoded it: **the radio**, **AirScribe**
or **both**. The two usually both get a strong packet; the same packet from
the second one isn't kept again, and marks the one kept as decoded by both.
The log says each as it comes, and every packet from the radio's modem even
when AirScribe kept it first:

```
[packet] 38:D2:00:01:56:51: N1HLD-9>APRS,WIDE1-1:!4221.06N/07151.78W>090/035 Mobile (decoded by AirScribe)
[packet] 38:D2:00:01:56:51: N1HLD-9>APRS,WIDE1-1:!4221.06N/07151.78W>090/035 Mobile (from the radio's modem as KISS, already kept)
```

"As KISS" or "as a notification" says which way the radio's modem sent it.

AirScribe's modem reads a radio's receive audio as it arrives, and not what
the radio transmits. It works much as software TNCs do: the audio is
band-passed (800 to 2600 Hz) and brought down to 16 kHz, each tone's
strength is measured over a bit or so, a phase-locked clock samples the
difference mid-bit, and NRZI, bit stuffing and HDLC framing are undone. A
frame counts only when its check sequence (CRC-16) is right. Radios rarely
play the two tones equally loud (de-emphasis takes a few dB off 2200 Hz, and
some senders pre-emphasize), so two demodulators run side by side with five
slicers each, weighing the tones differently, and one more each that evens
them out; whichever gets a frame, it's handed on once. On synthesized packets
with white noise in the 300 to 3000 Hz band it decoded all of them at a
signal-to-noise ratio of 8 dB, nine in ten at 7 dB and about half at 6 dB;
with the tones 9 dB apart either way and 12 dB of signal to noise, nearly
all; with the bit rate 1% off, nine in ten or more at 8 dB. It costs a few
percent of one core per radio while the radio is receiving.

If the radio mutes the speaker while its own modem decodes a packet (the
radios' settings have a "digital mute"), the audio carries nothing to decode,
and only the radio's modem gets it.

## What's decoded

APRS (after the APRS 1.01 spec, checked against the test packets of
Ham::APRS::FAP), and the radios' BSS packets:

| Kind | What's shown |
| --- | --- |
| Positions: plain, compressed, Mic-E, NMEA | where, the station's symbol, course and speed, altitude, its comment; a Mic-E status ("En route") |
| Weather | temperature, wind and gusts, humidity, pressure, rain |
| Objects and items | placed by name; one taken away leaves the map |
| Messages | to whom, the text; acknowledgements and bulletins |
| Status, telemetry, third-party | the text, or the packet inside |
| BSS | a message, a shared location, a request for a station's location, a ring |

The BSS location isn't documented; it's read as the radio reports its own GPS
(24-bit signed minutes x 500, latitude then longitude, then altitude and
heading), which places the documentation's example near Portland, Oregon,
from a 7-area callsign.

A digipeater's copy of a packet heard in the last 30 seconds isn't kept again.
Packets are kept for 30 days.

## Where they show

- **Packets** (in the header): every packet, newest first, as they come in,
  by kind and by station or words, each with what decoded it and how it was
  received (the frame as text, and its bytes). A station with a place opens
  on the Map.
- **Map → Stations**: each station's (or object's) latest place within the
  hours chosen, with its symbol; a popup with what it last said, how fast and
  how high, its weather, and which radio heard it, by which digipeaters. A
  packet with a place moves its station live, with a flash.
- **The feed**: a transmission a packet came in shows what the packet said. A
  short one (2.5 seconds or less) that was only the packet is marked
  **packet** and isn't transcribed: a burst of data gives a speech model
  nothing but noise to make words of. It counts as no speech. A longer one,
  voice with a packet after it (these radios can send their position on
  letting go of the talk button), is transcribed and shows both. A short
  transmission waits a second and a half for the modem's notice before it's
  transcribed.

## Your profile, and a radio's beacon

**Your account → Amateur radio** keeps your callsign, the SSID you use (by
APRS custom, -7 for a handheld, -9 mobile), your symbol and a beacon message.
Your own stations, any SSID, are marked on the Map ("you").

A radio's **Controls → Beacon and location sharing** shows what the radio
sends of itself (its "BSS settings", read from it): its callsign and SSID,
symbol, message, whether it goes as APRS or only to radios like it (BSS),
whether it shares its location (every few minutes) and whether it sends its
position after each transmission. **Use my profile** fills in the callsign,
SSID, symbol and message from your profile, as APRS; **Save to radio** writes
what's on the form. Only the fields changed are written, over the block the
radio keeps, and the radio is read again to check it took them.

Sharing its location makes the radio transmit, on its own and after you talk,
as that callsign: only with your licence. The radio sends its beacons only
while its position is asked for (HTCommander's protocol notes), so when its
settings have it share its location AirScribe asks for its position: at
connect, and after saving. Where the radio sends them is its own business
(HTCommander has it send APRS on a channel named APRS). The position it then
reports moves the radio on the Map as it comes.


| Request | Gives |
| --- | --- |
| `GET /api/packets?limit=&before=&kind=&q=&mac=` | packets, newest first; `kind` is positions, weather, messages, status, bss or other |
| `GET /api/stations?hours=&mac=` | each station's latest packet with a place, with `heard` and `first_heard` |
| `GET /api/stations/:who?hours=` | a station's `track` and its latest packets |
| `PUT /api/account/radio` | `{callsign, ssid, symbol, beacon}`: your profile; no callsign clears it |
| `GET /api/radios/:mac/aprs` | a radio's beacon settings (admins) |
| `PUT /api/radios/:mac/aprs` | change some (`callsign`, `ssid`, `symbol`, `beacon`, `format`, `share_location`, `share_interval` in seconds, `ptt_send_location`), or `{profile: true}` to fill them in from yours (admins) |

Anyone signed in may read them, as the feed. Open pages get each packet as an
event (`packet`) on the event stream.

## Tested

The decoders against FAP's test packets and HTCommander's BSS examples; the
fragments put back together, and KISS frames among the replies (escaped
bytes, junk between them, the tail of one whose start was missed), against a
stand-in for the radio's control channel; AirScribe's modem against packets from a separate modulator in the
tests (noise, the tones 6 dB apart, the bit rate 1% off, 8 to 48 kHz audio,
audio in pieces of any size), and against two of a UV-Pro's real static
clips, in which it rightly found nothing; the pages against the simulator
(`--simulate`), whose radio's modem decodes a packet after every other
transmission. Not yet on a real radio: whether a UV-Pro sends packets to
AirScribe unasked, and AirScribe's modem on a real packet's audio, are the
things to see, with one tuned to 144.390 and its squelch closed on noise.
