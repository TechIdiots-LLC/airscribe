import os
import sys
import tempfile
import types
import unittest
import wave
from unittest import mock

from openvino_transcribe import generation_options, load_pipeline, transcribe


class FakePipeline:
    multilingual = False
    broken_devices = ()
    made = []

    def __init__(self, model_dir, device, **properties):
        FakePipeline.made.append((device, properties))
        if device in self.broken_devices:
            raise RuntimeError(f"[GPU] no {device}")
        self.got = None

    def get_generation_config(self):
        return types.SimpleNamespace(is_multilingual=self.multilingual)

    def generate(self, samples, **options):
        self.got = (samples, options)
        return "  hello there "


def fake_openvino():
    FakePipeline.made = []
    return mock.patch.dict(sys.modules, {
        "openvino_genai": types.SimpleNamespace(ASRPipeline=FakePipeline)
    })


class LoadTests(unittest.TestCase):
    def test_uses_the_device_asked_for(self):
        with fake_openvino():
            _, device = load_pipeline("/m", "GPU", "CPU")
        self.assertEqual(device, "GPU")
        self.assertEqual(len(FakePipeline.made), 1)

    def test_falls_back_and_reports_where_it_landed(self):
        with fake_openvino(), mock.patch.object(FakePipeline, "broken_devices", ("GPU",)):
            with mock.patch("sys.stderr"):
                _, device = load_pipeline("/m", "GPU", "CPU")
        self.assertEqual(device, "CPU")

    def test_without_a_fallback_the_failure_is_the_answer(self):
        with fake_openvino(), mock.patch.object(FakePipeline, "broken_devices", ("GPU",)):
            with self.assertRaisesRegex(RuntimeError, "no GPU"):
                load_pipeline("/m", "GPU", None)

    def test_a_fallback_equal_to_the_device_is_not_retried(self):
        with fake_openvino(), mock.patch.object(FakePipeline, "broken_devices", ("CPU",)):
            with self.assertRaises(RuntimeError):
                load_pipeline("/m", "CPU", "CPU")
        self.assertEqual(len(FakePipeline.made), 1)

    def test_the_cache_is_passed_only_when_set(self):
        with fake_openvino():
            load_pipeline("/m", "GPU")
            load_pipeline("/m", "GPU", cache_dir="/c")
        self.assertEqual(FakePipeline.made, [("GPU", {}), ("GPU", {"CACHE_DIR": "/c"})])


class LanguageTests(unittest.TestCase):
    def test_english_only_models_get_no_language(self):
        # The real library raises "Cannot specify 'language' for not
        # multilingual model", and base.en is the usual choice here.
        self.assertEqual(generation_options(FakePipeline("/m", "CPU"), "en"), {})

    def test_multilingual_models_get_the_token_form(self):
        with mock.patch.object(FakePipeline, "multilingual", True):
            self.assertEqual(generation_options(FakePipeline("/m", "CPU"), "en"),
                             {"language": "<|en|>"})

    def test_auto_means_no_hint(self):
        with mock.patch.object(FakePipeline, "multilingual", True):
            self.assertEqual(generation_options(FakePipeline("/m", "CPU"), "auto"), {})


class TranscribeTests(unittest.TestCase):
    def wav(self, rate):
        path = os.path.join(tempfile.mkdtemp(), "a.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(b"\x00\x40" * 4)
        return path

    def test_text_comes_back_trimmed(self):
        p = FakePipeline("/m", "CPU")
        self.assertEqual(transcribe(p, {}, self.wav(16000)), "hello there")
        self.assertEqual(p.got[0], [0.5] * 4)

    def test_the_wrong_rate_is_refused_rather_than_misread(self):
        with self.assertRaisesRegex(RuntimeError, "got 32000 Hz"):
            transcribe(FakePipeline("/m", "CPU"), {}, self.wav(32000))


if __name__ == "__main__":
    unittest.main()
