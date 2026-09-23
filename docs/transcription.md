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

**The failure that costs most is not invention, it is stopping early.** Run
side by side on 27 dispatch transmissions, tiny, base and small each
transcribed some clips better than the others — but base and small both
produced cases where a long transmission came back as a fragment:

| clip | tiny | base | small |
| --- | --- | --- | --- |
| 14.8 s | partial | full sentence | `Starla.` |
| 9.4 s | full callsign readback | `the` | full callsign readback |

A hallucinated line is wrong and obvious. A 15-second transmission reduced to
one word is silently lost, and nothing in the feed says so. `trunc` in the
comparison tool counts these — a clip of 5 s or more reduced to three words
or fewer — and it is the column to watch, more than `words`.

Neither model was reliably better. That is the argument for running more than
one and keeping both transcripts, rather than choosing a winner.

`model` picks the family and is one of:

| id | family | size | notes |
| --- | --- | --- | --- |
| `sense-voice` | sense-voice | ~1 GB | English, Chinese, Japanese, Korean, Cantonese, with language auto-detection |
| `whisper-tiny.en` | whisper | ~110 MB | English, fastest, least accurate |
| `whisper-base.en` | whisper | ~210 MB | English, a good balance |
| `whisper-small.en` | whisper | ~600 MB | English, more accurate on clear speech and more inventive on noise |

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

## Models that cannot truncate

Whisper decodes autoregressively: it generates a sentence and decides when to
stop. That is why a 14.8-second transmission came back as `Starla.` — the
model ended the sequence early, and nothing about the audio stopped it.

Transducer and CTC models cannot do that. They emit tokens against the audio
as it passes, so their output length is tied to the input's. They can be
wrong, but they cannot silently discard ten seconds of speech.

For radio traffic that is the more important property, so these families are
available alongside Whisper:

| `family` | what it suits |
| --- | --- |
| `moonshine` | built for short audio; a median transmission here is 3 s |
| `transducer` | Zipformer, Parakeet TDT and other encoder/decoder/joiner models |
| `nemo-ctc` | NeMo CTC models |
| `sense-voice` | multilingual, autoregressive |
| `whisper` | the tiny/base/small line, autoregressive |

Take any matching model from the
[sherpa-onnx model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models),
unpack it, and point `modelDir` at the directory with the right `family`:

```json
"moon": {
  "type": "sherpa-onnx",
  "family": "moonshine",
  "modelDir": "/var/lib/airscribe/models/sherpa-onnx-moonshine-base-en-int8"
}
```

The files inside are named after the model, so they are matched by shape
rather than by name. An ambiguous match is reported rather than guessed at,
because the wrong encoder produces gibberish instead of an error.

## Engines outside sherpa-onnx

The `command` engine runs anything that prints a transcript, so these need no
code here:

- **faster-whisper** — the same Whisper weights through CTranslate2, several
  times quicker, and it exposes `vad_filter` and `no_speech_threshold`, which
  bear directly on the noise problem.
- **Vosk** — Kaldi-based, small models, and non-generative, so it will not
  invent a sentence for a squelch tail.
- **whisper.cpp** — already has its own engine, and takes
  `--no-speech-thold`.

```json
"vosk": { "type": "command", "template": ["/srv/bin/vosk.sh", "{wav}"] }
```

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

### Judging them

```sh
python3 tools/compare-engines.py http://localhost:8100 <token>
```

It prints, per engine, how many clips produced words, how many came back
empty, how many were an annotation like `(static)` or `*DING*`, and how many
were one of the stock phrases Whisper falls back on when fed noise — then
shows the longest clips with each engine's version side by side.

The columns worth watching are not just `words`. On a scanner feed a good
fraction of every clip is not speech, so a model with **no** empties and
**no** annotations is not being accurate; it is guessing. Declining to
transcribe noise is the correct behaviour, and it is what separates a model
that suits this material from one that merely scores well on clean speech.

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
