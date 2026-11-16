"""Packets the radio's own modem decoded: DATA_RXD notifications, put back
together from their fragments, and KISS frames among the replies, against
FakeRadio (test_radio_controls.py). What it can't prove is which a real UV-Pro
sends unasked; that's checked on the radio, tuned to an APRS frequency."""
import socket
import unittest

from airscribe_sidecar import SimBackend, ax25_frame, bss_packet
from bluez import FEND, FESC, TFEND, TFESC, RadioLink, kiss_unescape
from test_radio_controls import FakeRadio, link_to


def notify(kind, payload):
    """An EVENT_NOTIFICATION frame, as the radio sends one unasked."""
    body = bytes([kind]) + bytes(payload)
    return bytes([0xFF, 0x01, 0x00, len(body), 0x00, 0x02, 0x00, 0x09]) + body


def fragment(number, data, final=False, channel=None):
    flags = (0x80 if final else 0) | (0x40 if channel is not None else 0) | (number & 0x3F)
    return notify(2, bytes([flags]) + data + (bytes([channel]) if channel is not None else b""))


FRAME = ax25_frame("N1HLD-9", "APRS", ["WIDE1-1"], "!4221.06N/07151.78W>090/035/A=000620 Mobile")


def kiss(body, kind=0x00):
    """A KISS frame as a TNC sends one: FEND, the type byte, the contents with FEND and FESC escaped, FEND."""
    out = bytearray([FEND, kind])
    for c in body:
        out += bytes([FESC, TFEND]) if c == FEND else bytes([FESC, TFESC]) if c == FESC else bytes([c])
    return bytes(out + bytes([FEND]))


class PacketTests(unittest.TestCase):
    def test_kiss_frames_among_the_replies_are_packets_and_leave_the_replies_in_step(self):
        radio = FakeRadio()
        link, events = link_to(radio)
        link.channel = 3
        # A FEND and an FESC inside the frame, sent escaped
        awkward = ax25_frame("W1BIM", "APRS", [], ">tones \xc0 and \xdb")
        radio.strays = [kiss(FRAME), b"\x00\x13\x37", kiss(awkward), kiss(b"\x05", kind=0x06), bytes([FEND, FEND])]
        st = link.status()
        self.assertIsNotNone(st, "the status reply comes through after them")
        packets = [e for e in events if e["event"] == "packet"]
        self.assertEqual([bytes.fromhex(p["data"]) for p in packets], [FRAME, awkward],
                         "data frames only, unescaped; junk between them and a command frame left out")
        self.assertEqual([p["channel"] for p in packets], [3, 3], "on the channel the radio is on")
        self.assertEqual({p["via"] for p in packets}, {"kiss"})
        self.assertEqual(link.volume(), 7, "and the next question gets its own answer")
        # The tail of a frame whose start was missed, then a reply: the reply still comes
        radio.strays = [kiss(FRAME)[9:]]
        self.assertIsNotNone(link.status())
        self.assertEqual(link.volume(), 7)

    def test_kiss_unescape(self):
        self.assertEqual(kiss_unescape(bytes([1, FESC, TFEND, 2, FESC, TFESC, 3])), bytes([1, FEND, 2, FESC, 3]))

    def test_fragments_read_as_the_status_poll_goes_become_one_packet(self):
        radio = FakeRadio()
        link, events = link_to(radio)
        radio.strays = [fragment(0, FRAME[:20]), notify(1, b"\x00\x01"), fragment(1, FRAME[20:40])]
        self.assertIsNotNone(link.status(), "the status reply still comes through")
        self.assertEqual([e for e in events if e["event"] == "packet"], [], "not until the last fragment")
        radio.strays = [fragment(2, FRAME[40:], final=True, channel=4)]
        link.status()
        packets = [e for e in events if e["event"] == "packet"]
        self.assertEqual(len(packets), 1)
        self.assertEqual(bytes.fromhex(packets[0]["data"]), FRAME, "the fragments in order, the channel byte off")
        self.assertEqual(packets[0]["channel"], 4)

    def test_a_gap_drops_the_packet_and_the_next_one_still_comes(self):
        radio = FakeRadio()
        link, events = link_to(radio)
        link.channel = 2
        radio.strays = [fragment(0, b"\x01\x02"), fragment(2, b"\x03", final=True)]
        link.volume()
        self.assertEqual([e for e in events if e["event"] == "packet"], [], "fragment 1 never came")
        radio.strays = [fragment(1, b"\x09", final=True), fragment(0, FRAME, final=True)]
        link.volume()
        packets = [e for e in events if e["event"] == "packet"]
        self.assertEqual(len(packets), 1, "a fragment with nothing before it is dropped too")
        self.assertEqual(bytes.fromhex(packets[0]["data"]), FRAME)
        self.assertEqual(packets[0]["channel"], 2, "no channel byte: the one the radio is on")

    def test_connecting_asks_the_radio_to_report(self):
        radio = FakeRadio()

        class Quiet:
            def settimeout(self, _t):
                pass

            def recv(self, _n):
                raise socket.timeout("timed out")

            def shutdown(self, _how=None):
                pass

            def close(self):
                pass

        link = RadioLink("38:D2:00:01:56:51", lambda e: None, control_ch=1, audio_ch=2,
                         opener=lambda mac, ch, timeout: radio if ch == 1 else Quiet())
        try:
            link.open()
            self.assertIn((6, b"\x01"), radio.sent, "REGISTER_NOTIFICATION for status changes, as HTCommander does")
        finally:
            link.close()

    def test_the_simulated_radio_s_packets(self):
        frames = SimBackend.SIM_PACKETS
        self.assertTrue(all(isinstance(f, bytes) and len(f) > 16 for f in frames))
        bss = bss_packet("N1BSS", "hi", 42.3551, -71.8702)
        self.assertEqual(bss[:2], b"\x01\x06", "0x01, then the from field's length")
        self.assertEqual(bss[2], 0x20)
        # The location as the radio gives its own: 24-bit signed minutes x 500
        loc = bss[bss.index(b"\x07\x25") + 2:]
        lat = int.from_bytes(loc[:3], "big")
        lon = int.from_bytes(loc[3:6], "big") - (1 << 24)
        self.assertAlmostEqual(lat / 500 / 60, 42.3551, places=4)
        self.assertAlmostEqual(lon / 500 / 60, -71.8702, places=4)
        # An address: shifted ASCII, the SSID, and the last one marked
        frame = ax25_frame("N1HLD-9", "APRS", ["W1BIM*"], "x")
        self.assertEqual(bytes(b >> 1 for b in frame[:6]), b"APRS  ")
        self.assertEqual(frame[13] & 0x1E, 9 << 1, "source SSID 9")
        self.assertEqual(frame[20] & 0x81, 0x81, "the digipeater repeated it, and is the last address")
        self.assertEqual(frame[21:23], b"\x03\xf0", "UI frame, no layer 3")


if __name__ == "__main__":
    unittest.main()
