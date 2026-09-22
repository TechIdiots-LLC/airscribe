# Transcription

One clip per transmission goes to one engine, one at a time. Whisper-class
models saturate a CPU on a single clip, so running clips in parallel would only
make each slower; `Manager` keeps a single queue.

Engines are chosen with `stt.engine`, and each reads its own config section of
the same name. Adding one means adding a factory to `ENGINES` in
[src/stt/index.js](../src/stt/index.js) — nothing else branches on the engine.

## sherpa-onnx (recommended)

The engine HTCommander itself moved to. It covers SenseVoice and Whisper
through one API, and it is what upstream ships on desktop, Android and the web
build today.

```json
"stt": {
  "engine": "sherpa-onnx",
  "sherpa-onnx": {
    "python": "python3",
    "model": "whisper-base.en",
    "modelDir": "/srv/models/sherpa-onnx-whisper-base.en",
    "language": "en",
    "threads": 2
  }
}
```

Install and fetch a model:

```sh
pip install sherpa-onnx --break-system-packages   # or into a venv
mkdir -p /var/lib/airscribe/models && cd /var/lib/airscribe/models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2
tar xf sherpa-onnx-whisper-base.en.tar.bz2
ls sherpa-onnx-whisper-base.en/    # expect *encoder*.onnx, *decoder*.onnx, *tokens.txt
```

Ubuntu 24.04 refuses to install into the system Python without
`--break-system-packages`. A venv is tidier; point
`stt["sherpa-onnx"].python` at its interpreter if you use one.

**`modelDir` is the unpacked directory, and the sample config ships a
deliberate `/EDIT-ME/` placeholder.** Leaving it produces
`no whisper encoder/decoder/tokens found in /EDIT-ME/…` on every
transmission. The server warns about a non-existent directory at startup, so
check the first lines of its log after a config change.

### Bigger is not better here

The usual advice — take the largest model your CPU allows — is wrong for radio.
A larger model is more willing to produce confident text from noise, so on
squelch tails, weak signals and the dead air around a transmission it invents
plausible speech where a smaller model returns nothing or an honest
`(static)`. On a scanner feed, where a good fraction of every clip is not
speech at all, that trades a little accuracy on the clear parts for
fabrications on the rest.

Observed on this project's own traffic, not theory. Start small, listen to
what each model does with your channel's noise, and judge by how often it
invents rather than by how well it does on the clips you can already
understand.

`model` picks the family and is one of:

| id | family | size | notes |
| --- | --- | --- | --- |
| `sense-voice` | sense-voice | ~1 GB | English, Chinese, Japanese, Korean, Cantonese, with language auto-detection |
| `whisper-tiny.en` | whisper | ~110 MB | English, fastest, least accurate |
| `whisper-base.en` | whisper | ~210 MB | English, a good balance |

`modelDir` is the unpacked directory. For an unlisted model, set `family`
(`sense-voice` or `whisper`) instead of `model`. Streaming Zipformer is not
offered: it earns its keep on live audio, and a finished clip is not that.

`language` is a hint, or `"auto"`. The English-only Whisper models ignore it.

**How it runs.** Loading a model takes seconds and a clip takes a fraction of
one, so [sidecar/sherpa_transcribe.py](../sidecar/sherpa_transcribe.py) is a
long-lived worker that loads once and then answers JSON lines. It starts on the
first clip, so a bad model path does not stop the server from booting — the
first transmission reports the reason instead. If the worker dies, that clip
fails and the next one starts a fresh worker.

## Several engines at once

A clip can be read by more than one model, which is the only honest way to
judge them against your own channel's noise rather than someone else's
benchmark.

```json
"stt": {
  "engines": {
    "base": { "type": "sherpa-onnx", "model": "whisper-base.en", "modelDir": "…" },
    "tiny": { "type": "sherpa-onnx", "model": "whisper-tiny.en", "modelDir": "…" }
  },
  "default": "base",
  "alsoRun": ["tiny"]
}
```

The names are yours, so two models of the same type stay apart. `default` is
the transcript the feed shows and the text download returns; everything in
`alsoRun` appears beneath it, labelled.

**Comparison never delays live traffic.** The default engine on a new clip
outranks every comparison run and every recovery job. A job already running
is not interrupted — a speech model is not interruptible — so a new clip
waits for at most one other run, never for a whole backlog.

Each transcript is stored separately, so re-running one model leaves the
others alone.

## Recovering clips that were never transcribed

A failed transcription does not lose the audio. When the cause is fixed — a
missing module, a wrong model path — the clips can be worked through:

```sh
curl -X POST -H 'authorization: Bearer <token>'   'http://localhost:8100/api/transcribe-missing?engine=base'
```

It answers with how many were queued, and they run behind live traffic. One
clip at a time:

```sh
curl -X POST -H 'authorization: Bearer <token>'   'http://localhost:8100/api/transmissions/42/transcribe?engine=tiny'
```

## whisper.cpp

```json
"stt": { "engine": "whisper-cpp",
         "whisper-cpp": { "binary": "whisper-cli", "model": "/srv/models/ggml-base.en.bin", "language": "en" } }
```

One process per clip, so it pays the model load every time. Fine for light
traffic, and it is what the HTCommander fork's C# version used.

## command

Any program that prints a transcript on stdout. `{wav}` is replaced with the
clip path; arguments are passed as an array, never through a shell.

```json
"stt": { "engine": "command", "command": { "template": ["/srv/bin/transcribe.sh", "{wav}"] } }
```

This is the hook for faster-whisper, a cloud API, or anything else, with no code
change here.

## mock

Emits a placeholder. `--simulate` selects it, along with the simulated radio, so
the whole pipeline runs with no model and no hardware.

## Audio handed to the engine

Clips are written twice: the radio's own 32 kHz for download and playback, and a
16 kHz copy for the engine, which is what these models expect. Downsampling
averages sample pairs — a crude low-pass, adequate for speech on a channel
whose own passband is about 300 to 3000 Hz.
