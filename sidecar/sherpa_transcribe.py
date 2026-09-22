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
import sys
import wave


FAMILIES = ("sense-voice", "whisper")


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
