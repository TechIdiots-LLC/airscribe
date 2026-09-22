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

```sh
cp airscribe.config.json.sample airscribe.config.json
```

Set `sidecar.controlChannel` and `sidecar.audioChannel` to the known numbers,
point `stt` at a model (see [transcription.md](transcription.md)), then:

```sh
node src/index.js --config airscribe.config.json
```

In the web UI: **Scan**, **Add** the radio, **Connect**. The indicator turns
amber while the radio is receiving, and each transmission should appear in the
feed as a clip with audio and, once the engine has run, text.

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
