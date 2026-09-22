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
