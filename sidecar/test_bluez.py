import unittest

from bluez import AUDIO_END, AUDIO_CMDS, TRANSMIT_CMD, parse_ht_status
from sbc import expected_pcm_bytes


class HtStatusTests(unittest.TestCase):
    # The exact reply a real UV-Pro gave: powered on, scanning, squelch
    # closed, nothing being received.
    IDLE = bytes.fromhex("FF01000500028014008201 0080".replace(" ", ""))

    def test_decodes_the_real_idle_reply(self):
        st = parse_ht_status(self.IDLE)
        self.assertIsNotNone(st)
        self.assertTrue(st["power_on"])
        self.assertTrue(st["scanning"])
        self.assertFalse(st["in_rx"])
        self.assertFalse(st["squelch"])
        self.assertFalse(st["in_tx"])
        self.assertEqual(st["rssi"], 0)

    def test_receiving_sets_rx_squelch_and_rssi(self):
        # Same frame with the RX and squelch bits set and RSSI 9, which is
        # what the polls showed while a station was on the air.
        raw = bytearray(self.IDLE)
        raw[9] |= 0x10 | 0x20
        raw[11] = 0x90
        st = parse_ht_status(bytes(raw))
        self.assertTrue(st["in_rx"])
        self.assertTrue(st["squelch"])
        self.assertEqual(st["rssi"], 9)

    def test_rejects_anything_that_is_not_a_status_reply(self):
        for bad in (b"", b"\x00" * 13, self.IDLE[:8], b"\xff\x02" + self.IDLE[2:]):
            self.assertIsNone(parse_ht_status(bad))


class FrameConstantTests(unittest.TestCase):
    def test_command_bytes_match_the_observed_stream(self):
        # The 45s capture contained 0x00 audio frames and 0x01 end markers.
        self.assertIn(0x00, AUDIO_CMDS)
        self.assertIn(0x03, AUDIO_CMDS)
        self.assertEqual(AUDIO_END, 0x01)
        self.assertEqual(TRANSMIT_CMD, 0x09)
        self.assertNotIn(TRANSMIT_CMD, AUDIO_CMDS)


class PcmSizeTests(unittest.TestCase):
    def test_matches_the_real_captures_arithmetic(self):
        # Run 3 of the UV-Pro capture: 159852 SBC bytes -> 14.5 s at 32 kHz.
        pcm = expected_pcm_bytes(159852)
        seconds = pcm / 2 / 32000
        self.assertAlmostEqual(seconds, 14.5, delta=0.1)

    def test_partial_frames_are_not_counted(self):
        self.assertEqual(expected_pcm_bytes(43), 0)
        self.assertEqual(expected_pcm_bytes(44), 128 * 2)
        self.assertEqual(expected_pcm_bytes(87), 128 * 2)


if __name__ == "__main__":
    unittest.main()
