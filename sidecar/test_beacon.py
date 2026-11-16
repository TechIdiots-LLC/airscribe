"""The radio's beacon (its BSS settings) and its position reports, against
FakeRadio (test_radio_controls.py), laid out as HTCommander's RadioBssSettings."""
import time
import unittest
from unittest import mock

import bluez
from bluez import bss_payload, parse_bss
from test_radio_controls import FakeRadio, coord, link_to, reply


def quick(test):
    def run(self):
        with mock.patch.object(bluez, "time", wraps=time) as t:
            t.sleep = lambda _s: None
            test(self)
    return run


class BeaconTests(unittest.TestCase):
    def test_the_block_read(self):
        b = parse_bss(reply(33, 0, FakeRadio().bss))
        self.assertEqual((b["callsign"], b["ssid"], b["symbol"], b["beacon"]), ("N0CALL", 7, "/[", "hello"))
        self.assertEqual((b["share_location"], b["share_interval"], b["ptt_send_location"], b["format"]),
                         (False, 300, False, "aprs"))
        self.assertTrue(b["send_voltage"])
        self.assertEqual(b["ptt_id_text"], "ID TEXT")

    def test_a_change_keeps_everything_else(self):
        raw = FakeRadio().bss
        new = bss_payload(raw, {"callsign": "n1abc", "ssid": 9, "share_location": True, "share_interval": 600})
        b = parse_bss(reply(33, 0, new))
        self.assertEqual((b["callsign"], b["ssid"], b["share_location"], b["share_interval"]), ("N1ABC", 9, True, 600))
        self.assertEqual(new[4:8], raw[4:8], "the BSS user id, which isn't modelled")
        self.assertEqual(new[0], raw[0])
        self.assertEqual(new[1] & 0x08, 0x08, "and the flags not changed")
        for bad in ({"callsign": "TOOLONG1"}, {"callsign": "ABCDEF"}, {"ssid": 16}, {"symbol": "x"},
                    {"beacon": "nineteen characters"}, {"share_interval": 15}, {"format": "dstar"}, {"colour": 1}):
            with self.assertRaises(ValueError, msg=bad):
                bss_payload(raw, bad)

    @quick
    def test_writing_reads_back_and_asks_for_the_position_when_sharing(self):
        radio = FakeRadio()
        link, _ = link_to(radio)
        after = link.write_bss({"callsign": "N1ABC", "ssid": 9, "symbol": "/>", "beacon": "Mobile",
                                "share_location": True, "share_interval": 600})
        self.assertEqual((after["callsign"], after["ssid"], after["symbol"], after["beacon"]), ("N1ABC", 9, "/>", "Mobile"))
        self.assertIn((6, bytes([13])), radio.sent, "sharing: the radio sends beacons only while its position is asked for")
        radio.sent.clear()
        link.write_bss({"share_location": False})
        self.assertNotIn((6, bytes([13])), radio.sent, "not when it isn't sharing")
        radio.take_writes = False
        with self.assertRaisesRegex(RuntimeError, "didn't take the change to beacon"):
            link.write_bss({"beacon": "ignored"})

    def test_position_notifications_move_the_radio(self):
        radio = FakeRadio()
        link, events = link_to(radio)
        body = bytes([13]) + coord(42.3601) + coord(-71.8551) + bytes([0, 190, 0, 0, 0, 0]) + bytes(4)
        radio.strays = [bytes([0xFF, 0x01, 0x00, len(body), 0x00, 0x02, 0x00, 0x09]) + body]
        link.volume()
        moved = [e for e in events if e["event"] == "radio-position"]
        self.assertEqual(len(moved), 1)
        self.assertAlmostEqual(moved[0]["lat"], 42.3601, places=3)
        self.assertAlmostEqual(moved[0]["lon"], -71.8551, places=3)


if __name__ == "__main__":
    unittest.main()
