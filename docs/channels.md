# A radio's channels: reading, writing and backups

**Channels** on a connected radio (admins only) shows every slot of one region
as the radio has it: name, receive and transmit frequency, tones, FM or AM and
its bandwidth, whether it transmits, and whether it's scanned. The region
picker reads another region; the radio is moved there to read it and back
again afterwards.

**Stations near me** writes RadioReference's listings for the county to the
radio, receive-only, after a backup: see
[radioreference.md](radioreference.md#stations-near-me-writing-listings-to-a-radio).

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
- **Transmit only in the ham bands:** a channel AirScribe writes transmits only
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
| `GET /api/radios/:mac/channels?region=N` | every slot of a region, read from the radio now (the region it's on without `region`) |
| `PUT /api/radios/:mac/channels` | `{region, channels, label}`: backs the region up, then writes the channels (each `{id, name, rx_hz, tx_hz, mod, bandwidth, rx_tone, tx_tone, scan, power, tx_disable}`, `id` the slot from 0; no `rx_hz` writes the slot empty) |
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
