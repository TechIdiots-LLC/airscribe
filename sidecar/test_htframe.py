import unittest

from htframe import ESC, FLAG, FrameReader, escape, unescape


class FrameTests(unittest.TestCase):
    def test_roundtrip_with_reserved_bytes(self):
        payload = bytes([1, FLAG, 2, ESC, 3])
        frame = escape(0x03, payload)
        self.assertEqual(frame.count(FLAG), 2)  # only the delimiters
        self.assertEqual(unescape(frame[2:-1]), payload)

    def test_reader_splits_frames_across_chunks(self):
        wire = escape(0x03, b"abc") + escape(0x01, b"") + escape(0x03, bytes([FLAG]))
        r = FrameReader()
        got = []
        for i in range(0, len(wire), 2):  # deliver two bytes at a time
            got += list(r.feed(wire[i : i + 2]))
        self.assertEqual(got, [(0x03, b"abc"), (0x01, b""), (0x03, bytes([FLAG]))])

    def test_reader_skips_leading_garbage(self):
        got = list(FrameReader().feed(b"\x00\x11" + escape(0x00, b"x")))
        self.assertEqual(got, [(0x00, b"x")])

    def test_shared_flag_between_frames(self):
        # 7E 03 41 7E 03 42 7E — the middle flag closes one and opens the next
        got = list(FrameReader().feed(bytes([FLAG, 3, 0x41, FLAG, 3, 0x42, FLAG])))
        self.assertEqual(got, [(3, b"A"), (3, b"B")])

    def test_runaway_buffer_is_dropped(self):
        r = FrameReader(limit=64)
        list(r.feed(bytes([FLAG]) + b"x" * 100))
        self.assertEqual(len(r.buf), 0)


if __name__ == "__main__":
    unittest.main()
