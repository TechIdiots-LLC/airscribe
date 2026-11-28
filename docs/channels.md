# A radio's channels: reading, writing and backups

**Channels** on a connected radio (admins only) shows every slot of one region
as the radio has it: name, receive and transmit frequency, tones, FM or AM and
its bandwidth, whether it transmits, and whether it's scanned. The region
picker reads another region; the radio is moved there to read it and back
again afterwards.

## How many channels

A UV-Pro holds 30 channels in each region, and has six regions: 180 in all.
The dialog says how many the radio reports ("3 of 30 channels programmed").
The radio scans the region it's on, so it listens to at most those 30 at once
(two, with dual watch on and scan off).

## Changing them

The list is edited in place, and nothing reaches the radio until **Write to
radio**:

- **Scan:** each channel's box. Unticked, the radio skips the channel when it
  scans: the way to stop listening to a channel without removing it.
- **Tone:** a ham channel listening with no tone shows the tone Uniden's
  database lists for it (its nearest listing), as **use 114.8**, or **static?
  use 114.8** when its Heard column says static. It sets the receive tone, and
  the transmit tone if the channel transmits and has none. Many repeaters send
  their access tone too, so listening only with it keeps out noise and other
  users. A repeater that doesn't send it goes silent: **Undo**, or Edit it back.
- **Edit:** the channel's name, receive frequency, mode (FM narrow, FM wide,
  AM), receive tone, and transmit (off, the same frequency, or another, with its
  tone and power).
- **Remove:** empties the slot when written. **Undo** takes back a change.
- **Add channels…:** **Stations near me** (RadioReference's listings for the
  county, see
  [radioreference.md](radioreference.md#stations-near-me-writing-listings-to-a-radio))
  **From Uniden's database** ([below](#from-unidens-database)),
  or **By hand**. Each goes into the first free slot, receive-only unless it's
  in a ham band, and a name already in the region gets a number at the end.

Changes not written yet are highlighted and counted above the list; **Discard**
drops them, and switching region or closing asks first. **Write to radio**
reads the region, backs it up, and writes every change at once. A change to a
channel writes only the fields that changed, over the channel's record as the
radio has it, so the rest of it (bits AirScribe doesn't model included) is
kept: turning scan off changes one bit. A change that didn't take stays in the
list, to write again.

## From Uniden's database

With Uniden's database imported (Admin → Uniden's database, the SDS150's HPDB),
**Add channels… → From Uniden's database** lists the conventional frequencies it
has within 5 to 100 miles of home that the radio can receive (the airband in AM,
136–174 and 400–520 MHz), nearest first: the name, its group and county, the
tone, the mode, and what it would be written with. A frequency listed in several
counties is listed once, at its nearest.

- **Services.** Tick the services to list: police, fire, EMS and hospitals,
  multi-agency and interop, public works and utilities, ham, aircraft, railroad,
  business, schools, federal and military, other. Each says how many near home
  the radio can play. The service is the database's own (its service tag, as
  RadioReference numbers them); a frequency without one goes by its name, and
  else under other. What's ticked is kept for each radio, with your account.
- **What's written.** Anything but a ham frequency is written receive-only, with
  its tone as the receive tone, so the squelch opens only for its users. One
  whose mode isn't listed (AUTO) is written as narrow FM, as licensees below
  512 MHz have had to be since 2013, or AM in the airband, and says so.
- **Ham.** The database gives what a repeater sends, its mode and tone, not its
  input. A repeater is written to transmit on the US band plan's usual offset
  (2 m: 145.1–145.5 and 146.61–146.97 MHz down 600 kHz, 147.0–147.39 up
  600 kHz; 70 cm: 442–445 MHz up 5 MHz, 447–450 down 5 MHz) with the listed tone
  as its transmit tone, and no receive tone, so it's heard whatever it sends
  (if that's mostly static, see **Tone** under [Changing them](#changing-them)).
  Anything else is simplex; a ham frequency with no listed mode is wide FM. Some
  areas pair repeaters the other way: check a repeater's offset against a
  repeater directory before transmitting through it.
- **What can't be.** Trunked systems aren't listed: the radio can't follow one.
  Digital channels (P25, DMR, NXDN) are counted beside each service and hidden;
  **Show ones the radio can't play** lists them, greyed out.
- **What's there already.** A frequency on the region already, or in the list
  to write, is greyed out, with the channel it's on.
- **Filling a region.** Tick the ones you want, or **Fill the region with the
  nearest**, which ticks the nearest that can be written, as the filter shows
  them, until the region is full (30 a region on a UV-Pro, as the radio says).
  Then **Write to radio**, which backs the region up first; **Put them on the
  map** places each at its group's place.
- **Home** is RadioReference's ZIP code, or else the middle of the channels
  placed on the map; without either, every one is listed.
- A database imported before modes and tones were kept has none: import it
  again.

What the database has depends on the county: it's RadioReference's data, which
lists some areas' channels more fully than others'.

## Trying channels

Listed near you isn't the same as heard here: a channel twenty miles off may be
out of reach, and one in reach may only ever open the squelch on noise.
**Try channels…** finds out on the radio before you keep them.

- **What's tried.** The nearest frequencies from Uniden's database, of the
  services ticked and within the distance chosen, that this radio hasn't tried
  before and doesn't have on its own region (the region on show when you start).
  Digital ones are left out.
- **Where.** A spare region you pick. What's on it is backed up first, then
  written over a region's worth at a time (30 on a UV-Pro), each channel
  listened to only, with its tone, whatever it is. When every candidate has been
  tried, or you stop, the region is put back as it was.
- **The schedule.** The radio listens to the trial region for some minutes
  (20 by default), then its own region (40), and so on, so it keeps hearing its
  own channels. Own region 0 keeps it on the trial. It's never moved while
  something's coming in.
- **How long.** Each batch is graded after the hours set (6 by default, so 2 of
  listening on the default schedule), waiting up to ten minutes more for
  transcripts still to come. **Grade now and try the next** does it early.
  A police or fire channel can be quiet for an hour, so a short batch calls
  good channels quiet.
- **Grading.** By frequency, from what came in on it on this radio while it was
  in the batch:
  - **good**: words (two or more, from the main engine, not static) more than
    once, or once with no more than one static opening;
  - **some words**: words, but mostly static: a weak or distant station;
  - **static**: the squelch opened on noise (under 6 dB of quieting, as the
    Heard column judges it), or three times and never with words;
  - **quiet**: nothing, or too little to tell.

  A channel that opens on static four times with no words has its scan turned
  off on the radio, so it stops holding up the rest of the batch.
- **Tone squelch.** A ham repeater that came to static or some words is tried
  again in a later batch listening only with its tone (marked **with tone**). If
  it sends its tone, the noise stays out and the words come through; kept, it's
  written with the tone both ways. Both results are listed.
- **Keeping them.** **Tried on this radio** lists every frequency tried, good
  first, with its last words. Tick one to add it to the region on show, as it
  was found (a ham repeater with its band plan input and tone), then **Write to
  radio**. The database tab marks what each one came to. **Try again** forgets a
  frequency's result so the next trial takes it; **Forget them all** forgets
  every one.
- **The feed.** What comes in on a trial channel is a transmission like any
  other, under the channel's name, so it can be listened to; each is put on the
  map at its group's place unless its name is placed already.

The radio has to stay connected for a trial to move it. One out of reach is
tried again every 30 seconds, and the error shows above the batch.

## How each channel came through: static and weak

The **Heard** column counts each channel's transmissions on this radio in the
last week, by the name the radio gives it, and tags it:

- **static**: most of it was noise. A station out of range, or a channel with
  no tone whose squelch opens on noise, fills the feed with hiss.
- **weak**: the radio's signal reading was low.

Untick **Scan** to have the radio skip a channel like that, or remove it.
Hovering over the count shows the numbers behind the tag.

Two things are measured for each transmission as it comes in:

- **The signal reading:** the strongest of the radio's own readings (0 to 15)
  while the transmission came in, from the status it reports every second.
- **Quieting:** how far the transmission's loud moments stood above its quiet
  ones, in dB, over 20 ms frames (the loudest tenth over the quietest tenth).
  A strong FM signal is near silent between words, 20 dB and more. A weak one
  is hiss between words, a few dB to the low teens. Static that opened the
  squelch is hiss throughout, a few dB.

A transmission that stood under 6 dB above its quiet moments is **static**
(81 seconds of it from a 2 m repeater channel measured 2.1 dB). It's marked
**static** in the feed, with its transcript dimmed: Whisper writes sentences
into hiss ("So, we're going to be doing this."). It counts as no speech
whatever a model wrote, so **Hide no speech** hides it and a cleanup of no
speech deletes it, and its words are left out of Insights. Clips saved before
this was measured are measured from their audio when AirScribe starts.

A channel with three or more transmissions in the week is tagged **static**
when its typical (median) transmission was static, or, where nothing was
measured, when four in five came to no speech; and **weak** when its typical
signal reading was 3 or less. These are first guesses (src/quality.js), to be
tuned against real traffic.

## Backups

**Back up this region** keeps every slot of the region, the empty ones too,
each as the radio's own 25-byte record. **Put back** writes every slot of that
region back exactly as it was, bits AirScribe doesn't model included.

AirScribe also backs a region up by itself:

- before it writes any channel to it, and
- before it puts a backup back, so that can be undone as well.

Each radio keeps its newest 50 backups, in AirScribe's database. A backup is put
back on the radio it was taken from.

## Writing

Each channel is written with the radio's own "write channel" command, then
read back from the radio and compared with what was sent, as HTCommander does.
A channel the radio refuses, or keeps differently, is reported by its slot,
and the rest are still written. Writing to the region the radio is on reads its
channel table again, so transmissions are filed under the new names.

What AirScribe writes is checked first:

- **What the radio can receive:** 136–174 MHz and 400–520 MHz, FM, and the
  airband, 108–136 MHz, in AM only. These are the UV-Pro's ranges; the other
  radios HTCommander supports are built the same way.
- **Transmit only in the ham bands:** AirScribe never turns transmit on outside
  the 2 m and 70 cm bands, and a channel moved out of them is made
  receive-only. A channel programmed elsewhere to transmit outside them (GMRS,
  say) keeps its transmit when only its name, tone or scan is changed.
- **New channels:** a channel AirScribe writes new transmits only
  if both its frequencies are in the 2 m (144–148 MHz) or 70 cm (420–450 MHz)
  band. Anything else is written receive-only, with the radio's own "transmit
  off" setting, whatever was asked.
- **Names:** up to ten plain characters, as the radio shows them.
- **Tones:** CTCSS in hertz, such as 127.3, or a DCS code, such as D023 (as
  RadioReference writes them, "127.3 PL" and "023 DPL" are read too). The radio
  has no inverted DCS codes.

## The record

READ_RF_CH (13) returns, and WRITE_RF_CH (14) takes, the same 25 bytes
(HTCommander's `RadioChannelInfo`):

| Bytes | Holds |
| --- | --- |
| 0 | the slot, from 0, in the region the radio is on |
| 1–4 | transmit frequency in hertz; the top two bits are the modulation (0 FM, 1 AM, 2 DMR) |
| 5–8 | receive frequency, the same way |
| 9–10, 11–12 | transmit and receive tone: CTCSS in hundredths of a hertz (1000 and up), DCS by its code's digits (below 1000), 0 for none |
| 13 | scan 0x80, high power 0x40, talk-around 0x20, wide 0x10, de-emphasis bypassed 0x08, 0x04, medium power 0x02, transmit off 0x01 |
| 14 | fixed frequency 0x80, fixed bandwidth 0x40, fixed power 0x20, mute 0x10 |
| 15–24 | the name, NUL-padded |

A slot with no name and no frequency is empty. The radio answers a write with a
status byte and the slot.

## API

All admin-only; a radio that isn't connected is a 502 with the radio link's
reason.

| Request | Does |
| --- | --- |
| `GET /api/radios/:mac/channels?region=N` | every slot of a region, read from the radio now (the region it's on without `region`), and `quality`: by channel name, the last week's `count`, `noSpeech`, median `rssi` and `snrDb`, and `tags` |
| `PUT /api/radios/:mac/channels` | `{region, channels, label}`: reads the region, backs it up, then writes the channels. Each is a new channel (`{id, name, rx_hz, tx_hz, mod, bandwidth, rx_tone, tx_tone, scan, power, tx_disable}`, `id` the slot from 0), an empty slot (`{id, rx_hz: 0}`), or a change to some of a channel's fields (`{id, set: {scan: false}}`). A write that changes nothing keeps no backup. A new channel may carry `lat` and `lon`, to put it on the map |
| `GET /api/uniden/stations?miles=&services=` | the frequencies in Uniden's database near home the radio can receive, of the services named (comma-separated: `police`, `fire`, `ems`, `multi`, `works`, `ham`, `air`, `rail`, `business`, `schools`, `federal`, `other`; none for all), nearest first, each with its `service` and the `channel` it would be written as, or `ok: false` and `why`; `counts` gives each service's playable (`ok`) and digital (`not`) numbers. With `mac=`, each has `tried`: what trying it on that radio came to |
| `GET /api/radios/:mac/trial` | the radio's trial (the one under way, or the last), the batch's `channels` with what's come in on each (`heard`, `speech`, `static`, `pending`, `sample`, `skipped`, `verdict` so far), and `results`: the latest verdict on each frequency tried on the radio, good first, each with the `station` as found |
| `POST /api/radios/:mac/trial` | `{region, homeRegion, services, miles, trialMin, homeMin, hours}`: back the region up and start trying channels in it |
| `POST /api/radios/:mac/trial/next` | grade the batch on what's come in, and write the next |
| `POST /api/radios/:mac/trial/end` | grade the batch, put the region back, and move the radio to its own |
| `DELETE /api/radios/:mac/trial/results?key=` | forget what a frequency tried came to (`key` as in `results`), or every one without `key` |
| `GET /api/radios/:mac/backups` | the radio's backups, newest first |
| `POST /api/radios/:mac/backups` | `{region, label}`: back a region up |
| `GET /api/radios/:mac/backups/:id` | one backup, every slot |
| `POST /api/radios/:mac/backups/:id/restore` | back the region up, then put this backup back |
| `DELETE /api/radios/:mac/backups/:id` | delete a backup (the radio isn't changed) |

## Tested

Against the simulated radio (`--simulate`, which keeps channels as these
records) and a stand-in for the radio's control channel in the sidecar's tests,
not yet against a real UV-Pro. The first real test is best done with a backup:
**Back up this region**, write to an empty slot, read it on the radio itself,
then **Put back**.
