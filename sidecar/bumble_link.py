"""The radio link over Bumble, for hosts whose own Bluetooth can't be used.

The kernel refuses Bluetooth sockets outside the host's network namespace, so
BlueZ can't work in an LXC container. Bumble is a Bluetooth stack in Python
that drives a USB dongle itself, through libusb, so it can: tools/probe-bumble.py
paired with a UV-Pro, found its channels and captured its audio from inside an
unprivileged container (docs/bluetooth.md). The same goes for Windows, with
the dongle on WinUSB.

Everything above the Bluetooth layer is bluez.RadioLink, unchanged: the
channel probing, the held channels, the status polls and the per-transmission
SBC decoding. RadioLink works on sockets from threads; Bumble is asyncio. So
Bumble runs on its own event loop in one thread, and each RFCOMM channel is
handed to RadioLink as a DlcSocket, which has the few socket methods it uses.

  pip install "bumble>=0.0.236"     # Python 3.11 or newer; Linux also needs libatomic1
"""

import asyncio
import socket
import threading

import sbc
from bluez import RadioLink

CONNECT_SECONDS = 20
PAIR_SECONDS = 60       # the first connection pairs, which can wait on the radio
ENCRYPT_SECONDS = 10    # the UV-Pro took well under one
SCAN_SECONDS = 8
# The radios' advertised names, so a scan lists them first. Which model a name
# is stays src/models.js's job; these only sort.
RADIO_NAMES = ("UV-PRO", "UV-50PRO", "GA-5WB", "DB50-B", "RT-660", "VR-N7")


def _mac(address):
    """A Bumble address as AA:BB:CC:DD:EE:FF, without its /P type suffix."""
    return str(address).split("/")[0].upper()


class DlcSocket:
    """One RFCOMM channel, as the socket RadioLink expects.

    Bumble delivers data on its loop thread; RadioLink reads on its own
    threads. A condition variable joins the two. recv() returns b"" once the
    channel or the whole link has closed, as a socket does.
    """

    def __init__(self, stack, dlc, timeout=None):
        self.stack = stack
        self.dlc = dlc
        self.timeout = timeout
        self.buf = bytearray()
        self.cond = threading.Condition()
        self.closed = False
        dlc.sink = self._on_data
        dlc.on("close", self.mark_closed)
        # Bumble (0.0.236) answers the radio closing a channel but neither
        # changes the channel's state nor says so ("TODO: handle all states"),
        # which would leave a reader waiting on a dead channel. Hear it here.
        answer = dlc.on_disc_frame

        def on_disc_frame(frame):
            answer(frame)
            self.mark_closed()

        dlc.on_disc_frame = on_disc_frame

    def _on_data(self, data):
        with self.cond:
            self.buf.extend(data)
            self.cond.notify_all()

    def mark_closed(self):
        """The radio closed it, or the link went: wake any reader. Loop-thread safe."""
        with self.cond:
            self.closed = True
            self.cond.notify_all()

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        if self.closed:
            raise OSError("the radio's channel is closed")
        self.stack.call(self.dlc.write, bytes(data))

    def recv(self, n):
        with self.cond:
            if not self.cond.wait_for(lambda: self.buf or self.closed, self.timeout):
                raise socket.timeout("timed out")
            if not self.buf:
                return b""
            out = bytes(self.buf[:n])
            del self.buf[:n]
            return out

    def shutdown(self, _how=None):
        pass

    def close(self):
        """Hand the channel back to the radio. A bare drop doesn't free it there."""
        if self.closed:
            return
        self.mark_closed()
        try:
            self.stack.run(self.dlc.disconnect(), 5)
        except Exception:
            pass   # already gone is fine


class Session:
    """One radio's ACL link and RFCOMM multiplexer, and the channels opened on it."""

    def __init__(self, connection, mux, warning=None):
        self.connection = connection
        self.mux = mux
        self.warning = warning
        self.sockets = []


def make_delegate(pin):
    from bumble import pairing

    class Delegate(pairing.PairingDelegate):
        """Accepts what the radio proposes, as BlueZ's agent did for these radios."""

        def __init__(self):
            super().__init__(io_capability=pairing.PairingDelegate.DISPLAY_OUTPUT_AND_YES_NO_INPUT)

        async def confirm(self, auto=False):
            return True

        async def compare_numbers(self, number, digits):
            return True

        async def get_string(self, max_length):
            return pin

    return Delegate()


def usb_device(spec):
    """Opens a dongle: an async callable giving (Device, transport to close)."""

    async def open_device():
        from bumble import hci, transport
        from bumble.device import Device

        t = await transport.open_transport(spec)
        dev = Device.with_hci("AirScribe", hci.Address("F0:F1:F2:F3:F4:F5"), t.source, t.sink)
        return dev, t

    return open_device


class BumbleStack:
    """Bumble's event loop, in its own thread, and the device on it.

    Every Bumble call goes through run() or call(), so Bumble is only ever
    touched from its own loop.
    """

    def __init__(self, open_device, keys=None, pin="0000"):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="bumble", daemon=True)
        self.thread.start()
        self.sessions = {}
        self.transport = None
        try:
            self.device = self.run(self._start(open_device, keys, pin), 60)
        except Exception:
            self.loop.call_soon_threadsafe(self.loop.stop)
            raise

    def run(self, coro, timeout=None):
        """Run a coroutine on Bumble's loop and wait for it, from any other thread."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def call(self, fn, *args):
        try:
            self.loop.call_soon_threadsafe(fn, *args)
        except RuntimeError as e:
            # The loop has stopped (shutting down): to RadioLink, a dead socket
            raise OSError(f"the Bluetooth stack has stopped ({e})") from e

    async def _start(self, open_device, keys, pin):
        from bumble import keys as bumble_keys, pairing

        dev, self.transport = await open_device()
        dev.classic_enabled = True
        # Nothing here listens, and a stranger's connection would only be
        # paired by the accept-everything delegate below. Radios are dialled.
        dev.classic_accept_any = False
        if keys:
            dev.keystore = bumble_keys.JsonKeyStore(None, keys)
        delegate = make_delegate(pin)
        dev.pairing_config_factory = lambda _c: pairing.PairingConfig(
            sc=True, mitm=True, bonding=True, delegate=delegate)
        await dev.power_on()
        return dev

    # -- scan ------------------------------------------------------------------

    def scan(self, seconds=SCAN_SECONDS):
        return self.run(self._scan(seconds), seconds + 15)

    async def _scan(self, seconds):
        from bumble.core import AdvertisingData

        seen = {}

        def on_result(address, _cod, data, _rssi):
            names = (data.get_all(AdvertisingData.COMPLETE_LOCAL_NAME)
                     or data.get_all(AdvertisingData.SHORTENED_LOCAL_NAME))
            name = names[0] if names else ""
            if isinstance(name, bytes):
                name = name.decode("utf-8", "replace")
            mac = _mac(address)
            if name or mac not in seen:
                seen[mac] = name

        self.device.on("inquiry_result", on_result)
        try:
            await self.device.start_discovery()
            await asyncio.sleep(seconds)
            await self.device.stop_discovery()
        finally:
            self.device.remove_listener("inquiry_result", on_result)
        found = [{"mac": mac, "name": name or mac,
                  "radio": any(r in name.upper() for r in RADIO_NAMES)}
                 for mac, name in seen.items()]
        return sorted(found, key=lambda d: not d["radio"])

    # -- connections -------------------------------------------------------------

    def connect(self, mac):
        """Link to a radio, pair or reuse the pairing, and start RFCOMM."""
        self.drop(mac)
        session = self.run(self._connect(mac), CONNECT_SECONDS + PAIR_SECONDS + 15)
        self.sessions[mac] = session
        return session

    async def _connect(self, mac):
        from bumble import core, rfcomm

        conn = await self.device.connect(mac, transport=core.PhysicalTransport.BR_EDR,
                                         timeout=CONNECT_SECONDS)
        try:
            await asyncio.wait_for(conn.authenticate(), PAIR_SECONDS)
            warning = None
            try:
                await asyncio.wait_for(conn.encrypt(), ENCRYPT_SECONDS)
            except Exception as e:
                # The UV-Pro accepted encryption through Bumble, but it isn't
                # known to need it, so carry on and say so rather than refuse.
                warning = f"the link to {mac} isn't encrypted ({type(e).__name__} {e})"
            mux = await rfcomm.Client(conn).start()
        except BaseException:
            try:
                await conn.disconnect()
            except Exception:
                pass
            raise
        session = Session(conn, mux, warning)
        conn.on("disconnection", lambda _reason: self._on_disconnection(mac, session))
        return session

    def _on_disconnection(self, mac, session):
        # On the loop thread. Readers wake to b"", and RadioLink's missed
        # polls report the radio gone, so the server retries.
        for s in session.sockets:
            s.mark_closed()
        if self.sessions.get(mac) is session:
            del self.sessions[mac]

    def open_channel(self, mac, channel, timeout):
        """RadioLink's opener: a held channel, or OSError when the radio refuses."""
        session = self.sessions.get(mac)
        if not session:
            raise OSError(f"no link to {mac}")

        async def open_it():
            dlc = await asyncio.wait_for(session.mux.open_dlc(channel), timeout)
            return DlcSocket(self, dlc, timeout)

        try:
            sock = self.run(open_it(), timeout + 5)
        except Exception as e:
            raise OSError(f"channel {channel}: {type(e).__name__} {e}") from e
        session.sockets.append(sock)
        return sock

    def drop(self, mac):
        """Close a radio's link, if there is one."""
        session = self.sessions.pop(mac, None)
        if not session:
            return
        for s in session.sockets:
            s.close()

        async def bye():
            for step in (session.mux.disconnect, session.connection.disconnect):
                try:
                    await asyncio.wait_for(step(), 5)
                except Exception:
                    pass

        try:
            self.run(bye(), 15)
        except Exception:
            pass

    def close(self):
        for mac in list(self.sessions):
            self.drop(mac)
        if self.transport is not None:
            try:
                self.run(self.transport.close(), 5)
            except Exception:
                pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        if not self.loop.is_running():
            self.loop.close()


def _release(sock):
    sock.shutdown()
    sock.close()


class BumbleBackend:
    """The sidecar's `bumble` backend: the same commands as BluezBackend."""

    def __init__(self, emit, transport="usb:0", keys=None, control_ch=None, audio_ch=None,
                 stack=None):
        self.emit = emit
        self.control_ch = control_ch
        self.audio_ch = audio_ch
        self.links = {}
        self.decoder = sbc.find_decoder()
        if not self.decoder:
            emit({"event": "sidecar-error",
                  "error": "no SBC-capable ffmpeg found; audio cannot be decoded"})
        if stack is None:
            try:
                stack = BumbleStack(usb_device(transport), keys)
            except ImportError as e:
                raise RuntimeError(
                    f"Bumble isn't installed for this Python ({e}); see docs/bluetooth.md") from e
            except Exception as e:
                raise RuntimeError(
                    f"could not open the Bluetooth dongle {transport}: {type(e).__name__} {e}. "
                    "Is it passed in, and has the host's btusb let go of it? "
                    "See docs/proxmox.md") from e
        self.stack = stack

    def scan(self):
        return self.stack.scan()

    def connect(self, mac):
        mac = mac.upper()
        link = self.links.get(mac)
        if link and not link.stop.is_set():
            return
        if link:
            # Gave up on a radio that stopped answering; this is the retry
            del self.links[mac]
            link.close()
        session = self.stack.connect(mac)
        if session.warning:
            self.emit({"event": "sidecar-error", "mac": mac, "error": session.warning})
        link = RadioLink(mac, self.emit, decoder=self.decoder,
                         control_ch=self.control_ch, audio_ch=self.audio_ch,
                         opener=self.stack.open_channel, release=_release)
        try:
            link.open()
        except Exception:
            self.stack.drop(mac)
            raise
        self.links[mac] = link

    def disconnect(self, mac):
        mac = mac.upper()
        link = self.links.pop(mac, None)
        if link:
            link.close()
        self.stack.drop(mac)
        if link:
            self.emit({"event": "status", "mac": mac, "state": "disconnected"})

    def shutdown(self):
        """Release every radio, then the dongle. See BluezBackend.shutdown for why."""
        for mac in list(self.links):
            self.disconnect(mac)
        self.stack.close()
