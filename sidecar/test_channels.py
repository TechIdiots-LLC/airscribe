"""Whole channels: the 25-byte record, reading a region, writing and reading back.

Against FakeRadio (test_radio_controls.py), which keeps records as a radio
does and answers WRITE_RF_CH. What it can't prove is that a real UV-Pro takes
the writes; that's checked on the radio itself.
"""
import time
import unittest
from unittest import mock

import bluez
from bluez import (channel_record, decode_channel, encode_channel, same_channel, tone_name, tone_value)
from test_radio_controls import FakeRadio, link_to

STATION = {"id": 4, "name": "RUTLAND FD", "rx_hz": 154250000, "tx_hz": 154250000, "mod": "FM",
           "bandwidth": "narrow", "rx_tone": "100.0", "tx_tone": "100.0", "scan": True,
           "power": "low", "tx_disable": True}


def quick(test):
    """Region changes wait on the radio; not in a test."""
    def run(self):
        with mock.patch.object(bluez, "time", wraps=time) as t:
            t.sleep = lambda _s: None
            test(self)
    return run


class RecordTests(unittest.TestCase):
    def test_tones_both_ways(self):
        self.assertEqual((tone_name(12730), tone_name(23), tone_name(0)), ("127.3", "D023", ""))
        self.assertEqual((tone_value("127.3"), tone_value("d023"), tone_value(""), tone_value(None)), (12730, 23, 0, 0))
        self.assertEqual(tone_value("67"), 6700)
        for bad in ("D089", "D02", "12", "300.0", "PL"):
            with self.assertRaises(ValueError, msg=bad):
                tone_value(bad)

    def test_a_station_round_trips_through_its_record(self):
        rec = encode_channel(STATION)
        self.assertEqual(len(rec), 25)
        ch = decode_channel(rec)
        for k, v in STATION.items():
            self.assertEqual(ch[k], v, k)
        self.assertFalse(ch["empty"])
        self.assertEqual(bytes.fromhex(ch["raw"]), rec)

    def test_the_layout_htcommander_writes(self):
        rec = encode_channel({**STATION, "mod": "AM", "bandwidth": "wide", "power": "medium", "scan": False})
        self.assertEqual(rec[0], 4)
        self.assertEqual(rec[1] >> 6, 1, "AM in the transmit frequency's top bits")
        self.assertEqual(rec[5] >> 6, 1, "and the receive frequency's")
        self.assertEqual(((rec[5] & 0x3F) << 24) | (rec[6] << 16) | (rec[7] << 8) | rec[8], 154250000)
        self.assertEqual((rec[11] << 8) | rec[12], 10000, "receive tone in hundredths of a hertz")
        self.assertEqual(rec[13], 0x10 | 0x02 | 0x01, "wide, medium power, transmit off; no scan")
        self.assertEqual(rec[15:25], b"RUTLAND FD")

    def test_what_the_existing_parser_reads_from_it(self):
        frame = bytes([0xFF, 0x01, 0x00, 26, 0x00, 0x02, 0x80, 0x0D, 0x00]) + encode_channel(STATION)
        ch = bluez.parse_channel(frame)
        self.assertEqual((ch["id"], ch["name"], ch["rx_hz"], ch["scan"]), (4, "RUTLAND FD", 154250000, True))

    def test_an_empty_slot(self):
        rec = encode_channel({"id": 7})
        self.assertEqual(rec, bytes([7]) + bytes(24))
        self.assertTrue(decode_channel(rec)["empty"])
        self.assertTrue(same_channel(rec, bytes([7]) + bytes(12) + bytes([0x50]) + bytes(11)),
                        "an empty slot's leftover flags don't matter")
        self.assertFalse(same_channel(rec, bytes([8]) + bytes(24)), "but its slot does")

    def test_what_isn_t_a_channel(self):
        for bad in ({**STATION, "id": 256}, {**STATION, "id": True}, {**STATION, "rx_hz": -1},
                    {**STATION, "mod": "DMR"}, {**STATION, "bandwidth": "medium"}, {**STATION, "power": "max"},
                    {**STATION, "name": "ELEVEN CHAR"}, {**STATION, "name": "Café"}, {**STATION, "rx_tone": "D999"}):
            with self.assertRaises(ValueError, msg=bad):
                encode_channel(bad)

    def test_a_change_to_some_fields_keeps_every_other_bit(self):
        # Flags this doesn't model (0x08 de-emphasis bypass, 0x04, fixed bits in
        # byte 14) and a name with a byte after its end: all must survive
        rec = bytearray(encode_channel({**STATION, "mod": "AM", "bandwidth": "wide"}))
        rec[13] |= 0x08 | 0x04
        rec[14] |= 0x80 | 0x20
        rec = bytes(rec)
        off = bluez.patch_record(rec, {"scan": False})
        self.assertEqual(off[13], rec[13] & ~0x80, "only the scan bit")
        self.assertEqual(off[:13] + off[14:], rec[:13] + rec[14:], "and nothing else")
        renamed = bluez.patch_record(rec, {"name": "HOLDEN"})
        self.assertEqual(renamed[15:25], b"HOLDEN\x00\x00\x00\x00")
        self.assertEqual(renamed[:15], rec[:15])
        moved = decode_channel(bluez.patch_record(rec, {"rx_hz": 155880000}))
        self.assertEqual((moved["rx_hz"], moved["tx_hz"], moved["mod"]), (155880000, 154250000, "AM"),
                         "a frequency keeps the modulation bits")
        fm = decode_channel(bluez.patch_record(rec, {"mod": "FM", "bandwidth": "narrow", "power": "high",
                                                     "rx_tone": "D023", "tx_disable": False}))
        self.assertEqual((fm["mod"], fm["bandwidth"], fm["power"], fm["rx_tone"], fm["tx_disable"]),
                         ("FM", "narrow", "high", "D023", False))
        self.assertEqual(bluez.patch_record(rec, {"power": "medium"})[13] & 0x42, 0x02)
        for bad in ({"colour": "red"}, {"mod": "DMR"}, {"name": "ELEVEN CHAR"}, {"rx_hz": 0}, {"power": "max"}):
            with self.assertRaises(ValueError, msg=bad):
                bluez.patch_record(rec, bad)
        self.assertEqual(channel_record({"id": 4, "raw": rec.hex(), "set": {"scan": False}}), off,
                         "as the radio link is given it: the record read, and the change")

    def test_a_record_as_read_is_written_back_as_it_was(self):
        rec = encode_channel(STATION)[:20] + b"\xb5\xbe\xb5\xd8\x00"   # bits and bytes this doesn't model
        self.assertEqual(channel_record({"raw": rec.hex()}), rec)
        self.assertEqual(channel_record({"id": 9, "raw": rec.hex()})[0], 9, "moved to another slot")
        for bad in ({"raw": "zz"}, {"raw": "00" * 24}):
            with self.assertRaises(ValueError):
                channel_record(bad)


class RegionTests(unittest.TestCase):
    @quick
    def test_reading_a_region_reads_every_slot(self):
        radio = FakeRadio(slots=6)
        link, _ = link_to(radio)
        link.read_channels()
        got = link.read_region()
        self.assertEqual((got["region"], got["count"], len(got["channels"])), (0, 6, 6))
        self.assertEqual([c["name"] for c in got["channels"][:3]], ["Holden PD", "Rutld FD", "W1BIM"])
        self.assertTrue(all(c["empty"] for c in got["channels"][3:]), "the empty slots too, for a backup")

    @quick
    def test_reading_another_region_goes_there_and_back(self):
        radio = FakeRadio(slots=4)
        link, events = link_to(radio)
        link.read_channels()
        got = link.read_region(1)
        self.assertEqual([c["name"] for c in got["channels"][:2]], ["Boston FD", "Mass SP"])
        self.assertEqual(radio.region, 0, "the radio is back where it was")
        self.assertFalse(link.editing.is_set())
        self.assertEqual([e for e in events if e["event"] == "channels"][-1]["region"], 0,
                         "and its table wasn't read again for the region it only visited")

    @quick
    def test_writing_reads_each_channel_back_and_the_table_again(self):
        radio = FakeRadio(slots=6)
        link, events = link_to(radio)
        link.read_channels()
        got = link.write_region(None, [STATION, {"id": 5, "name": "W1XM", "rx_hz": 147000000}])
        self.assertEqual([r["ok"] for r in got["results"]], [True, True])
        self.assertEqual(got["results"][0]["channel"]["name"], "RUTLAND FD")
        self.assertEqual(decode_channel(radio.records[0][4])["rx_tone"], "100.0", "the radio has it")
        writes = [p for c, p in radio.sent if c == 14]
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0], encode_channel(STATION))
        self.assertEqual(events[-1]["event"], "channels", "the names are read again")
        self.assertIn("RUTLAND FD", [c["name"] for c in events[-1]["channels"]])

    @quick
    def test_writing_another_region_comes_back(self):
        radio = FakeRadio(slots=4)
        link, events = link_to(radio)
        link.read_channels()
        before = len([e for e in events if e["event"] == "channels"])
        got = link.write_region(1, [{**STATION, "id": 3}])
        self.assertTrue(got["results"][0]["ok"])
        self.assertEqual(got["region"], 1)
        self.assertEqual(radio.region, 0)
        self.assertEqual(decode_channel(radio.records[1][3])["name"], "RUTLAND FD")
        self.assertEqual(len([e for e in events if e["event"] == "channels"]), before,
                         "the table for the region the radio's on hasn't changed")

    @quick
    def test_a_backup_put_back_is_byte_for_byte(self):
        radio = FakeRadio(slots=4)
        link, _ = link_to(radio)
        link.read_channels()
        backup = link.read_region()["channels"]
        link.write_region(None, [{**STATION, "id": 0}, {"id": 1}])
        self.assertEqual(decode_channel(radio.records[0][0])["name"], "RUTLAND FD")
        got = link.write_region(None, [{"id": c["id"], "raw": c["raw"]} for c in backup])
        self.assertTrue(all(r["ok"] for r in got["results"]))
        self.assertEqual([r.hex() for r in radio.records[0]], [c["raw"] for c in backup])

    @quick
    def test_a_refused_or_changed_write_is_reported_and_the_rest_written(self):
        radio = FakeRadio(slots=6)
        link, _ = link_to(radio)
        link.read_channels()
        radio.channel_status = 2
        got = link.write_region(None, [STATION])
        self.assertEqual(got["results"][0], {"id": 4, "ok": False, "error": "the radio refused it"})
        radio.channel_status = 0
        radio.mangle = lambda rec: rec[:15] + b"OTHER".ljust(10, b"\x00")
        got = link.write_region(None, [STATION, {**STATION, "id": 5}])
        self.assertEqual([r["ok"] for r in got["results"]], [False, False])
        self.assertIn("something other", got["results"][0]["error"])
        self.assertEqual(got["results"][0]["channel"]["name"], "OTHER", "what it kept is shown")
        radio.mangle = None
        radio.take_channels = False
        got = link.write_region(None, [STATION])
        self.assertFalse(got["results"][0]["ok"], "answered, but not kept")

    @quick
    def test_what_isn_t_written_at_all(self):
        radio = FakeRadio(slots=4)
        link, _ = link_to(radio)
        link.read_channels()
        with self.assertRaisesRegex(ValueError, "no channel 5"):
            link.write_region(None, [STATION])
        with self.assertRaisesRegex(ValueError, "given twice"):
            link.write_region(None, [{**STATION, "id": 1}, {**STATION, "id": 1}])
        with self.assertRaisesRegex(ValueError, "region is 0 to 1"):
            link.write_region(2, [{**STATION, "id": 1}])
        self.assertEqual([c for c, _ in radio.sent if c == 14], [], "none of them reached the radio")

    @quick
    def test_the_status_poll_leaves_the_table_alone_while_a_region_is_visited(self):
        radio = FakeRadio(slots=4)
        link, events = link_to(radio)
        link.read_channels()
        link.editing.set()
        radio.region = 1
        with mock.patch.object(bluez, "STATUS_PERIOD", 0):
            original = link.stop.wait
            calls = []

            def once(_t):
                calls.append(1)
                link.stop.set()
                return original(0)
            link.stop.wait = once
            link._poll_status()
        self.assertEqual([e for e in events if e["event"] == "channels"][-1]["region"], 0)


if __name__ == "__main__":
    unittest.main()
