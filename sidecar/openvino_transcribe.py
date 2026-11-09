#!/usr/bin/env python3
"""Persistent OpenVINO transcription worker, for Intel GPUs.

sherpa-onnx's published packages run on the CPU or on CUDA, which leaves an
Intel Arc card with nothing to do. OpenVINO GenAI runs Whisper and SenseVoice
on one. The protocol is the same as sherpa_transcribe.py: JSON lines {"id",
"wav"} on stdin, {"id", "ok", "text"|"error"} on stdout, and one {"event":
"ready"} or {"event":"error"} once the model has loaded. The ready line also
names the device the model actually landed on.

  pip install "openvino-genai>=2026.4"

Models are OpenVINO IR directories, not the ONNX ones sherpa-onnx uses; see
docs/transcription.md.
"""

import argparse
import json
import sys

from sherpa_transcribe import read_wav

SAMPLE_RATE = 16000


def load_pipeline(model_dir, device, fallback=None, cache_dir=None):
    """Load the model, returning (pipeline, the device it is really on).

    A GPU that has gone missing should cost speed, not transcripts, so the
    fallback is tried when one is configured. The move is written to stderr,
    which reaches the service log.
    """
    import openvino_genai

    properties = {"CACHE_DIR": cache_dir} if cache_dir else {}
    try:
        return openvino_genai.ASRPipeline(model_dir, device, **properties), device
    except Exception as e:
        if not fallback or fallback == device:
            raise
        print(f"[openvino] {device} failed, using {fallback}: {e}", file=sys.stderr, flush=True)
        return openvino_genai.ASRPipeline(model_dir, fallback, **properties), fallback


def generation_options(pipeline, language):
    """Keyword arguments for generate() that carry the language hint.

    OpenVINO refuses a language on an English-only model rather than ignoring
    it, and those models are the usual choice here.
    """
    if language in (None, "", "auto") or not pipeline.get_generation_config().is_multilingual:
        return {}
    return {"language": f"<|{language}|>"}


def transcribe(pipeline, options, path):
    samples, rate = read_wav(path)
    # generate() takes bare samples, so it has no way to notice the wrong rate
    # and would return confident nonsense.
    if rate != SAMPLE_RATE:
        raise RuntimeError(f"expected {SAMPLE_RATE} Hz audio, got {rate} Hz")
    return str(pipeline.generate(samples, **options)).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--device", default="GPU")
    ap.add_argument("--fallback-device")
    ap.add_argument("--cache-dir")
    ap.add_argument("--language", default="auto")
    args = ap.parse_args()

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    try:
        pipeline, device = load_pipeline(
            args.model_dir, args.device, args.fallback_device, args.cache_dir
        )
        options = generation_options(pipeline, args.language)
    except Exception as e:
        emit({"event": "error", "error": str(e)})
        return 1
    emit({"event": "ready", "device": device})

    for line in sys.stdin:
        req = None
        try:
            req = json.loads(line)
            emit({"id": req["id"], "ok": True, "text": transcribe(pipeline, options, req["wav"])})
        except Exception as e:
            emit({"id": req.get("id") if req else None, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
