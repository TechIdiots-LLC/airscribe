# Packets: APRS, and the radios' own location sharing

These radios have a packet modem of their own (a TNC). It decodes AFSK 1200
packets on the channel the radio is listening to, APRS among them, and the BSS
packets these radios send each other (messages, and a shared location). Each
packet comes to AirScribe over the Bluetooth control link, the way HTCommander
gets them, and AirScribe keeps it, shows it in **Packets**, puts a station
with a place on the **Map**, and shows it with the transmission it came in.

Nothing is transmitted: this only listens.

## Setting it up

Put a radio, or its second channel with dual watch on, on the APRS frequency:
**144.390 MHz** in North America (144.800 in Europe). That's all. A radio
scanning voice channels decodes a packet only on a channel it stops on.

At connect AirScribe asks the radio to report its status changes (as
HTCommander does). A packet the modem decodes then arrives as a notification
(DATA_RXD), in numbered fragments that are put back together, and is read as
the status poll reads the control channel, within about a second.

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
  by kind and by station or words, each with how it was received (the frame
  as text, and its bytes). A station with a place opens on the Map.
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
| `GET /api/radios/:mac/beacon` | a radio's beacon settings (admins) |
| `PUT /api/radios/:mac/beacon` | change some (`callsign`, `ssid`, `symbol`, `beacon`, `format`, `share_location`, `share_interval` in seconds, `ptt_send_location`), or `{profile: true}` to fill them in from yours (admins) |

Anyone signed in may read them, as the feed. Open pages get each packet as an
event (`packet`) on the event stream.

## Tested

The decoders against FAP's test packets and HTCommander's BSS examples; the
fragments put back together against a stand-in for the radio's control
channel; the pages against the simulator (`--simulate`), whose radio's modem
decodes a packet after every other transmission. Not yet on a real radio:
whether a UV-Pro sends packets to AirScribe unasked is the first thing to see,
with one tuned to 144.390.
