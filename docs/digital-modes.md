# Digital modes (design, not implemented)

The radios expose the same 32 kHz audio for voice and for data, so digital modes
are software modems working on that PCM stream. HTCommander (upstream `main`)
does exactly this in `SoftwareModem.cs`, which offers AFSK 1200, PSK 2400,
PSK 4800 and G3RUH 9600, with FX.25 error correction, and it also has AX.25,
APRS, BSS, SSTV and its own torrent-style file exchange.

## Where it fits

```
sidecar (audio) ──► Manager ──┬─► Segmenter ─► voice clips ─► STT
                              └─► modem(s) ──► frames ──► services (APRS, IRC, files)
```

Voice segmentation and modems would consume the same `audio` events. A radio is
switched between "voice" and a data mode per channel, because a channel carrying
1200 baud data is not a channel to transcribe. That is a per-radio setting, not
something to guess from the audio.

Decoding is the first step, and cheaper than transmitting: receiving APRS
positions (which also feeds your mapping work) needs no keying and no licence
questions beyond listening. Transmit needs the sidecar to send SBC audio frames back over the audio
channel (the command byte for outgoing frames still needs to be read from
`RadioAudio.cs`'s transmit path) and to respect channel-clear timing, which HTCommander handles
with a pending-transmission queue and random backoff.

Options for the modem, none chosen yet:

- **Direwolf** as a child process fed PCM: mature AFSK, FX.25 and APRS (its 9600 mode has the same link limits below),
  simplest to get right, adds an external dependency.
- **Port from HTCommander** (its `HamLib` code is derived from Direwolf): no
  dependency, but a large amount of DSP to maintain in JavaScript or Python.

## IRC

IRC is a text protocol, so it maps onto AX.25 UI frames or connected-mode
sessions easily. The open questions are design, not code: one channel is
half-duplex and shared, so this is closer to a broadcast chat room than to an
IRC network. A small local IRC server (the browser or any IRC client connects
to it) that relays PRIVMSG over the radio, with the RF side treated as a single
shared channel, is a workable shape. Lines must stay short and rate-limited.

## BitTorrent over audio

HTCommander's own file exchange is **not BitTorrent**. It is a many-to-many
scheme where all frames are multicast on one frequency, stations trade file
listings, and anyone who hears a block keeps it and may retransmit it. Its own
docs call it experimental and slow.

Measured facts from upstream's `docs/findings/` (their own tests, dated
2026-07-07), which change what I said before:

- The end-to-end audio path is a **300 to 3000 Hz band-pass**, like narrowband
  FM voice. SBC compression is not the limit.
- AFSK 1200 and PSK 2400 work. PSK 4800 works on a clean signal with a thin
  noise margin. **G3RUH 9600 does not work over the 32 kHz link** as shipped;
  their test got it to 100% only by upsampling to 48 kHz in the demodulator,
  and the 3 kHz passband still argues against it on real radios.
- Upstream is developing its own modem, **DART** (`docs/NextGenModem.md`):
  DFT-spread OFDM in roughly 400 to 2600 Hz with LDPC and rate adaptation,
  targeting 1 to 6 kbps net. It is a proposal in the docs, not something to
  depend on.

So the realistic ceiling today is around 1200 to 2400 baud, with a few kbps if
DART matures. At 1200 baud expect roughly 60 to 100 B/s goodput (my estimate,
not a measurement).

At 100 B/s a 1 MB file takes about three hours of continuous channel time, and
that channel is shared. So PMTiles archives (megabytes to terabytes) are out of
reach, and this should not be framed as a way to move maps. What does fit:

- **Announcements**: the info-hash, name and size of what a station holds, so
  nearby stations learn what exists, and then fetch it over the internet or a
  local link. This is the useful bridge to pmtiles-swarm's RSS feed.
- **Small artefacts**: an APRS-style waypoint set, a small GeoJSON, a text
  bulletin, a torrent metadata file.
- **Blocks of small files** using HTCommander's scheme, if you want
  interoperability with it, rather than a new protocol.

Recommendation: implement receive-only APRS first (feeds the map), then a shared
chat/IRC bridge, then announcements. Whole-file transfer last, and only if
interoperability with HTCommander's exchange matters to you.
