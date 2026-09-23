#!/usr/bin/env python3
"""Persistent sherpa-onnx transcription worker.

HTCommander moved from whisper.cpp to sherpa-onnx, which offers SenseVoice,
Whisper and streaming Zipformer models behind one API. This worker exposes the
offline (whole-clip) recognizers, which is what a per-transmission clip needs.

It stays alive because loading a model takes seconds and a clip takes
fractions of one. Reads JSON lines {"id", "wav"} on stdin, writes
{"id", "ok", "text"|"error"} on stdout. A readiness line {"event":"ready"} or
{"event":"error"} is written once the model has loaded.

  pip install sherpa-onnx

Models come from the sherpa-onnx release page; see docs/transcription.md.
"""

import argparse
import json
import os
import sys
import wave


FAMILIES = ("sense-voice", "whisper", "transducer", "moonshine", "nemo-ctc")


def _one(directory, pattern):
    """The single file matching a pattern, or a clear complaint.

    Model archives name their files after the model, so the exact names are
    not predictable; the shape is. An ambiguous match is reported rather than
    guessed at, because the wrong encoder produces gibberish, not an error.
    """
    import glob

    hits = sorted(glob.glob(f"{directory}/{pattern}"))
    # "uncached_decode" contains "cached_decode", so the cached decoder's
    # pattern matches both of Moonshine's decoders. Asking for the cached one
    # means the one that is not uncached.
    if len(hits) > 1 and pattern.startswith("*cached_decode"):
        hits = [h for h in hits if "uncached" not in os.path.basename(h)] or hits
    if not hits:
        raise RuntimeError(f"no file matching {pattern} in {directory}")
    if len(hits) > 1 and pattern != "*.onnx":
        raise RuntimeError(
            f"{pattern} matches {len(hits)} files in {directory}: "
            f"{', '.join(h.rsplit('/', 1)[-1] for h in hits)}"
        )
    return hits[0]


def load_recognizer(family, model_dir, language, threads):
    # Checked before the import so a typo reports itself rather than surfacing
    # as a missing-module error.
    if family not in FAMILIES:
        raise RuntimeError(f"unknown model family {family!r} ({', '.join(FAMILIES)})")

    import sherpa_onnx

    d = model_dir.rstrip("/\\")
    if family == "sense-voice":
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=f"{d}/model.int8.onnx",
            tokens=f"{d}/tokens.txt",
            num_threads=threads,
            language="" if language in (None, "auto") else language,
            use_itn=True,  # inverse text normalisation: digits, not words
        )
    if family == "whisper":
        # The archives name their files after the model size, so the caller
        # passes the encoder/decoder paths rather than this guessing them.
        import glob

        enc = glob.glob(f"{d}/*encoder*.onnx")
        dec = glob.glob(f"{d}/*decoder*.onnx")
        tok = glob.glob(f"{d}/*tokens.txt")
        if not (enc and dec and tok):
            raise RuntimeError(f"no whisper encoder/decoder/tokens found in {d}")
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=sorted(enc)[0],
            decoder=sorted(dec)[0],
            tokens=sorted(tok)[0],
            num_threads=threads,
            language="" if language in (None, "auto") else language,
        )

    # The families below emit tokens aligned to the audio rather than
    # generating a sentence, so they cannot stop early and return a fragment
    # for a long transmission the way an autoregressive model can. On radio
    # traffic that failure costs more than a wrong word.
    if family == "transducer":
        enc, dec, join, tok = (
            _one(d, "*encoder*.onnx"), _one(d, "*decoder*.onnx"),
            _one(d, "*joiner*.onnx"), _one(d, "*tokens.txt"),
        )
        return sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=enc, decoder=dec, joiner=join, tokens=tok, num_threads=threads,
        )
    if family == "moonshine":
        return sherpa_onnx.OfflineRecognizer.from_moonshine(
            preprocessor=_one(d, "*preprocess*.onnx"),
            encoder=_one(d, "*encode*.onnx"),
            uncached_decoder=_one(d, "*uncached_decode*.onnx"),
            cached_decoder=_one(d, "*cached_decode*.onnx"),
            tokens=_one(d, "*tokens.txt"),
            num_threads=threads,
        )
    if family == "nemo-ctc":
        return sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=_one(d, "*.onnx"), tokens=_one(d, "*tokens.txt"), num_threads=threads,
        )
    raise RuntimeError(f"family {family!r} is listed but not handled")


def read_wav(path):
    """Return (float32 samples in -1..1, sample rate). Mono 16-bit only."""
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise RuntimeError("expected 16-bit PCM")
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
        channels = w.getnchannels()
    import array

    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()
    if channels > 1:
        samples = samples[::channels]
    return [s / 32768.0 for s in samples], rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--family", default="sense-voice")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--language", default="auto")
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    try:
        recognizer = load_recognizer(
            args.family, args.model_dir, args.language, args.threads
        )
    except Exception as e:
        emit({"event": "error", "error": str(e)})
        return 1
    emit({"event": "ready"})

    for line in sys.stdin:
        req = None
        try:
            req = json.loads(line)
            samples, rate = read_wav(req["wav"])
            stream = recognizer.create_stream()
            stream.accept_waveform(rate, samples)
            recognizer.decode_stream(stream)
            emit({"id": req["id"], "ok": True, "text": stream.result.text.strip()})
        except Exception as e:
            emit({"id": req.get("id") if req else None, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
