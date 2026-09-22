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
