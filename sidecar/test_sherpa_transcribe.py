import os
import tempfile
import unittest
import wave

from sherpa_transcribe import load_recognizer, read_wav


def write_wav(path, samples, rate=16000, channels=1, width=2):
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(b"".join(int(s).to_bytes(2, "little", signed=True) for s in samples))


class ReadWavTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def path(self, name):
        return os.path.join(self.dir, name)

    def test_samples_are_normalised_to_minus_one_to_one(self):
        p = self.path("a.wav")
        write_wav(p, [0, 32767, -32768, 16384])
        samples, rate = read_wav(p)
        self.assertEqual(rate, 16000)
        self.assertAlmostEqual(samples[0], 0.0)
        self.assertAlmostEqual(samples[1], 32767 / 32768)
        self.assertAlmostEqual(samples[2], -1.0)
        self.assertAlmostEqual(samples[3], 0.5)

    def test_stereo_is_downmixed_to_the_left_channel(self):
        p = self.path("s.wav")
        write_wav(p, [100, 999, 200, 999], channels=2)
        samples, _ = read_wav(p)
        self.assertEqual(len(samples), 2)
        self.assertAlmostEqual(samples[0], 100 / 32768)
        self.assertAlmostEqual(samples[1], 200 / 32768)

    def test_non_16_bit_is_rejected(self):
        p = self.path("8.wav")
        with wave.open(p, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(1)
            w.setframerate(16000)
            w.writeframes(b"\x00\x01")
        with self.assertRaisesRegex(RuntimeError, "16-bit"):
            read_wav(p)

    def test_sample_rate_is_reported_not_assumed(self):
        p = self.path("r.wav")
        write_wav(p, [0, 1], rate=32000)
        self.assertEqual(read_wav(p)[1], 32000)


class FamilyTests(unittest.TestCase):
    def test_unknown_family_names_the_valid_ones(self):
        with self.assertRaisesRegex(RuntimeError, "sense-voice, whisper"):
            load_recognizer("zipformer", "/tmp", "en", 1)


if __name__ == "__main__":
    unittest.main()


class FileMatchingTests(unittest.TestCase):
    """Model archives name files after the model; only the shape is known."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def touch(self, *names):
        for n in names:
            open(os.path.join(self.dir, n), "w").close()

    def test_finds_a_file_by_shape(self):
        from sherpa_transcribe import _one
        self.touch("encoder-epoch-99-avg-1.int8.onnx", "tokens.txt")
        self.assertTrue(_one(self.dir, "*encoder*.onnx").endswith("avg-1.int8.onnx"))
        self.assertTrue(_one(self.dir, "*tokens.txt").endswith("tokens.txt"))

    def test_says_so_when_nothing_matches(self):
        from sherpa_transcribe import _one
        with self.assertRaisesRegex(RuntimeError, "no file matching"):
            _one(self.dir, "*joiner*.onnx")

    def test_refuses_to_guess_between_candidates(self):
        from sherpa_transcribe import _one
        # The wrong encoder produces gibberish rather than an error, so an
        # ambiguous match must be reported, not resolved by luck.
        self.touch("a-joiner.onnx", "b-joiner.onnx")
        with self.assertRaisesRegex(RuntimeError, "matches 2 files"):
            _one(self.dir, "*joiner*.onnx")

    def test_moonshine_encoder_is_not_confused_with_its_decoders(self):
        from sherpa_transcribe import _one
        self.touch("preprocess.onnx", "encode.onnx",
                   "uncached_decode.onnx", "cached_decode.onnx", "tokens.txt")
        self.assertTrue(_one(self.dir, "*encode*.onnx").endswith("encode.onnx"))
        self.assertTrue(_one(self.dir, "*uncached_decode*.onnx").endswith("uncached_decode.onnx"))


class FamilyTests2(unittest.TestCase):
    def test_the_non_generative_families_are_available(self):
        from sherpa_transcribe import FAMILIES
        # These emit tokens aligned to the audio, so they cannot return a
        # fragment for a long transmission the way Whisper did.
        for f in ("transducer", "moonshine", "nemo-ctc"):
            self.assertIn(f, FAMILIES)
