"""The SDS150's Bluetooth framing and transmissions (sds.py), with no scanner and no Bluetooth."""
import base64
import os
import unittest

import sds

HERE = os.path.dirname(os.path.abspath(__file__))
# A 600 Hz tone as the scanner's audio is coded: Opus, wideband CELT, 20 ms, mono (TOC byte B8)
with open(os.path.join(HERE, "testdata", "opus-celt-wb-tone.hex")) as f:
    TONE = [bytes.fromhex(line) for line in f.read().split()]


def scanner_frame(seq, kind, data):
    """A frame as the scanner sends one: its sequence number and a field, no acknowledgement."""
    payload = seq.to_bytes(2, "big") + bytes([kind]) + len(data).to_bytes(2, "big") + data
    return sds.MAGIC + len(payload).to_bytes(2, "big") + payload + sds.checksum(payload).to_bytes(2, "big")


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FramingTests(unittest.TestCase):
    def test_gst_is_framed_as_the_app_frames_it(self):
        # The app's first two polls in the capture: nothing heard yet, then the scanner's 0x32nd frame
        self.assertEqual(sds.gst(0).hex(), "095054000c0000ffffc00005814753540d043f")
        self.assertEqual(sds.gst(1, 0x32).hex(), "095054000c00010032c00005814753540d0274")

    def test_frames_come_out_however_the_notifications_cut_them(self):
        tick = bytes.fromhex("09505400060001af0001b50166")    # the scanner's own, from the capture
        r = sds.FrameReader()
        self.assertEqual(r.feed(tick[:4]), [])
        self.assertEqual(r.feed(tick[4:]), [(1, 0xAF, b"\xb5")])
        two = scanner_frame(7, 0xA0, b"Springfield,Fire Dispatch") + scanner_frame(8, 0xA1, b"\x01" + TONE[0])
        got = r.feed(b"junk" + two)
        self.assertEqual([(s, k) for s, k, _ in got], [(7, 0xA0), (8, 0xA1)])
        self.assertEqual(got[1][2][1:], TONE[0])

    def test_a_frame_whose_sum_is_wrong_is_passed_over(self):
        bad = bytearray(scanner_frame(3, 0xA0, b"A,B"))
        bad[-1] ^= 1
        r = sds.FrameReader()
        self.assertEqual(r.feed(bytes(bad) + scanner_frame(4, 0xA0, b"C,D")), [(4, 0xA0, b"C,D")])
        self.assertEqual(r.bad, 1)

    def test_the_scanners_lines_are_read(self):
        self.assertEqual(sds.parse_start(b"Springfield,Fire Dispatch"),
                         {"system": "Springfield", "channel": "Fire Dispatch"})
        self.assertEqual(sds.parse_end(b"Springfield,Town of Springfield,Fire Dispatch, 154.250000MHz,,3\r"),
                         {"system": "Springfield", "department": "Town of Springfield", "channel": "Fire Dispatch",
                          "frequency": "154.250000MHz"})
        self.assertEqual(sds.parse_end(b"County P25,Sheriff,SO Dispatch, 851.012500MHz,1201,3\r")["talkgroup"], "1201")
        self.assertEqual(sds.parse_start(b"nothing"), {})


class OggTests(unittest.TestCase):
    def test_ogg_pages_carry_a_good_checksum(self):
        ogg = sds.ogg_opus(TONE[:3])
        self.assertTrue(ogg.startswith(b"OggS"))
        # Page 0 is OpusHead; zero its CRC and recompute it as Ogg does
        n = 27 + ogg[26]
        body = 19
        page = bytearray(ogg[:n + body])
        crc = page[22:26]
        page[22:26] = bytes(4)
        self.assertEqual(sds._crc(page).to_bytes(4, "little"), bytes(crc))

    @unittest.skipUnless(sds.find_decoder(), "needs ffmpeg")
    def test_the_scanners_opus_decodes(self):
        pcm = sds.decode(TONE, sds.find_decoder())
        self.assertAlmostEqual(len(pcm) / 2 / sds.RATE, len(TONE) * 0.02, delta=0.03)
        samples = memoryview(pcm).cast("h")
        self.assertGreater(max(abs(s) for s in samples), 3000, "a tone, not silence")


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.sent = []
        self.clock = Clock()
        self.link = sds.ScannerLink("DE:B8:5F:00:00:01", self.events.append, self.sent.append,
                                    decoder=sds.find_decoder(), clock=self.clock)

    def of(self, kind):
        return [e for e in self.events if e["event"] == kind]

    def kinds(self):
        return [e["event"] for e in self.events if e["event"] not in ("audio", "run-stats")]

    def transmission(self, seq=10, start=b"Springfield,Fire Dispatch",
                     end=b"Springfield,Town of Springfield,Fire Dispatch, 154.250000MHz,,3\r"):
        """What the scanner sends for one: audio, its A0 with the first packet, its A2 just after."""
        for i, pkt in enumerate(TONE):
            self.link.on_notify(scanner_frame(seq + i, 0xA1, bytes([i]) + pkt))
            if i == 0 and start:
                self.link.on_notify(scanner_frame(seq + 100, 0xA0, start))
            self.clock.t += 0.02
            if i % 10 == 9:
                self.link.tick()
        self.clock.t += 0.2
        if end:
            self.link.on_notify(scanner_frame(seq + 101, 0xA2, end))

    def test_a_transmission_is_announced_labelled_and_handed_over(self):
        self.transmission()
        self.assertEqual(self.kinds(), ["audio-start", "scanner-channel"], "announced while it's coming in")
        self.assertEqual(self.of("scanner-channel")[0]["channel"], "Fire Dispatch")
        self.clock.t += 0.3
        self.link.tick()
        self.assertEqual(len(self.kinds()), 2, "a pause shorter than the gap isn't the end")
        self.clock.t += sds.GAP_SECONDS
        self.link.tick()
        self.assertEqual(self.kinds(), ["audio-start", "scanner-channel", "scanner-channel", "audio-end"])
        label = self.of("scanner-channel")[-1]
        self.assertEqual((label["department"], label["frequency"]), ("Town of Springfield", "154.250000MHz"),
                         "the line that follows it is in its label")
        if self.link.decoder:
            pcm = b"".join(base64.b64decode(e["pcm"]) for e in self.of("audio"))
            self.assertAlmostEqual(len(pcm) / 2 / sds.RATE, len(TONE) * 0.02, delta=0.03)
            self.assertEqual(self.of("run-stats")[0]["frames"], len(TONE))

    def test_packets_it_dropped_are_silence_in_their_place(self):
        # As through a slow link: counters 0, 1, then 5 and 7, three and one dropped
        for counter, pkt in zip((0, 1, 5, 7), TONE):
            self.link.on_notify(scanner_frame(counter, 0xA1, bytes([counter]) + pkt))
        self.clock.t += sds.GAP_SECONDS
        self.link.tick()
        stats = self.of("run-stats")[0]
        self.assertEqual((stats["frames"], stats["missing"]), (8, 4), "the gaps filled, and counted")
        if self.link.decoder:
            pcm = b"".join(base64.b64decode(e["pcm"]) for e in self.of("audio"))
            self.assertAlmostEqual(len(pcm) / 2 / sds.RATE, 8 * 0.02, delta=0.03, msg="as long as it was sent")

    def test_it_polls_with_what_it_heard_last(self):
        self.link.tick()
        self.link.on_notify(bytes.fromhex("09505400060032af00015c013e"))   # the scanner's 0x32nd, from the capture
        self.link.tick()
        self.assertEqual(self.sent[0], sds.gst(0, 0xFFFF))
        self.assertEqual(self.sent[1], sds.gst(1, 0x32))

    def test_an_a0_from_long_before_isnt_the_next_ones(self):
        self.link.on_notify(scanner_frame(1, 0xA0, b"Old,Channel"))
        self.clock.t += 30
        self.transmission(start=None, end=None)
        self.clock.t += sds.GAP_SECONDS
        self.link.tick()
        self.assertEqual(self.of("scanner-channel"), [], "no label is better than a stale one")
        self.assertEqual(self.kinds(), ["audio-start", "audio-end"])

    def test_a_quiet_scanner_is_noticed(self):
        self.assertTrue(self.link.tick())
        self.clock.t += sds.SILENT_SECONDS + 1
        self.assertFalse(self.link.tick())
        self.assertIn("hasn't answered", self.of("sidecar-error")[0]["error"])

    def test_closing_mid_transmission_still_hands_it_over(self):
        self.link.on_notify(scanner_frame(1, 0xA1, b"\x00" + TONE[0]))
        self.link.close()
        self.assertEqual(self.kinds(), ["audio-start", "audio-end", "status"])
        self.assertEqual(self.events[-1]["state"], "disconnected")
        self.link.close()
        self.assertEqual(len(self.of("status")), 1, "said once")


def gst_text(lines, tail):
    """A GST reply as the scanner words one: the font bits, each line and its mode, then the tail."""
    form = "".join("1" if large else "0" for _, _, large in lines)
    return ("GST," + form + "," + ",".join(f"{t},{m}" for t, m, _ in lines) + "," + ",".join(tail) + "\r").encode()


WATERFALL = gst_text(
    [("              Nov19  0:11     ", "", False), ("SPAN:2.88MHz    GAIN:Auto     ", "", False),
     ("CF:97.9000MHz   VOL: 0 SQL: 2 ", "", False),
     (" to Scan     SPAN      HOLD   ", "********* ********** *********", False)],
    ["1", "0", "0", "1", "00979000", "FMB", "120", "00979000", "00964600", "00993400", "0", "1"])


def pieces(seq, text, size=200):
    """A reply cut as the scanner cuts a long one: 0x01 on the first piece, 0x80 set on the last."""
    parts = [text[i:i + size] for i in range(0, len(text), size)]
    out = b""
    for i, part in enumerate(parts):
        flag = (0x01 if i == 0 else 0x02) | (0x80 if i == len(parts) - 1 else 0)
        out += scanner_frame(seq + i, 0xC0, bytes([flag]) + part)
    return out


class ScreenTests(unittest.TestCase):
    def test_a_gst_reply_is_the_screen(self):
        s = sds.parse_gst(WATERFALL)
        self.assertEqual(len(s["lines"]), 4)
        self.assertEqual(s["lines"][3]["mode"], "********* ********** *********", "the soft keys' labels, highlighted")
        self.assertEqual((s["mode"], s["muted"], s["led"]), ("waterfall", True, 0))
        self.assertEqual(s["waterfall"], {"hz": 97900000, "mod": "FMB", "marker": 120, "center_hz": 97900000,
                                          "lower_hz": 96460000, "upper_hz": 99340000})
        quick = sds.parse_gst(gst_text([("Quick Key Navigation    ", "________________________", True),
                                        ("415                     ", "   *                    ", True)],
                                       ["1", "0", "0", "", "", "", "", "", "", "", "0", ""]))
        self.assertEqual((quick["mode"], quick["lines"][1]["large"]), ("normal", True))
        self.assertNotIn("waterfall", quick)
        self.assertIsNone(sds.parse_gst(b"KEY,OK\r"))


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.sent = []
        self.clock = Clock()
        self.link = sds.ScannerLink("DE:B8:5F:00:00:01", self.events.append, self.sent.append, clock=self.clock)
        self.addCleanup(self.link.stop.set)

    def texts(self):
        out = []
        for msg in self.sent:
            payload = msg[5:-2]
            out.append(payload[8:].decode().strip("\r"))   # seq, ack, type, length, 0x81
        return out

    def of(self, kind):
        return [e for e in self.events if e["event"] == kind]

    def test_a_long_reply_is_put_back_together_and_sent_once_changed(self):
        self.link.on_notify(pieces(1, WATERFALL))
        self.link.tick()
        screens = self.of("scanner-screen")
        self.assertEqual(len(screens), 1)
        self.assertEqual(screens[0]["lines"][2]["text"], "CF:97.9000MHz   VOL: 0 SQL: 2 ")
        self.link.on_notify(pieces(10, WATERFALL))
        self.link.tick()
        self.assertEqual(len(self.of("scanner-screen")), 1, "the same screen again isn't sent again")
        # The end of a reply whose start was missed is no screen at all
        self.link.on_notify(scanner_frame(20, 0xC0, b"\x82PT     CHANNEL ,*****\r"))
        self.link.tick()
        self.assertEqual(len(self.of("scanner-screen")), 1)

    def test_a_key_is_pressed_then_let_go(self):
        self.link.press("M", hold_ms=50)
        self.assertTrue(wait(lambda: len(self.sent) == 2))
        self.assertEqual(self.texts(), ["KEY,M,H", "KEY,M,R"])
        self.link.press(">")
        self.assertEqual(self.texts()[-1], "KEY,>,R", "the knob only turns")
        self.assertEqual(len(self.sent), 3)
        with self.assertRaises(ValueError):
            self.link.press("KEY,M,H")

    def test_the_waterfall_is_asked_for_only_while_wanted(self):
        self.link.tick()
        self.assertEqual(self.texts(), ["GST"])
        self.link.waterfall(1)
        self.link.tick()
        self.assertEqual(self.texts()[-2:], ["GST", "GW2,1,ON"])
        self.clock.t += 0.2
        self.link.tick()
        self.assertEqual(self.texts()[-1], "GST", "not more often than the app asks")
        levels = bytes(range(240))
        self.link.on_notify(pieces(5, b"GW2," + levels + b"\r"))
        self.clock.t += 0.2
        self.link.tick()
        self.assertEqual(base64.b64decode(self.of("scanner-waterfall")[0]["levels"]), levels)
        self.clock.t += 1
        n = len(self.sent)
        self.link.tick()
        self.assertEqual(self.texts()[n:], ["GST"], "and stops when nobody asks again")


def wait(pred, seconds=3):
    import time
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


if __name__ == "__main__":
    unittest.main()
