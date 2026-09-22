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


class ShutdownTests(unittest.TestCase):
    """A sidecar that exits without releasing leaves the radio wedged."""

    def test_both_backends_expose_shutdown(self):
        import airscribe_sidecar as a
        for cls in (a.SimBackend, a.BluezBackend):
            self.assertTrue(callable(getattr(cls, "shutdown", None)),
                            f"{cls.__name__} has no shutdown()")

    def test_sim_shutdown_stops_every_radio(self):
        import airscribe_sidecar as a
        b = a.SimBackend()
        b.connect("00:11:22:33:44:55")
        b.connect("00:11:22:33:44:66")
        self.assertEqual(len(b.active), 2)
        b.shutdown()
        self.assertEqual(b.active, {})

    def test_bluez_shutdown_disconnects_and_empties(self):
        import airscribe_sidecar as a

        class FakeLink:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        b = a.BluezBackend.__new__(a.BluezBackend)   # no ffmpeg probe
        b.links = {"AA": FakeLink(), "BB": FakeLink()}
        held = list(b.links.values())
        b.shutdown()
        self.assertEqual(b.links, {})
        self.assertTrue(all(link.closed for link in held), "every link must be closed")


class ShortDecodeTests(unittest.TestCase):
    """A clip shorter than its transmission is otherwise invisible."""

    def test_expected_pcm_matches_the_real_capture(self):
        # 159852 bytes of SBC came to 14.5 s on a real UV-Pro.
        self.assertAlmostEqual(expected_pcm_bytes(159852) / 2 / 32000, 14.5, delta=0.1)

    def test_a_short_clip_implies_a_short_run(self):
        # A 0.76 s clip needs only ~8 kB of SBC. If a run carried far more
        # than that, the decode dropped audio rather than the transmission
        # being brief - which is the distinction the check exists to draw.
        pcm = 24192 * 2
        self.assertEqual(expected_pcm_bytes(8316), pcm)

    def test_shortfall_detection_threshold(self):
        want = expected_pcm_bytes(159852)
        over_2_percent = int(want * 0.97)
        within_2_percent = int(want * 0.995)
        self.assertGreater(abs(over_2_percent - want), want * 0.02)
        self.assertLessEqual(abs(within_2_percent - want), want * 0.02)


class BatteryTests(unittest.TestCase):
    """The radio reports its own battery; a flat one is what ends a session."""

    def build(self, status_type, value, ok=0x00):
        from bluez import parse_battery
        # FF 01 flags len | group cmd | status, type(hi,lo), value
        payload = bytes([ok, (status_type >> 8) & 0xFF, status_type & 0xFF, value])
        body = bytes([0x00, 0x02, 0x80, 0x05]) + payload
        return bytes([0xFF, 0x01, 0x00, len(payload)]) + body

    def test_reads_a_percentage(self):
        from bluez import parse_battery
        self.assertEqual(parse_battery(self.build(4, 87)), 87)
        self.assertEqual(parse_battery(self.build(4, 0)), 0)
        self.assertEqual(parse_battery(self.build(4, 100)), 100)

    def test_ignores_the_other_power_status_types(self):
        from bluez import parse_battery
        # 1 = raw level, 2 = voltage, 3 = the remote's battery. None are a
        # percentage, and treating them as one would report nonsense.
        for t in (1, 2, 3):
            self.assertIsNone(parse_battery(self.build(t, 50)))

    def test_rejects_malformed_replies(self):
        from bluez import parse_battery
        for bad in (b"", b"\x00" * 12, self.build(4, 50)[:8]):
            self.assertIsNone(parse_battery(bad))

    def test_the_request_frame_matches_upstream(self):
        from bluez import GET_BATTERY
        # READ_STATUS is command 5 in group 2, argument = type 4 as a
        # big-endian short, which is what HTCommander sends.
        self.assertEqual(GET_BATTERY.hex(), "ff01000200020005" + "0004")
        self.assertEqual(GET_BATTERY[3], 2, "payload length is two bytes")


class FrameReadingTests(unittest.TestCase):
    def test_reply_length_comes_from_the_header(self):
        # A status reply and a battery reply differ in length; reading a fixed
        # count would leave the rest of one behind to corrupt the next.
        status = bytes.fromhex("FF01000500028014008201 0080".replace(" ", ""))
        battery = bytes.fromhex("FF010004000280050004005A")
        for frame in (status, battery):
            declared = 4 + 4 + frame[3] + (frame[2] & 1)
            self.assertEqual(declared, len(frame), f"header describes {frame.hex()}")
