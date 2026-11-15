#!/usr/bin/env python3
"""Reach a radio through Bumble, a Bluetooth stack that runs in Python.

The point is to find out whether the radio link works without the operating
system's Bluetooth at all. Bumble drives a USB dongle directly, so the same
code can run on Windows and inside an unprivileged LXC container, where the
kernel refuses Bluetooth sockets (see docs/bluetooth.md).

The dongle has to be handed to Bumble first, and that takes it away from the
OS's own Bluetooth:

  Windows  Zadig: Options > List All Devices, pick the dongle, WinUSB,
           Replace Driver. Windows uses one Bluetooth adapter at a time, so a
           second dongle that shows error 31 costs nothing.
  Linux    The host's btusb must not hold it (see docs/bluetooth.md).

  pip install "bumble>=0.0.236"      # needs Python 3.11 or newer

    python tools/probe-bumble.py --info                        # the dongle itself
    python tools/probe-bumble.py --scan                        # radios in range
    python tools/probe-bumble.py <MAC> --discover              # find the channels
    python tools/probe-bumble.py <MAC>                         # find them and capture
    python tools/probe-bumble.py <MAC> --control 4 --audio 2   # skip probing (a fresh radio only)

Same rules as tools/probe-aoc.py: read-only, it sends GET_HT_STATUS and
nothing else and never keys the transmitter, and the channels it keeps are
held until the end because the radio will not reopen one it has just closed.
The first connection pairs, so put the radio into pairing mode for that one.
Bumble keeps its own pairing keys, in --keys; a bond made by Windows or BlueZ
does not carry over.
"""
import argparse
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
from bluez import GET_HT_STATUS, parse_ht_status  # noqa: E402
from bumble_link import dongle_hint  # noqa: E402
from htframe import FrameReader  # noqa: E402

SETTLE = 0.6  # the radio needs a moment to free a channel after a session ends
CMD_NAMES = {0x00: "audio", 0x01: "AUDIO END", 0x02: "ack",
             0x03: "audio", 0x09: "transmit audio"}


def bumble():
    """Import Bumble late, so --help works without it and a missing one says so."""
    try:
        import bumble.core  # noqa: F401
    except ImportError:
        raise SystemExit('Bumble is not installed: pip install "bumble>=0.0.236" '
                         "(Python 3.11 or newer)")
    from bumble import core, device, hci, keys, pairing, rfcomm, transport
    return core, device, hci, keys, pairing, rfcomm, transport


class Channel:
    """One RFCOMM channel, read the way probe-aoc.py reads a socket."""

    def __init__(self, dlc):
        self.dlc = dlc
        self.buf = bytearray()
        self.arrived = asyncio.Event()
        self.on_data = None
        dlc.sink = self._sink

    def _sink(self, data):
        if self.on_data:
            self.on_data(data)
        else:
            self.buf += data
            self.arrived.set()

    async def read_at_least(self, n, timeout):
        end = time.monotonic() + timeout
        while len(self.buf) < n:
            left = end - time.monotonic()
            if left <= 0:
                break
            self.arrived.clear()
            try:
                await asyncio.wait_for(self.arrived.wait(), left)
            except TimeoutError:
                break
        out, self.buf = bytes(self.buf), bytearray()
        return out

    async def release(self):
        """Hand the channel back, and give the radio a moment to free it."""
        try:
            await self.dlc.disconnect()
        except Exception as e:  # already gone is fine
            print(f"  (releasing channel: {e})")
        await asyncio.sleep(SETTLE)


async def ht_status(ctrl):
    """The radio's parsed HT status, or None if it did not answer."""
    ctrl.buf.clear()
    ctrl.dlc.write(GET_HT_STATUS)
    return parse_ht_status(await ctrl.read_at_least(13, 3))


async def open_channel(mux, ch, timeout=6):
    return Channel(await asyncio.wait_for(mux.open_dlc(ch), timeout))


async def open_known(mux, ch, what):
    """A channel named on the command line: a refusal is the radio, not a bug."""
    try:
        return await open_channel(mux, ch)
    except Exception as e:
        raise SystemExit(
            f"\nThe radio refused {what} channel {ch} ({type(e).__name__} {e}).\n"
            "It won't reopen a channel that was closed until its Bluetooth restarts,\n"
            "and the control channel's number can change after one. Power-cycle the\n"
            "radio and run without --control/--audio, which finds both and holds them."
        )


async def find_control(mux, last):
    print("looking for the control channel ...")
    for ch in range(1, last + 1):
        try:
            c = await open_channel(mux, ch, timeout=4)
        except Exception as e:
            print(f"  channel {ch:2d}: {type(e).__name__} {e}")
            continue
        if await ht_status(c):
            print(f"  channel {ch:2d}: answered GAIA  <== CONTROL (held open)")
            return ch, c
        print(f"  channel {ch:2d}: open, but silent")
        await c.release()
    raise SystemExit(
        "\nNo channel answered a GAIA query. If channels opened but none\n"
        "answered, power-cycle the radio's Bluetooth, and check no other host\n"
        "is connected to it."
    )


async def find_audio(mux, ctrl, control_ch, last):
    print("\nlooking for the audio channel (watching is_aoc_connected) ...")
    for ch in range(1, last + 1):
        if ch == control_ch:
            continue
        try:
            cand = await open_channel(mux, ch, timeout=4)
        except Exception as e:
            print(f"  channel {ch:2d}: {type(e).__name__} {e}")
            continue
        await asyncio.sleep(1.0)
        st = await ht_status(ctrl)
        if st and st["aoc_connected"]:
            print(f"  channel {ch:2d}: is_aoc_connected=True  <== BS AOC AUDIO (held open)")
            return ch, cand
        print(f"  channel {ch:2d}: is_aoc_connected={st['aoc_connected'] if st else '?'}")
        await cand.release()
    return None, None


async def capture(ctrl, audio, seconds, out):
    """Count the radio's audio frames through the project's own codec."""
    reader, raw, sbc, counts, polls = FrameReader(), bytearray(), bytearray(), {}, []

    def on_data(data):
        raw.extend(data)
        for cmd, payload in reader.feed(data):
            counts[cmd] = counts.get(cmd, 0) + 1
            if cmd in (0x00, 0x03):
                sbc.extend(payload)

    audio.on_data = on_data
    print(f"\ncapturing {seconds:g}s - key up another radio on this channel ...")
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        st = await ht_status(ctrl)
        if st:
            polls.append((st["in_rx"], st["squelch"], st["rssi"]))
        await asyncio.sleep(2.0)
    with open(out, "wb") as fh:
        fh.write(raw)
    print(f"\n{len(raw)} bytes -> {out}")
    if sbc:
        # The audio frames' payload alone, which ffmpeg reads as raw SBC
        sbc_out = os.path.splitext(out)[0] + ".sbc"
        with open(sbc_out, "wb") as fh:
            fh.write(sbc)
        print(f"{len(sbc)} bytes of SBC -> {sbc_out}; to listen: "
              f"ffmpeg -f sbc -i {sbc_out} {os.path.splitext(sbc_out)[0]}.wav")
    print("status polls (in_rx, squelch, rssi):", polls)
    if counts:
        print("frames decoded by sidecar/htframe.py:")
        for cmd in sorted(counts):
            print(f"  cmd 0x{cmd:02X} {CMD_NAMES.get(cmd, '?'):<15} x{counts[cmd]}")
    else:
        print("no frames - the radio produced no audio during the window")


def describe_controller(dev):
    from bumble.company_ids import COMPANY_IDENTIFIERS

    v = dev.host.local_version
    print(f"controller address : {dev.public_address}")
    if v is None:
        print("version            : not reported")
        return
    company = COMPANY_IDENTIFIERS.get(v.company_identifier, "unknown")
    print(f"manufacturer       : {company} (0x{v.company_identifier:04X})")
    print(f"HCI version / rev  : {v.hci_version} / 0x{v.hci_subversion:04X}")
    print(f"LMP version / sub  : {v.lmp_version} / 0x{v.lmp_subversion:04X}")


async def scan(dev, seconds):
    from bumble.core import AdvertisingData

    seen = {}

    def on_result(address, _cod, data, rssi):
        names = (data.get_all(AdvertisingData.COMPLETE_LOCAL_NAME)
                 or data.get_all(AdvertisingData.SHORTENED_LOCAL_NAME))
        key = str(address)
        if key not in seen or (names and not seen[key]):
            seen[key] = names[0] if names else ""
            print(f"  {key}  rssi {rssi:4d}  {seen[key]}")

    dev.on("inquiry_result", on_result)
    print(f"scanning {seconds:g}s ...")
    await dev.start_discovery()
    await asyncio.sleep(seconds)
    await dev.stop_discovery()
    if not seen:
        print("  nothing answered; is the radio's Bluetooth on and discoverable?")


def make_delegate(pin):
    _, _, _, _, pairing, _, _ = bumble()

    class Delegate(pairing.PairingDelegate):
        """Accepts whatever the radio proposes, as BlueZ's agent did."""

        def __init__(self):
            super().__init__(io_capability=pairing.PairingDelegate.DISPLAY_OUTPUT_AND_YES_NO_INPUT)

        async def confirm(self, auto=False):
            print("  pairing: accepting")
            return True

        async def compare_numbers(self, number, digits):
            print(f"  pairing: code {number:0{digits}d}, accepting - confirm it on the radio if asked")
            return True

        async def get_string(self, max_length):
            print(f"  pairing: the radio wants a PIN, sending {pin}")
            return pin

        async def display_number(self, number, digits):
            print(f"  pairing: enter {number:0{digits}d} on the radio")

    return Delegate()


async def probe(dev, args):
    """Everything after the controller is up. Separate so it can be tested."""
    core, _, _, _, pairing, rfcomm, _ = bumble()

    describe_controller(dev)
    if args.info:
        return
    if args.scan or not args.mac:
        await scan(dev, args.seconds)
        return

    print(f"\nconnecting to {args.mac} ...")
    connection = await dev.connect(args.mac, transport=core.PhysicalTransport.BR_EDR)
    print("  connected")
    ctrl = audio = mux = None
    try:
        if not args.no_auth:
            # Pairs on the first run, then reuses the key from --keys.
            await connection.authenticate()
            print("  authenticated")
            # Reported rather than fatal: whether the radio insists on an
            # encrypted link is one of the things this probe is finding out.
            try:
                await connection.encrypt()
                print("  encrypted")
            except Exception as e:
                print(f"  encryption failed ({type(e).__name__} {e}); carrying on without it")
        mux = await rfcomm.Client(connection).start()
        print("  RFCOMM up\n")

        if args.control:
            ctrl, control_ch = await open_known(mux, args.control, "control"), args.control
            st = await ht_status(ctrl)
            print(f"control channel {control_ch}: open (held), GAIA replied: {bool(st)}")
            if st:
                print(f"  {st}")
        else:
            control_ch, ctrl = await find_control(mux, args.last)
            print(f"  {await ht_status(ctrl)}")

        if args.audio:
            audio_ch, audio = args.audio, await open_known(mux, args.audio, "audio")
            st = await ht_status(ctrl)
            print(f"audio channel {audio_ch}: open (held), "
                  f"is_aoc_connected={st['aoc_connected'] if st else '?'}")
        else:
            audio_ch, audio = await find_audio(mux, ctrl, control_ch, args.last)

        print(f"\n  control channel : {control_ch}")
        print(f"  audio channel   : {audio_ch if audio_ch else 'not found'}")
        if audio and not args.discover:
            await capture(ctrl, audio, args.capture, args.out)
    finally:
        # Released only on the way out. Anything earlier and the channel will
        # not reopen.
        for c in (audio, ctrl):
            if c:
                await c.release()
        for step in (mux.disconnect if mux else None, connection.disconnect):
            if step:
                try:
                    await step()
                except Exception:
                    pass


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("mac", nargs="?", help="radio address, e.g. 38:D2:00:01:56:51")
    ap.add_argument("--transport", default="usb:0",
                    help="Bumble transport: usb:0 for the first dongle, or "
                         "usb:0A12:0001 to name one by its USB id")
    ap.add_argument("--keys", default="bumble-keys.json",
                    help="where Bumble keeps the pairing keys")
    ap.add_argument("--info", action="store_true", help="describe the dongle and stop")
    ap.add_argument("--scan", action="store_true", help="list devices in range")
    ap.add_argument("--seconds", type=float, default=12.0, help="how long to scan")
    ap.add_argument("--discover", action="store_true",
                    help="find the channels and stop, instead of capturing")
    ap.add_argument("--last", type=int, default=10, help="highest channel to probe")
    ap.add_argument("--control", type=int, help="known control channel; skips probing")
    ap.add_argument("--audio", type=int, help="known audio channel; skips probing")
    ap.add_argument("--capture", type=float, default=45.0, help="capture seconds")
    ap.add_argument("--out", default="aoc_capture.bin")
    ap.add_argument("--pin", default="0000", help="for a radio that asks for a legacy PIN")
    ap.add_argument("--no-auth", action="store_true",
                    help="skip pairing and encryption, to see if the radio insists")
    ap.add_argument("--debug", action="store_true", help="log Bumble's HCI traffic")
    args = ap.parse_args()

    _, device, hci, keys, pairing, _, transport = bumble()
    if args.debug:
        import logging
        logging.basicConfig(level=logging.DEBUG)

    print(f"opening {args.transport} ...")
    try:
        t = await transport.open_transport(args.transport)
    except Exception as e:
        raise SystemExit(f"\ncould not open {args.transport}: {type(e).__name__} {e}\n{dongle_hint(e)}")
    async with t:
        dev = device.Device.with_hci("AirScribe", hci.Address("F0:F1:F2:F3:F4:F5"),
                                     t.source, t.sink)
        dev.classic_enabled = True
        dev.keystore = keys.JsonKeyStore(None, args.keys)
        delegate = make_delegate(args.pin)
        dev.pairing_config_factory = lambda _c: pairing.PairingConfig(
            sc=True, mitm=True, bonding=True, delegate=delegate)
        await dev.power_on()
        await probe(dev, args)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
