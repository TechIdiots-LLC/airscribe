# Testing a build

Four stages, cheapest first. Each one rules something out, so when the last
fails you already know it is not any of the earlier things.

Stages 1 and 2 need no radio. Do them first — a radio power-cycle is the
expensive part of this loop, and there is no point spending one to discover
that ffmpeg is missing.

## 1. The suites

```sh
npm ci
npm test              # Node: server, segmenter, store, API, engines
npm run test:py       # Python: framing, status decoding, SBC arithmetic
```

Neither needs a radio, a speech model or Bluetooth. On Node below 22.5 the
store and migration tests report as skipped rather than failing.

## 2. The whole pipeline, with a simulated radio

```sh
node src/index.js --simulate
```

Then open `http://127.0.0.1:8100`. The simulator presents two fake radios that
"hear" a burst every few seconds, bracketed by the same run markers a real
radio sends, and the mock transcriber stands in for a speech model.

This exercises the server, the segmenter, the store, the event stream and the
web UI. If something is wrong here it is not the radio.

### Looking at it from another machine

The server binds to `127.0.0.1`, and binding anywhere reachable is refused
without a token — so on a headless box, forward the port rather than opening
it:

```sh
ssh -L 8100:127.0.0.1:8100 you@the-server
```

Then browse `http://127.0.0.1:8100` on your own machine. Nothing is exposed
and no configuration changes.

To reach it directly instead, it needs a token, because that is what the guard
is asking for:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put it in a config file under `auth.tokens`, then:

```sh
node src/index.js --config airscribe.config.json --simulate --host 0.0.0.0
```

and open `http://<server>:8100/?token=<the token>`. The page is served without
a token — it has to be, or the sign-in could never load — but every API call
it makes carries one.

Opening it without the `?token=` is fine too: the page asks for one. A token
given either way is kept in the browser, so later visits need no query string,
and one supplied in the URL is stripped from the address bar rather than left
in history and bookmarks.

## 3. The sidecar alone, against a real radio

Worth doing before the full server, because it shows the raw event stream with
nothing in the way.

```sh
ffmpeg -hide_banner -decoders | grep -w sbc     # must print a line
```

If it prints nothing, install ffmpeg or a build with the SBC decoder; the
sidecar will otherwise report `no SBC-capable ffmpeg found` at startup and
decode nothing.

Then, with the radio powered on:

```sh
(echo '{"id":1,"cmd":"connect","mac":"38:D2:00:01:56:51"}'; sleep 60) \
  | python3 sidecar/airscribe_sidecar.py --backend bluez \
      --control-channel 1 --audio-channel 2
```

Keeping stdin open for 60 seconds is the point of the `sleep`: the sidecar
exits when its input closes, and it releases the radio on the way out.

Expect a `status` event saying `connected`, then a `radio-status` line each
second carrying RSSI and squelch. **Open the squelch on the radio** — monitor
button, or squelch to 0 — and `audio-start`, a run of `audio` events and
`audio-end` should follow. Without that the radio may hear nothing for the
whole minute and emit no audio at all, which looks like a failure and is not.

Passing `--control-channel` and `--audio-channel` skips probing. Probing costs
the radio sessions it frees slowly, so use the known numbers when you have
them. If the radio refuses the control channel, power-cycle its Bluetooth; see
[bluetooth.md](bluetooth.md).

## 4. The server, against a real radio

Two steps, because a radio that never produces a clip and a transcriber that
never produces text look identical in the UI — an empty feed.

### 4a. Real radio, mock transcriber

Leave the speech model out of it at first. In `airscribe.config.json`:

```json
{
  "host": "0.0.0.0",
  "auth": { "tokens": ["<your token>"] },
  "sidecar": {
    "python": "python3",
    "backend": "bluez",
    "controlChannel": 1,
    "audioChannel": 2
  },
  "stt": { "engine": "mock" }
}
```

`stt.engine: "mock"` stands in for a speech model, and **`--simulate` is not
passed** — that would replace the radio too. The channel numbers skip probing,
which spares the radio sessions it frees slowly.

```sh
node src/index.js --config airscribe.config.json
```

In the UI: **Scan** (the radio appears by name, recognised by its BS AOC
service), **Add**, then **Connect**. The dot should go green, and the pill in
the terminal-side log should start reporting status each second.

Key up on another radio, or let real traffic in. Each transmission should
appear in the feed within a second or two of ending, with a playable clip and
a `[mock transcript of …]` placeholder.

**If clips appear, the radio path works end to end.** Only transcription is
left.

### 4b. Add the speech model

```sh
pip install sherpa-onnx --break-system-packages
cd /var/lib/airscribe && mkdir -p models && cd models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2
tar xf sherpa-onnx-whisper-base.en.tar.bz2
```

Then swap the `stt` block for the real engine and restart:

```json
"stt": {
  "engine": "sherpa-onnx",
  "sherpa-onnx": {
    "python": "python3",
    "model": "whisper-base.en",
    "modelDir": "/var/lib/airscribe/models/sherpa-onnx-whisper-base.en",
    "language": "en"
  }
}
```

The worker loads on the first clip, not at startup, so a wrong `modelDir`
shows up as a failed transcription rather than a server that will not boot.
The reason appears in the feed and in the log.

### Squelch matters here

Set it around 3–5 rather than 0–1. A permissive squelch opens on noise, and
each opening becomes a clip — and speech models tend to invent text from
hiss rather than returning nothing, so a low squelch fills the log with
fabrications.

## When something fails

| Symptom | Where to look |
| --- | --- |
| tests pass, simulator broken | the server, not the radio — stage 2 uses no hardware |
| `no SBC-capable ffmpeg found` | ffmpeg missing or built without the SBC decoder |
| connect refused on the control channel | the radio is wedged; power-cycle its Bluetooth |
| connected, but no audio events ever | the radio is hearing nothing — open the squelch and check `radio-status` for `in_rx` |
| audio events but no transcript | the speech engine, not the radio — check the server log |

The distinction worth keeping is between *the radio heard nothing* and *the
link is broken*. `radio-status` answers it: squelch closed and RSSI 0 across a
whole window means silence, not a fault.
