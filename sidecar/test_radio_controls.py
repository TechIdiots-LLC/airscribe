"""The radio's settings, regions and position, against a fake control channel.

FakeRadio answers GAIA commands by id with the byte layouts in HTCommander's
protocol reference (Ylianst/HTCommander docs/blogs/radio-command-protocol.md),
so RadioLink can be tested without a radio. What it can't prove is that a real
UV-Pro takes the writes; that is checked on the radio itself.
"""
import socket
import threading
import time
import unittest
from unittest import mock

import bluez
from bluez import (RadioLink, gaia, parse_dev_info, parse_ht_status, parse_position, parse_region_name,
                   parse_settings, parse_volume, settings_payload)


def reply(cmd, status=0, payload=b""):
    body = bytes([status]) + bytes(payload)
    return bytes([0xFF, 0x01, 0x00, len(body), 0x00, 0x02, 0x80 | (cmd >> 8), cmd & 0xFF]) + body


def coord(v):
    raw = round(v * 60 * 500) & 0xFFFFFF
    return bytes([raw >> 16, (raw >> 8) & 0xFF, raw & 0xFF])


class FakeRadio:
    """A UV-Pro's control channel, as far as these tests need it."""

    def __init__(self, slots=None):
        self.region = 0
        self.regions = ["Local", "Travel"]
        self.tables = {0: ["Holden PD", "Rutld FD", "W1BIM"], 1: ["Boston FD", "Mass SP"]}
        # Whole records, made from the names when first asked for; `slots`
        # gives each region that many, the rest empty, as a real radio has
        self.slots = slots
        self.records = {}
        self.take_channels = True     # False: a write is answered but not kept
        self.channel_status = 0       # a WRITE_RF_CH reply's status
        self.mangle = None            # changes a record as it's kept
        # Its beacon: N0CALL-7, a person, "hello", sharing off, an ID text and a user id to keep
        bss = bytearray(46)
        bss[0], bss[1], bss[2], bss[3] = 0x31, 0x04 | 0x08, 7 << 4, 30
        bss[4:8] = (123456).to_bytes(4, "little")
        bss[8:20] = b"ID TEXT".ljust(12, b"\x00")
        bss[20:38] = b"hello".ljust(18, b"\x00")
        bss[38:40] = b"/["
        bss[40:46] = b"N0CALL"
        self.bss = bytes(bss)
        # channel_a 1, channel_b 2, squelch 3, and bytes that must survive a write
        self.settings = bytearray([0x12, 0x43] + [0x5D, 0xA1, 0x01, 0x0C, 0x20, 0x00, 0x00, 0x00]
                                  + [0x78, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        self.volume = 7
        self.position = (42.3601, -71.8551)
        self.write_replies = True     # older firmware sends none
        self.take_writes = True
        self.strays = []              # frames sent ahead of the next reply
        self.sent = []
        self.out = bytearray()
        self.lock = threading.Lock()

    def settimeout(self, _t):
        pass

    def shutdown(self, _how=None):
        pass

    def close(self):
        pass

    def status_frame(self):
        a = ((self.settings[0] & 0xF0) >> 4) | (self.settings[9] & 0xF0)
        dual = (self.settings[1] & 0x30) >> 4
        scan = bool(self.settings[1] & 0x80)
        gps = self.position is not None
        b5 = 0x80 | (dual << 2) | (0x02 if scan else 0)
        b6 = ((a & 0x0F) << 4) | (0x08 if gps else 0) | 0x02
        b7 = (5 << 4) | ((self.region >> 2) & 0x0F)
        b8 = ((self.region & 0x03) << 6) | (((a >> 4) & 0x0F) << 2)
        return reply(20, 0, [b5, b6, b7, b8])

    def answer(self, cmd, p):
        if cmd == 20:
            return self.status_frame()
        if cmd == 5:
            return reply(5, 0, [0x00, 0x04, 80])
        if cmd == 4:
            n = len(self.regions)
            return reply(4, 0, [0x1A, 0x00, 0x01, 0x01, 0x00, 0x05, (n >> 4) & 0x03, ((n & 0x0F) << 4) | 0x02,
                                self.slots or len(self.tables[self.region]), 0x10])
        if cmd == 13:
            return reply(13, 0, self.region_records()[p[0]])
        if cmd == 14:
            if self.channel_status:
                return reply(14, self.channel_status)
            if self.take_channels:
                rec = bytes(p)
                self.region_records()[rec[0]] = self.mangle(rec) if self.mangle else rec
            return reply(14, 0, bytes([p[0]]))
        if cmd == 10:
            return reply(10, 0, self.settings)
        if cmd == 11:
            if self.take_writes:
                self.settings = bytearray(p)
            return reply(11, 0) if self.write_replies else b""
        if cmd == 22:
            return reply(22, 0, [self.volume])
        if cmd == 23:
            self.volume = p[0]
            return reply(23, 0)
        if cmd == 60:
            self.region = p[0]
            return b""   # SET_REGION has no reply
        if cmd == 73:
            return reply(73, 0, bytes([p[0]]) + self.regions[p[0]].encode("gbk").ljust(10, b"\x00"))
        if cmd == 76:
            if self.position is None:
                return reply(76, 6)
            lat, lon = self.position
            return reply(76, 0, coord(lat) + coord(lon) + bytes([0, 190, 0, 0, 0, 0]) + bytes(6))
        if cmd == 6:
            return b""   # REGISTER_NOTIFICATION has no reply
        if cmd == 33:
            return reply(33, 0, self.bss)
        if cmd == 34:
            if self.take_writes:
                self.bss = bytes(p)
            return reply(34, 0)
        return reply(cmd, 1)   # notSupported

    def region_records(self):
        """The current region's slots, each a 25-byte record."""
        if self.region not in self.records:
            names = self.tables[self.region]
            recs = []
            for i in range(max(self.slots or 0, len(names))):
                name = names[i].encode() if i < len(names) else b""
                freq = (460387500 + i * 1000000).to_bytes(4, "big") if name else bytes(4)
                recs.append(bytes([i]) + freq + freq + bytes(4) + bytes([0x80, 0x00]) + name.ljust(10, b"\x00"))
            self.records[self.region] = recs
        return self.records[self.region]

    def sendall(self, data):
        cmd = (data[6] << 8) | data[7]
        payload = bytes(data[8:8 + data[3]])
        with self.lock:
            self.sent.append((cmd, payload))
            for s in self.strays:
                self.out += s
            self.strays = []
            self.out += self.answer(cmd, payload)

    def recv(self, n):
        with self.lock:
            if not self.out:
                raise socket.timeout("timed out")
            got = bytes(self.out[:n])
            del self.out[:n]
            return got


def link_to(radio):
    events = []
    link = RadioLink("38:D2:00:01:56:51", events.append)
    link.ctrl = radio
    return link, events


class ParserTests(unittest.TestCase):
    def test_status_carries_the_region_and_dual_watch(self):
        radio = FakeRadio()
        radio.region = 5
        radio.settings[1] |= 0x20   # dual watch, VFO B
        st = parse_ht_status(radio.status_frame())
        self.assertEqual((st["region"], st["dual"], st["channel"]), (5, 2, 1))

    def test_the_real_idle_reply_decodes_as_region_2(self):
        # The exact reply a real UV-Pro gave (test_bluez.py): byte 8 is 0x80,
        # whose top two bits are the region's low bits. So that radio was on
        # its third region when this was captured, by HTCommander's layout;
        # the controls on LXC 113 show the region a radio reports, to compare
        # with what its own display says.
        st = parse_ht_status(bytes.fromhex("FF010005000280140082010080"))
        self.assertEqual((st["region"], st["channel"], st["dual"]), (2, 0, 0))

    def test_settings_and_the_write_built_from_them(self):
        s = parse_settings(reply(10, 0, FakeRadio().settings))
        self.assertEqual((s["channel_a"], s["channel_b"], s["scan"], s["dual"], s["squelch"]), (1, 2, False, 0, 3))
        data = settings_payload(s["raw"], channel_a=0x1F, squelch=9, scan=True)
        again = parse_settings(reply(10, 0, data))
        self.assertEqual((again["channel_a"], again["channel_b"], again["scan"], again["squelch"]), (0x1F, 2, True, 9))
        self.assertEqual(data[1] & 0x40, 0x40, "the bit it doesn't model is kept")
        self.assertEqual(data[2:9], s["raw"][2:9], "and every other byte")
        self.assertEqual(data[10:], s["raw"][10:])

    def test_dev_info_volume_region_names_and_position(self):
        radio = FakeRadio()
        self.assertEqual(parse_dev_info(radio.answer(4, b""))["region_count"], 2)
        self.assertEqual(parse_dev_info(radio.answer(4, b""))["channel_count"], 3)
        self.assertEqual(parse_volume(radio.answer(22, b"")), 7)
        self.assertEqual(parse_region_name(radio.answer(73, bytes([1]))), (1, "Travel"))
        pos = parse_position(radio.answer(76, b""))
        self.assertAlmostEqual(pos["lat"], 42.3601, places=3)
        self.assertAlmostEqual(pos["lon"], -71.8551, places=3, msg="west is negative: 24-bit two's complement")
        radio.position = None
        self.assertIsNone(parse_position(radio.answer(76, b"")), "no fix, no position")

    def test_a_region_name_in_gbk(self):
        frame = reply(73, 0, bytes([0]) + "本地".encode("gbk").ljust(10, b"\x00"))
        self.assertEqual(parse_region_name(frame), (0, "本地"))


class LinkTests(unittest.TestCase):
    def test_a_reply_is_matched_to_its_request(self):
        radio = FakeRadio()
        link, _ = link_to(radio)
        # A late reply to something earlier, and a notification, ahead of the answer
        radio.strays = [reply(11, 0), bytes([0xFF, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x09, 0x01])]
        self.assertEqual(link.volume(), 7)
        self.assertEqual(link.status()["region"], 0, "and the next question gets its own answer")

    def test_the_channel_table_and_info(self):
        radio = FakeRadio()
        link, events = link_to(radio)
        link.read_channels()
        self.assertEqual([c["name"] for c in link.channels.values()], ["Holden PD", "Rutld FD", "W1BIM"])
        self.assertEqual(events[-1]["region"], 0)
        info = link.info()
        self.assertEqual(info["regions"], ["Local", "Travel"])
        self.assertEqual((info["volume"], info["region"], info["settings"]["channel_a"]), (7, 0, 1))
        self.assertNotIn("raw", info["settings"])

    def test_controls_write_what_is_asked_and_check_it_took(self):
        radio = FakeRadio()
        link, _ = link_to(radio)
        link.read_channels()
        info = link.control("squelch", 6)
        self.assertEqual(info["settings"]["squelch"], 6)
        self.assertEqual(radio.settings[2:9], bytearray([0x5D, 0xA1, 0x01, 0x0C, 0x20, 0x00, 0x00]),
                         "the radio's other settings came back as they were")
        self.assertEqual(link.control("channel_a", 2)["settings"]["channel_a"], 2)
        self.assertTrue(link.control("scan", True)["settings"]["scan"])
        self.assertEqual(link.control("volume", 12)["volume"], 12)
        self.assertEqual(link.control("dual", True)["settings"]["dual"], 1)
        # VFO B in dual watch also selects B, or the radio drops the change
        after = link.control("channel_b", 0)["settings"]
        self.assertEqual((after["channel_b"], after["dual"]), (0, 2))

    def test_a_write_without_a_reply_is_read_back(self):
        radio = FakeRadio()
        radio.write_replies = False
        link, _ = link_to(radio)
        link.read_channels()
        with mock.patch.object(bluez, "time", wraps=time) as t:
            t.sleep = lambda _s: None
            self.assertEqual(link.control("squelch", 1)["settings"]["squelch"], 1)

    def test_a_change_the_radio_ignores_is_an_error(self):
        radio = FakeRadio()
        radio.take_writes = False
        link, _ = link_to(radio)
        link.read_channels()
        with self.assertRaisesRegex(RuntimeError, "didn't take the change to squelch"):
            link.control("squelch", 8)

    def test_out_of_range_and_unknown_controls(self):
        link, _ = link_to(FakeRadio())
        link.read_channels()
        for action, value in (("volume", 16), ("squelch", 10), ("channel_a", 9), ("region", 2), ("transmit", 1)):
            with self.assertRaises(ValueError, msg=action):
                link.control(action, value)

    def test_changing_region_reads_that_region_s_channels(self):
        radio = FakeRadio()
        link, events = link_to(radio)
        link.read_channels()
        with mock.patch.object(bluez, "time", wraps=time) as t:
            t.sleep = lambda _s: None
            info = link.control("region", 1)
        self.assertEqual(info["region"], 1)
        self.assertEqual([c["name"] for c in info["channels"]], ["Boston FD", "Mass SP"])
        self.assertEqual(events[-1]["event"], "channels")
        self.assertEqual(events[-1]["region"], 1)


class PollTests(unittest.TestCase):
    def test_a_region_switched_on_the_radio_re_reads_the_names(self):
        # The bug: the table was read once at connect, so after the radio was
        # moved to another region, transmissions were filed under the old names
        radio = FakeRadio()
        link, events = link_to(radio)
        link.read_channels()
        with mock.patch.object(bluez, "STATUS_PERIOD", 0.02), mock.patch.object(bluez, "POSITION_EVERY", 0):
            t = threading.Thread(target=link._poll_status, daemon=True)
            t.start()
            time.sleep(0.1)
            radio.region = 1   # switched on the radio itself
            deadline = time.time() + 3
            while time.time() < deadline and not any(e.get("region") == 1 and e["event"] == "channels" for e in events):
                time.sleep(0.02)
            link.stop.set()
            t.join(2)
        loaded = [e for e in events if e["event"] == "channels"]
        self.assertEqual([c["name"] for c in loaded[-1]["channels"]], ["Boston FD", "Mass SP"])
        statuses = [e for e in events if e["event"] == "radio-status"]
        self.assertEqual(statuses[-1]["region"], 1)
        positions = [e for e in events if e["event"] == "radio-position"]
        self.assertEqual(len(positions), 1, "the GPS fix, reported once while it doesn't change")
        self.assertAlmostEqual(positions[0]["lat"], 42.3601, places=3)


if __name__ == "__main__":
    unittest.main()
