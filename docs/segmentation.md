# Segmentation

Turning a continuous audio stream into one clip per transmission. This is the
part that decides whether a transcript reads as separate messages or as one
run-on smear, so it is worth understanding before tuning it.

## The boundary to trust

The radio already knows where a transmission starts and stops: it opens an
audio run, sends audio frames, and sends an end-of-audio frame. The sidecar
forwards those as `audio-start` and `audio-end`, and
[src/segmenter.js](../src/segmenter.js) treats them as authoritative —
`end()` closes the clip immediately rather than waiting out a silence timer.

This is what separates two transmissions that follow each other with no real
gap, which a silence timer alone cannot do. It was the weak point of the
earlier voice work in the HTCommander fork, which had only squelch and energy
to go on.

Upstream HTCommander does the same thing, starting and completing a speech
segment on those frames.

## Why squelch and energy are still there

The markers cannot carry it alone:

- A continuous broadcast — a weather channel — opens a run and never closes it.
- A run can already be in progress when the server connects.
- A backend that only reports a squelch flag has no markers at all.

So audio arriving with no `begin()` still opens a clip, and a clip still closes
after `holdMs` of quiet when no `end()` comes. The markers are the primary
signal; these are the safety net.

## Receive and transmit never merge

A `0x09` run is audio the radio is transmitting. Hearing someone and answering
them are two transmissions, so a change of direction closes the clip even with
no end marker in between. Each clip records its direction, and the UI tags it
`heard` or `sent`.

## Long transmissions

A clip past `maxMs` is split rather than dropped, and the next clip is seeded
with the last `overlapMs` of audio so a word straddling the split survives in
one of the halves. `overlapMs` is clamped to half of `maxMs`: an overlap near
`maxMs` would carry the whole clip forward, so the next clip would be born over
the limit and split again, emitting near-duplicate clips forever.

## Settings

All under `audio` in the config.

| Setting | Default | What it does |
| --- | --- | --- |
| `holdMs` | 1200 | Quiet time before a clip closes **when no end marker arrives**. Raise it if messages with long pauses are being cut in two. |
| `preRollMs` | 300 | Audio kept from before the clip opened, so a clipped first syllable is recovered. |
| `minMs` | 400 | Clips with less speech than this are dropped as noise or a squelch tail. |
| `maxMs` | 120000 | A clip this long is split. Guards against a stuck transmitter producing an unbounded file. Checked after each chunk is appended, so a clip may overrun it by up to one chunk (~28 ms on a real UV-Pro stream). |
| `overlapMs` | 300 | Audio carried across a split. Clamped to half of `maxMs`. |
| `energyThreshold` | 0.02 | RMS level (0..1) counted as voice by the fallback path. Raise it on a noisy channel where hiss is opening clips. |

Timing comes from the audio itself — chunk lengths, not the wall clock — so
behaviour is identical live and in tests, and a stalled Bluetooth link cannot
make a clip appear longer than the audio in it.

## Confirmed against a real radio

A 45-second capture from a UV-Pro scanning an emergency group caught three
stations transmitting. The radio delimited all three with its own
end-of-audio frames, and replaying that structure through the segmenter
produces exactly three clips of 2.0 s, 5.7 s and 14.5 s.

The same audio fed in *without* the markers — which is all the earlier
squelch-only approach had — collapses into **one** clip, because the stations
answered each other with no silence between them. That is the failure this
design exists to fix, and both cases are locked down in
[test/capture-replay.test.js](../test/capture-replay.test.js).

The fixture stores only frame sizes. The audio was other operators' voices
and is deliberately not kept.

## Testing it

[test/segmenter.test.js](../test/segmenter.test.js) covers the marker path, the
fallbacks, direction changes and the overlap arithmetic;
[test/manager.test.js](../test/manager.test.js) covers the wiring from sidecar
events through to stored transmissions. Neither needs a radio. The simulator
backend emits the same run markers a real radio does, so `npm run simulate`
exercises the marker path end to end.
