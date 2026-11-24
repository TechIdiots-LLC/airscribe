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
| `transducer` | Zipformer and other encoder/decoder/joiner models |
| `nemo-transducer` | NVIDIA's NeMo transducers: Parakeet TDT (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`) |
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

## Using an Intel GPU

sherpa-onnx's published packages run on the CPU or on CUDA, and ONNX Runtime
has no Vulkan backend, so an Intel Arc card needs one of two other routes.
**OpenVINO runs on a real card:** an Arc A750, from an unprivileged Proxmox
container, with Ubuntu 24.04's own `intel-opencl-icd` (23.43) and OpenVINO
2026.4.1, transcribing live traffic ([proxmox.md](proxmox.md) has the steps
as they were run). whisper.cpp with Vulkan hasn't been run on the card yet;
the plan is to run both on the same clips and keep whichever reads them better.

| | [OpenVINO](#openvino) | [whisper.cpp built with Vulkan](#whispercpp-on-a-gpu-vulkan) |
| --- | --- | --- |
| engine | `openvino` | `whisper-server` (or `whisper-cpp`) |
| driver | Intel's compute runtime, `intel-opencl-icd` | Mesa's Vulkan driver, `mesa-vulkan-drivers` |
| install | a Python venv with `openvino-genai` | whisper.cpp built from source |
| models | OpenVINO IR: every Whisper size ready-made, SenseVoice by export | ggml files, Whisper only |
| model kept loaded | yes, by a warm worker | with `whisper-server`; `whisper-cpp` loads it for every clip |

Both reach the card through its render node, so the service account needs the
`render` group and a container needs the node mapped in; see
[installing.md](installing.md#using-an-intel-gpu). Several containers can share
the card, so a media server can keep transcoding on it.

## Using an NVIDIA GPU

OpenVINO runs only on Intel hardware: with an NVIDIA card, its `GPU` device
isn't there and the `openvino` engine falls back to the CPU. Use whisper.cpp
through `whisper-server` instead, built one of two ways:

- **with CUDA** (`-DGGML_CUDA=1`), the faster, which needs NVIDIA's CUDA
  toolkit to build it, and keeps it for its libraries;
- **with Vulkan**, as for an Arc ([below](#whispercpp-on-a-gpu-vulkan)): the
  same build runs on the NVIDIA card through the Vulkan driver in NVIDIA's
  libraries, with no toolkit.

Either way the container needs the card's devices and NVIDIA's driver
libraries, the same version as the host's driver. [proxmox.md](proxmox.md#transcription-on-the-hosts-nvidia-gpu)
has the steps, and `tools/install-nvidia-libs.sh` installs the libraries. The
`whisper-server` engine's settings don't change; the first clip's log says
`using CUDA0 backend` (or `Vulkan0`) when it's on the card.

## OpenVINO

OpenVINO GenAI runs Whisper and SenseVoice on an Intel GPU, through the same
kind of warm worker as sherpa-onnx.

```json
"stt": {
  "engine": "openvino",
  "openvino": {
    "python": "/opt/airscribe/.venv/bin/python",
    "modelDir": "/var/lib/airscribe/models/whisper-base.en-fp16-ov",
    "device": "GPU",
    "cacheDir": "/var/lib/airscribe/ov-cache",
    "language": "en"
  }
}
```

Install the GPU's compute driver, which is separate from the VA-API one that
video transcoding uses, then OpenVINO in a venv, then a model:

```sh
sudo apt install intel-opencl-icd clinfo python3-venv
sudo python3 -m venv /opt/airscribe/.venv
sudo /opt/airscribe/.venv/bin/pip install "openvino-genai>=2026.4" huggingface_hub
sudo /opt/airscribe/.venv/bin/hf download OpenVINO/whisper-base.en-fp16-ov \
  --local-dir /var/lib/airscribe/models/whisper-base.en-fp16-ov
sudo chown -R airscribe:airscribe /var/lib/airscribe/models
```

**The models are OpenVINO IR, not the ONNX archives sherpa-onnx uses**, so a
`modelDir` cannot be shared between the two engines. The
[OpenVINO organisation](https://huggingface.co/OpenVINO) publishes every
Whisper size in `fp16`, `int8` and `int4`; for anything else, including
SenseVoice, export it with `optimum-cli export openvino`.

The service account needs the render group; see
[installing.md](installing.md#using-an-intel-gpu). Then check, as that account:

```sh
sudo -u airscribe clinfo -l     # expect the card, not an empty list
sudo -u airscribe /opt/airscribe/.venv/bin/python \
  -c "from openvino import Core; print(Core().available_devices)"     # expect GPU
```

| key | default | |
| --- | --- | --- |
| `modelDir` | required | the model's directory |
| `device` | `GPU` | `GPU`, `GPU.0`, `GPU.1` or `CPU` |
| `fallbackDevice` | `CPU` | tried if `device` will not load the model; `null` reports the failure instead |
| `cacheDir` | none | keeps compiled models, because compiling for a GPU is slow; must be writable by the service |
| `language` | `auto` | a hint for multilingual models; English-only models ignore it |

**Check where it landed.** The first clip logs
`[stt] openvino worker running on GPU`. A fallback logs the reason and then
names `CPU`, and transcripts keep arriving, so a missing driver otherwise looks
like nothing more than slowness.

**What the GPU buys.** Less than the card's size suggests: `tiny.en` reads a
16-second clip in under half a second on a CPU, and clips go through one at a
time. It earns its place when several models read each clip, or for models too
large to keep up on a CPU — bearing in mind that
[bigger is not better here](#bigger-is-not-better-here).

It also runs only autoregressive models, so it does nothing for the
[truncation problem](#models-that-cannot-truncate). Moonshine and the
transducers stay on sherpa-onnx, and the two can run side by side:

```json
"stt": {
  "engines": {
    "moon": { "type": "sherpa-onnx", "family": "moonshine", "modelDir": "…" },
    "arc": { "type": "openvino", "modelDir": "…", "cacheDir": "…", "language": "en" }
  },
  "default": "moon",
  "alsoRun": ["arc"]
}
```

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

### Getting the transcripts out

The **Export** link beside the search box downloads whatever the feed is
currently showing — the same radio and search filters — as CSV, one row per
transcript rather than per transmission, since engines differ between clips
and a column each would be mostly empty.

```sh
curl -H 'authorization: Bearer <token>'   'http://localhost:8100/api/transmissions/export?format=csv&q=fire' -o fire.csv
```

`format` takes `csv`, `txt` or `json`. A single clip's download carries every
engine's version too, with the channel and frequency above it:

```
2026-09-22T21:31:34.000Z  38:D2:00:01:56:51
Holden PD · 460.3875 MHz
6.3s · heard

base   The
tiny   over Montregg, he low-lity, nettle, 3, 1, 4, set, K, W.
small  Welcome on red
```

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

`-nt` and `-np` are added; `language` becomes `-l`.

### whisper.cpp on a GPU (Vulkan)

whisper.cpp built with its Vulkan backend runs on an Intel Arc card through
Mesa's ordinary Vulkan driver, with no Intel runtime to install. It uses the
GPU by default; nothing in the engine's config changes. Ubuntu 24.04 has no
whisper.cpp package, so build it:

```sh
sudo apt install build-essential cmake git libvulkan-dev glslc spirv-headers \
  mesa-vulkan-drivers vulkan-tools
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --config Release
sudo cmake --install build --prefix /usr/local && sudo ldconfig     # whisper-cli, whisper-server
sudo install -d -o airscribe -g airscribe /var/lib/airscribe/models
sudo -u airscribe curl -fL -o /var/lib/airscribe/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Then check, as the service's account, that Vulkan sees the card itself:

```sh
sudo -u airscribe vulkaninfo --summary | grep deviceName
```

`llvmpipe` alone means Vulkan cannot reach the card (a missing `render` group
or render node). whisper.cpp skips that software device, says
`whisper_backend_init_gpu: no GPU found`, and runs on the CPU.

The `whisper-cpp` engine loads the model again for every clip, which on a GPU
also means copying it to the card and setting Vulkan up; on short clips that
can cost more than the GPU saves. Use `whisper-server` instead.

## whisper-server

whisper.cpp's server loads the model once and keeps it. AirScribe starts it on
the first clip, on a free loopback port, and posts each clip to it; if it
dies, that clip fails and the next one starts it again, as the Python workers
do.

```json
"stt": {
  "engine": "whisper-server",
  "whisper-server": {
    "model": "/var/lib/airscribe/models/ggml-base.en.bin",
    "language": "en",
    "args": ["-t", "4"]
  }
}
```

| key | default | |
| --- | --- | --- |
| `model` | required, unless `url` | a ggml model file |
| `language` | the server's, `en` | sent with each clip; `auto` for a multilingual model to detect it |
| `args` | none | more of the server's options, applied to every clip: `-t` threads, `-nth` the no-speech threshold, `--vad -vm <model>` voice detection |
| `binary` | `whisper-server` | the program |
| `binaryArgs` | none | arguments before the server's own, for a wrapper: `"binary": "nice", "binaryArgs": ["-n", "10", "whisper-server"]` |
| `port` | a free one | the loopback port it listens on |
| `startSeconds` | `300` | how long loading may take |
| `timeoutSeconds` | `120` | how long one clip may take |
| `url` | none | use a whisper-server already running instead of starting one |

**Voice detection keeps chirps from becoming words.** Whisper always writes
something, so a transmission that is only a talk-permit beep, a data burst or
a squelch tail comes back as "you", "Oh" or "BAM!". whisper.cpp has Silero
voice detection built in; with it, a clip with no speech comes back empty,
which the page shows as "(no speech recognised)". Through this engine, on
synthetic clips, base.en gave:

| clip | without | with `--vad` |
| --- | --- | --- |
| 0.8 s two-tone beep | "(beeping)" | nothing |
| 0.9 s pink noise | "(explosion)" | nothing |
| 1.5 s of speech | "And so I felt" | "And so I felt" |

Real chirps may fool it more often than synthetic ones; compare on your own
channel. The model (about 1 MB) comes with whisper.cpp's script, and goes in
`args`:

```sh
sh ./models/download-vad-model.sh silero-v5.1.2 /var/lib/airscribe/models
```

```json
"args": ["--vad", "-vm", "/var/lib/airscribe/models/ggml-silero-v5.1.2.bin"]
```

**Check where it landed.** The first clip logs the server's own device lines:

```
[stt] whisper-server: whisper_init_with_params_no_state: use gpu    = 1
[stt] whisper-server: whisper_backend_init_gpu: no GPU found
```

`no GPU found` from a Vulkan build means it is on the CPU; see the check
above. A model that won't load fails the clip with the server's last lines of
output.

**It has no password.** It listens on loopback only, but anything on the same
machine can use it, including its `/load`, which swaps the model. That suits a
container that runs only AirScribe. A server given with `url` is yours to run:
keep it off the network.

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
