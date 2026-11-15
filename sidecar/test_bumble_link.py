"""The bumble backend against a fake radio, both on Bumble's virtual controller.

No dongle and no radio: two Bumble devices share an in-process link. The fake
radio behaves as the UV-Pro did through Bumble on pve1 (docs/bluetooth.md):
one channel stays silent, one answers GAIA status queries, and one carries
audio and flips is_aoc_connected while it is open. Skipped where Bumble
isn't installed.
"""
import asyncio
import shutil
import subprocess
import time
import unittest

from htframe import escape

try:
    from bumble import pairing, rfcomm
    from bumble.controller import Controller
    from bumble.device import Device
    from bumble.host import Host
    from bumble.link import LocalLink
    from bumble.transport.common import AsyncPipeSink
    import bumble_link
except ImportError:
    bumble_link = None

RADIO = "38:D2:00:01:56:51"
# A real UV-Pro's idle status reply (test_bluez.py); byte 10 carries is_aoc_connected
IDLE = bytes.fromhex("FF010005000280140082010080")


def sbc_audio(seconds=0.5):
    """Real SBC from ffmpeg when it can encode, else bytes that only frame."""
    exe = shutil.which("ffmpeg")
    if exe:
        p = subprocess.run(
            [exe, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", f"sine=frequency=600:duration={seconds}:sample_rate=32000",
             "-ac", "1", "-c:a", "sbc", "-f", "sbc", "pipe:1"],
            capture_output=True)
        if p.returncode != 0 or not p.stdout.startswith(b"\x9c"):
            raise RuntimeError(f"ffmpeg couldn't encode SBC: {p.stderr[-300:]!r}")
        return p.stdout
    return b"\x9c" + b"\x11" * 43


class Accept(pairing.PairingDelegate if bumble_link else object):
    async def confirm(self, auto=False):
        return True

    async def compare_numbers(self, number, digits):
        return True


def closes_on_disc(dlc):
    """Make a channel really close when the far end closes it.

    Bumble 0.0.236 only answers the DISC (see DlcSocket), so without this the
    fake radio would think a released channel was still open, and refuse to
    open it again, which a real radio doesn't do.
    """
    answer = dlc.on_disc_frame

    def on_disc_frame(frame):
        answer(frame)
        dlc.change_state(rfcomm.DLC.State.DISCONNECTED)
        dlc.multiplexer.on_dlc_disconnection(dlc)
        dlc.emit(dlc.EVENT_CLOSE)

    dlc.on_disc_frame = on_disc_frame


class FakeRadio:
    """Channel 1 silent, 2 audio, 3 control."""

    def __init__(self, device):
        self.device = device
        self.audio = None
        self.control_opens = 0
        server = rfcomm.Server(device)
        server.listen(closes_on_disc, channel=1)
        server.listen(self.on_audio, channel=2)
        server.listen(self.on_control, channel=3)

    def on_audio(self, dlc):
        closes_on_disc(dlc)
        self.audio = dlc

        def closed():
            if self.audio is dlc:
                self.audio = None

        dlc.on("close", closed)

    def on_control(self, dlc):
        closes_on_disc(dlc)
        self.control_opens += 1

        def reply(data):
            # Answered by command, as a radio does: RadioLink matches each
            # reply to its request, so a status reply to anything else is no
            # answer at all
            cmd = ((data[6] << 8) | data[7]) if len(data) >= 8 else 0x14
            if cmd != 0x14:
                dlc.write(bytes([0xFF, 0x01, 0x00, 0x01, 0x00, 0x02, 0x80 | (cmd >> 8), cmd & 0xFF, 0x01]))
                return
            st = bytearray(IDLE)
            if self.audio is not None:
                st[10] |= 0x02
            dlc.write(bytes(st))

        dlc.sink = reply


@unittest.skipUnless(bumble_link, "needs bumble (pip install bumble)")
class BumbleBackendTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.radio = None
        holder = {}
        # The virtual controller can't encrypt; don't wait the full timeout
        # for it to say so on every test
        encrypt = bumble_link.ENCRYPT_SECONDS
        bumble_link.ENCRYPT_SECONDS = 0.5
        self.addCleanup(setattr, bumble_link, "ENCRYPT_SECONDS", encrypt)

        async def open_device():
            link = LocalLink()
            c_us = Controller("us", link=link, public_address="F0:F1:F2:F3:F4:F5")
            c_radio = Controller("radio", link=link, public_address=RADIO)
            radio = Device(address=RADIO, host=Host(c_radio, AsyncPipeSink(c_radio)))
            radio.classic_enabled = True
            radio.pairing_config_factory = lambda _c: pairing.PairingConfig(
                sc=True, mitm=True, bonding=True, delegate=Accept())
            await radio.power_on()
            await radio.set_connectable(True)
            holder["radio"] = FakeRadio(radio)
            us = Device(address="F0:F1:F2:F3:F4:F5", host=Host(c_us, AsyncPipeSink(c_us)))
            return us, None

        stack = bumble_link.BumbleStack(open_device)
        self.radio = holder["radio"]
        self.stack = stack
        self.backend = bumble_link.BumbleBackend(self.events.append, stack=stack)
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

    def test_connects_finds_both_channels_and_reports_status(self):
        self.backend.connect(RADIO)
        st = self.of("status", state="connected")
        self.assertEqual(len(st), 1, self.events)
        self.assertEqual(st[0]["detail"], "control ch3, audio ch2",
                         "the silent channel 1 is passed over for both")
        self.assertEqual(self.radio.control_opens, 1, "control is opened once and held")
        self.assertTrue(self.wait_for(lambda: self.of("radio-status")), self.events)
        self.assertTrue(self.of("radio-status")[-1]["aoc_connected"])
        self.assertTrue(any("isn't encrypted" in e["error"] for e in self.of("sidecar-error")),
                        "a link that couldn't be encrypted is used, and said so")

    def test_a_channel_the_radio_closes_reads_as_closed(self):
        self.backend.connect(RADIO)
        sock = self.stack.sessions[RADIO].sockets[-1]   # the audio channel
        self.stack.run(self.radio.audio.disconnect(), 5)
        self.assertTrue(self.wait_for(lambda: sock.closed), "not left waiting on a dead channel")
        self.assertEqual(sock.recv(10), b"")

    def test_a_transmission_comes_through_as_one_run(self):
        self.backend.connect(RADIO)
        audio = sbc_audio()
        frames = b"".join(escape(0x00, audio[i:i + 44]) for i in range(0, len(audio), 44))
        self.stack.call(self.radio.audio.write, frames + escape(0x01, b"\x00" * 8))
        self.assertTrue(self.wait_for(lambda: self.of("audio-end")), self.events)
        self.assertEqual(len(self.of("audio-start", transmit=False)), 1)
        if self.backend.decoder:
            stats = self.of("run-stats")
            self.assertEqual(stats[0]["sbc_bytes"], len(audio), "every byte of SBC arrived")
            self.assertGreater(len(self.of("audio")), 0, "and was decoded to PCM")
            self.assertAlmostEqual(stats[0]["seconds"], 0.5, delta=0.1, msg=stats)

    def test_a_radio_that_drops_is_reported_and_can_be_reconnected(self):
        self.backend.connect(RADIO)
        conn = next(iter(self.radio.device.connections.values()))
        self.stack.run(conn.disconnect(), 10)
        self.assertTrue(self.wait_for(lambda: self.of("status", state="disconnected")),
                        self.events)
        # What the server's retry does
        self.backend.connect(RADIO)
        self.assertEqual(len(self.of("status", state="connected")), 2, self.events)
        self.assertEqual(self.radio.control_opens, 2)

    def test_shutting_down_twice_is_harmless(self):
        # Signals and end of input can each ask; only the first does anything
        self.backend.connect(RADIO)
        self.backend.shutdown()
        self.assertEqual((self.backend.links, self.stack.sessions), ({}, {}), "the radio was released")
        self.assertTrue(self.stack.closed)
        self.backend.shutdown()
        self.assertEqual(len(self.of("status", state="disconnected")), 1, "and only once")

    def test_disconnect_releases_the_radio(self):
        self.backend.connect(RADIO)
        self.backend.disconnect(RADIO)
        self.assertEqual(len(self.of("status", state="disconnected")), 1)
        self.assertTrue(self.wait_for(lambda: not self.radio.device.connections), "the link is down")
        self.assertIsNone(self.radio.audio, "the audio channel was handed back")


class DongleHintTests(unittest.TestCase):
    """Needs no Bumble: the advice for each way a dongle fails to open."""

    def test_each_libusb_failure_gets_its_own_advice(self):
        from bumble_link import dongle_hint
        # What 113 gave the service's user before its device entry had the group
        self.assertIn("GID in CT", dongle_hint("LIBUSB_ERROR_ACCESS [-3]"))
        self.assertIn("btusb driver", dongle_hint("LIBUSB_ERROR_BUSY [-6]"))
        # No dongle at all, as in a container that wasn't given one
        self.assertIn("passed in", dongle_hint("LIBUSB_ERROR_OTHER [-99]"))


class UnavailableTests(unittest.TestCase):
    def test_a_backend_that_could_not_start_says_why_for_every_command(self):
        import airscribe_sidecar as sidecar
        u = sidecar.Unavailable("could not open the Bluetooth dongle usb:0")
        for call in (u.scan, lambda: u.connect(RADIO), lambda: u.disconnect(RADIO)):
            with self.assertRaisesRegex(RuntimeError, "could not open the Bluetooth dongle"):
                call()


if __name__ == "__main__":
    unittest.main()
