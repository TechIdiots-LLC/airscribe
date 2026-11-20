"""An SDS150 over Bluetooth LE through the bumble backend, against a fake scanner on Bumble's virtual controller.

The fake scanner offers what the real one does (sds.py): one characteristic that notifies and takes writes
without response, in a vendor service, alongside a standard one that could be mistaken for it. It records the
polls it's sent, and sends a transmission as the real one does: its A0, Opus audio, then its A2. The UUIDs are
made up. Skipped where Bumble isn't installed.
"""
import asyncio
import time
import unittest

import sds
from test_sds import TONE, WATERFALL, pieces, scanner_frame

try:
    from bumble import core, pairing
    from bumble.controller import Controller
    from bumble.device import Connection, Device
    from bumble.gatt import Characteristic, CharacteristicValue, Service
    from bumble.host import Host
    from bumble.keys import MemoryKeyStore
    from bumble.link import LocalLink
    from bumble.transport.common import AsyncPipeSink
    import bumble_link
except ImportError:
    bumble_link = None

SCANNER = "DE:B8:5F:00:00:01"     # static random, as an SDS150's is
VENDOR_SERVICE = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0"
VENDOR_CHAR = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F1"
DONGLE = "00:1A:7D:00:00:01"


class PublicLink(LocalLink if bumble_link else object):
    """Bumble's virtual link, but LE data comes from the address a link was made from: as is, it's always the
    sender's random one, and a link AirScribe makes from its public address carried nothing."""

    def send_acl_data(self, sender, destination, transport, data):
        if transport != core.PhysicalTransport.LE:
            return super().send_acl_data(sender, destination, transport, data)
        receiver = self.find_le_controller(destination)
        source = next((c.self_address for c in sender.le_connections.values() if c.peer_address == destination),
                      sender.random_address)
        if receiver is not None:
            asyncio.get_running_loop().call_soon(lambda: receiver.on_link_acl_data(source, transport, data))


class Accept(pairing.PairingDelegate if bumble_link else object):
    def __init__(self):
        if bumble_link:
            super().__init__(io_capability=pairing.PairingDelegate.NO_OUTPUT_NO_INPUT)

    async def confirm(self, auto=False):
        return True


class FakeScanner:
    def __init__(self, device):
        self.device = device
        self.writes = []
        both = Characteristic.Properties.NOTIFY | Characteristic.Properties.WRITE_WITHOUT_RESPONSE
        self.char = Characteristic(VENDOR_CHAR, both, Characteristic.Permissions.WRITEABLE,
                                   CharacteristicValue(write=lambda _c, v: self.writes.append(bytes(v))))
        # A standard service with a characteristic of the same kind: not the one
        decoy = Characteristic("2A3D", both, Characteristic.Permissions.WRITEABLE,
                               CharacteristicValue(write=lambda _c, v: None))
        device.add_service(Service("180F", [decoy]))
        device.add_service(Service(VENDOR_SERVICE, [self.char]))

    async def send(self, frames):
        for f in frames:
            await self.device.notify_subscribers(self.char, f)
            await asyncio.sleep(0.02)


@unittest.skipUnless(bumble_link, "needs bumble (pip install bumble)")
class ScannerOverBumbleTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        holder = {}
        for name, seconds in (("LE_PAIR_SECONDS", 5), ("ENCRYPT_SECONDS", 2), ("CONNECT_SECONDS", 5)):
            self.addCleanup(setattr, bumble_link, name, getattr(bumble_link, name))
            setattr(bumble_link, name, seconds)

        async def open_device():
            link = PublicLink()
            # A dongle's public address, unlike the random one AirScribe connects from
            c_us = Controller("us", link=link, public_address=DONGLE)
            c_sc = Controller("scanner", link=link, public_address="00:00:00:00:00:00")
            scanner = Device(address=SCANNER, host=Host(c_sc, AsyncPipeSink(c_sc)))
            scanner.keystore = MemoryKeyStore()
            scanner.pairing_config_factory = lambda _c: pairing.PairingConfig(
                sc=True, mitm=False, bonding=True, delegate=Accept())
            holder["scanner"] = FakeScanner(scanner)
            await scanner.power_on()
            await scanner.start_advertising(auto_restart=True)
            us = Device(address="F0:F1:F2:F3:F4:F5", host=Host(c_us, AsyncPipeSink(c_us)))
            return us, None

        self.stack = bumble_link.BumbleStack(open_device)
        self.scanner = holder["scanner"]
        self.backend = bumble_link.BumbleBackend(self.events.append, stack=self.stack)
        self.addCleanup(self.backend.shutdown)

    def wait_for(self, pred, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if pred():
                return True
            time.sleep(0.05)
        return False

    def of(self, kind, **match):
        return [e for e in self.events if e.get("event") == kind
                and all(e.get(k) == v for k, v in match.items())]

    def test_connects_and_polls_as_the_app_does(self):
        self.backend.connect(SCANNER, "sds-ble")
        self.assertEqual(len(self.of("status", state="connected")), 1, self.events)
        self.assertTrue(self.wait_for(lambda: len(self.scanner.writes) >= 3), "it polls")
        self.assertEqual(sds.gst(0), self.scanner.writes[0], "on the vendor characteristic, not the decoy")
        self.assertEqual(self.scanner.writes[1], sds.gst(1), "numbered in turn")
        # A real SDS150 goes quiet for over 720 ms (Bumble's default) as encryption starts
        params = self.stack.le_sessions[SCANNER].connection.parameters
        self.assertEqual(params.supervision_timeout, bumble_link.LE_SUPERVISION_MS, params)
        # And at the 15 ms the scanner asks for itself
        self.assertLessEqual(params.connection_interval, bumble_link.LE_INTERVAL_MS[1], params)

    def test_the_real_characteristic_is_known_by_its_uuid(self):
        both = Characteristic.Properties.NOTIFY | Characteristic.Properties.WRITE_WITHOUT_RESPONSE
        made_up = Characteristic(VENDOR_CHAR, both, Characteristic.Permissions.WRITEABLE)
        real = Characteristic(sds.CHARACTERISTIC, both | Characteristic.Properties.READ,
                              Characteristic.Permissions.WRITEABLE)
        services = [(bytes(16), [made_up]), (bytes(16), [real])]
        self.assertIs(bumble_link.pick_characteristic(services), real, "ahead of one that only looks like it")
        self.assertIs(bumble_link.pick_characteristic(services[:1]), made_up, "and failing it, what does the same")

    def test_a_newer_dongle_is_asked_for_long_packets_and_2m(self):
        from bumble import hci

        class Dongle:
            def __init__(self, features):
                self.features = features

            def supports_le_features(self, feature):
                return bool(self.features & feature)

        class Link:
            def __init__(self, refuse=()):
                self.asked, self.refuse = [], refuse

            async def set_data_length(self, octets, time_us):
                self.asked.append(("length", octets, time_us))
                if "length" in self.refuse:
                    raise hci.HCI_Error(0x01)

            async def set_phy(self, tx_phys, rx_phys):
                self.asked.append(("phy", tx_phys, rx_phys))

        both = hci.LeFeatureMask.LE_DATA_PACKET_LENGTH_EXTENSION | hci.LeFeatureMask.LE_2M_PHY
        five, four, refusing = Link(), Link(), Link(refuse=("length",))
        asyncio.run(bumble_link.ask_for_a_faster_link(Dongle(both), five, SCANNER))
        self.assertEqual(five.asked, [("length", 251, 2120), ("phy", [hci.Phy.LE_2M], [hci.Phy.LE_2M])])
        asyncio.run(bumble_link.ask_for_a_faster_link(Dongle(0), four, SCANNER))
        self.assertEqual(four.asked, [], "a Bluetooth 4.0 dongle isn't asked what it can't do")
        asyncio.run(bumble_link.ask_for_a_faster_link(Dongle(both), refusing, SCANNER))
        self.assertEqual(refusing.asked[-1][0], "phy", "a refusal doesn't stop the rest, nor the connection")

    def test_the_screen_is_polled_during_audio_as_the_link_allows(self):
        class Link:
            def __init__(self, octets):
                self.data_length = Connection.LeDataLength(27, 328, octets, octets * 8 + 112)

        self.assertEqual(bumble_link.audio_screen_seconds(Link(27)), sds.AUDIO_SCREEN_SECONDS, "a 4.0 dongle's")
        self.assertEqual(bumble_link.audio_screen_seconds(Link(251)), sds.POLL_SECONDS, "a 5.0 one's")
        # Bumble's virtual controller keeps 27-byte packets
        self.backend.connect(SCANNER, "sds-ble")
        self.assertEqual(self.backend.scanners[SCANNER].audio_screen_seconds, sds.AUDIO_SCREEN_SECONDS)

    def test_it_pairs_with_the_address_we_connect_from(self):
        self.backend.connect(SCANNER, "sds-ble")
        theirs = next(iter(self.scanner.device.connections.values()))
        bonded = [name for name, _keys in self.stack.run(self.scanner.device.keystore.get_all(), 10)]
        self.assertEqual(bonded, [str(theirs.peer_address)], "the identity it keeps is the address it sees")
        self.assertEqual(bonded, [f"{DONGLE}/P"], "the dongle's public one")
        ours = [k for _n, k in self.stack.run(self.stack.device.keystore.get_all(), 10)]
        noted = self.stack.le_sessions[SCANNER].connection.airscribe_noted_ltk
        self.assertEqual([k.ltk.value for k in ours], [noted], "the key noted as encryption started is the one kept")

    def test_a_link_lost_as_pairing_finishes_keeps_the_key_the_scanner_kept(self):
        # As a real SDS150 sometimes does: it has the key, keeps it, and goes silent until the link times out
        device, kept = self.scanner.device, {}

        async def silent(handle, rand, ediv):
            kept["ltk"] = device.smp_manager.sessions[handle].ltk
            await device.connections[handle].disconnect(0x08)     # no answer: the link ends first

        async def has_it(handle, rand, ediv):
            return kept["ltk"]

        device.host.long_term_key_provider = silent
        with self.assertRaisesRegex(RuntimeError, "dropped as pairing finished.*kept its own"):
            self.backend.connect(SCANNER, "sds-ble")
        ours = [k for _n, k in self.stack.run(self.stack.device.keystore.get_all(), 10)]
        self.assertEqual([k.ltk.value for k in ours], [kept["ltk"]], "the scanner's key, kept")

        device.host.long_term_key_provider = has_it
        self.backend.connect(SCANNER, "sds-ble")
        self.assertEqual(len(self.of("status", state="connected")), 1, self.events)
        conn = self.stack.le_sessions[SCANNER].connection
        self.assertFalse(hasattr(conn, "airscribe_noted_ltk"), "encrypted with it, not paired again")

    def test_its_parameter_update_keeps_our_interval_and_timeout(self):
        self.backend.connect(SCANNER, "sds-ble")
        conn = self.stack.le_sessions[SCANNER].connection
        updated = []
        conn.on("connection_parameters_update", lambda: updated.append(conn.parameters))
        theirs = next(iter(self.scanner.device.connections.values()))
        # What a real SDS150 asks for a few seconds in: 420 ms lost every link within 1.5 s, and 50 ms a third
        # of its audio
        self.stack.run(theirs.update_parameters(30, 50, 0, 420, use_l2cap=True), 10)
        self.assertTrue(self.wait_for(lambda: updated), "the update was made")
        self.assertEqual(updated[-1].connection_interval, bumble_link.LE_INTERVAL_MS[1], "not its interval")
        self.assertEqual(updated[-1].supervision_timeout, bumble_link.LE_SUPERVISION_MS, "nor its timeout")

    def test_a_transmission_comes_through_labelled(self):
        self.backend.connect(SCANNER, "sds-ble")
        frames = [scanner_frame(1, 0xA1, b"\x00" + TONE[0]), scanner_frame(2, 0xA0, b"Springfield,Fire Dispatch")]
        frames += [scanner_frame(3 + i, 0xA1, bytes([i + 1]) + p) for i, p in enumerate(TONE[1:])]
        frames.append(scanner_frame(40, 0xA2, b"Springfield,Town of Springfield,Fire Dispatch, 154.250000MHz,,3\r"))
        self.stack.run(self.scanner.send(frames), 30)
        self.assertTrue(self.wait_for(lambda: self.of("audio-end")), self.events)
        self.assertEqual(len(self.of("audio-start")), 1)
        label = self.of("scanner-channel")[-1]
        self.assertEqual((label["channel"], label["frequency"]), ("Fire Dispatch", "154.250000MHz"))
        if sds.find_decoder():
            self.assertEqual(self.of("run-stats")[0]["frames"], len(TONE), "every packet arrived")
            self.assertGreater(len(self.of("audio")), 0, "and was decoded")

    def test_keys_and_the_waterfall_reach_it(self):
        self.backend.connect(SCANNER, "sds-ble")
        self.stack.run(self.scanner.send([pieces(1, WATERFALL)]), 10)    # in its waterfall mode
        self.backend.scanner_key(SCANNER, "M", 50)
        self.backend.scanner_waterfall(SCANNER, 5)
        sent = lambda: b"".join(self.scanner.writes)  # noqa: E731
        self.assertTrue(self.wait_for(lambda: b"KEY,M,R" in sent() and b"GW2,1,ON" in sent()), sent()[-200:])
        self.assertLess(sent().index(b"KEY,M,H"), sent().index(b"KEY,M,R"))
        with self.assertRaisesRegex(RuntimeError, "isn't connected"):
            self.backend.scanner_key("DE:B8:5F:00:00:09", "M")

    def test_a_scanner_that_drops_is_reported_and_can_be_reconnected(self):
        self.backend.connect(SCANNER, "sds-ble")
        conn = next(iter(self.scanner.device.connections.values()))
        self.stack.run(conn.disconnect(), 10)
        self.assertTrue(self.wait_for(lambda: self.of("status", state="disconnected")), self.events)
        self.backend.connect(SCANNER, "sds-ble")   # what the server's retry does
        self.assertEqual(len(self.of("status", state="connected")), 2, self.events)

    def test_disconnect_releases_it(self):
        self.backend.connect(SCANNER, "sds-ble")
        self.backend.disconnect(SCANNER)
        self.assertEqual(len(self.of("status", state="disconnected")), 1)
        self.assertTrue(self.wait_for(lambda: not self.scanner.device.connections), "the link is down")
        writes = len(self.scanner.writes)
        time.sleep(0.5)
        self.assertEqual(len(self.scanner.writes), writes, "and the polling stopped")


if __name__ == "__main__":
    unittest.main()
