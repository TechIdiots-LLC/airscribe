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
import concurrent.futures
import socket
import threading

import sbc
import sds
from bluez import LinkControls, RadioLink

CONNECT_SECONDS = 20
PAIR_SECONDS = 60       # the first connection pairs, which can wait on the radio
ENCRYPT_SECONDS = 10    # the UV-Pro took well under one
LE_PAIR_SECONDS = 30    # the SDS150: Just Works, no PIN, while it's in its Pairing menu
GATT_SECONDS = 15       # each step of finding its characteristic
# The link's supervision timeout. Bumble's default, 720 ms, lost the SDS150 about a second after encryption started
# (reason 0x08), as it goes quiet then, saving the pairing; it asks a phone for 4 s itself
LE_SUPERVISION_MS = 4000
# 15 ms, as the scanner asks a phone for itself. Its audio and screen need ~250 packets a second, which a Bluetooth
# 4.0 dongle (27 bytes a packet) barely carries; 7.5 ms didn't help, and the link dropped more
LE_INTERVAL_MS = (15, 15)
# Why a link ended, when it's the scanner's doing: it hung up (0x13), or it hasn't the key (0x06) or refused it (0x05)
SCANNER_REFUSED = (0x05, 0x06, 0x13)
SCAN_SECONDS = 8
# The radios' advertised names, so a scan lists them first. Which model a name
# is stays src/models.js's job; these only sort.
RADIO_NAMES = ("UV-PRO", "UV-50PRO", "GA-5WB", "DB50-B", "RT-660", "VR-N7", "SDS150", "SDS100", "SDS200")
SCANNER_HINT = ("If it has never paired with AirScribe, or its pairings were reset, put it in "
                "Menu > Settings > Bluetooth Options > Pairing and connect again.")


def dongle_hint(error):
    """What to do about a dongle that won't open, going by libusb's error."""
    text = str(error)
    if "ACCESS" in text:
        return ("This user may not open it: give the container's device entry the airscribe group "
                "(Proxmox: GID in CT), or use a udev rule on the host. See docs/proxmox.md.")
    if "BUSY" in text:
        return ("Something else holds it: the host's btusb driver, or another program "
                "such as tools/probe-bumble.py or AirScribe itself.")
    return "Is it passed in, and has the host's btusb let go of it? See docs/proxmox.md."


def keep_supervision_timeout(manager):
    """A peripheral's parameter update gets the interval it asks for, but a supervision timeout no shorter than ours.

    An SDS150 asks for 30-50 ms and 420 ms a few seconds in; Bumble granted it, and every link then timed out (0x08)
    within 1.5 s. A phone it asks for 15 ms and 4 s.
    """
    granted = manager.on_l2cap_connection_parameter_update_request

    def on_request(connection, cid, request):
        request.timeout = max(request.timeout, LE_SUPERVISION_MS // 10)     # in 10 ms units
        granted(connection, cid, request)

    manager.on_l2cap_connection_parameter_update_request = on_request


def reason_name(code):
    """An HCI reason, as Bumble names it, with its number: 0x08 CONNECTION_TIMEOUT_ERROR."""
    try:
        from bumble.hci import HCI_Constant
        return f"0x{code:02X} {HCI_Constant.error_name(code)}"
    except Exception:
        return f"0x{code:02X}"


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


class LeSession:
    """A scanner's LE link, and the one characteristic its frames go through both ways."""

    def __init__(self, connection, peer, characteristic, warning=None):
        self.connection = connection
        self.peer = peer
        self.characteristic = characteristic
        self.warning = warning


def pick_characteristic(services):
    """The SDS150's: notifies and takes writes without response. One in a vendor (128-bit) service first.

    :param services: [(service uuid bytes, [characteristic])] as discovered.
    """
    from bumble.gatt import Characteristic

    want = Characteristic.Properties.NOTIFY | Characteristic.Properties.WRITE_WITHOUT_RESPONSE
    found = [(len(uuid) == 16, c) for uuid, chars in services for c in chars if c.properties & want == want]
    found.sort(key=lambda f: not f[0])
    return found[0][1] if found else None


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
        self.le_sessions = {}
        self.le_addresses = {}   # mac -> the address an LE scan saw it at, with its type
        self.transport = None
        self.closed = False
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
        keep_supervision_timeout(dev.l2cap_channel_manager)
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

        def on_advertisement(adv):
            # Low Energy: the Uniden scanners. Its address type is kept, to connect to it as it advertises
            names = (adv.data.get_all(AdvertisingData.COMPLETE_LOCAL_NAME)
                     or adv.data.get_all(AdvertisingData.SHORTENED_LOCAL_NAME))
            if names:
                mac = _mac(adv.address)
                self.le_addresses[mac] = adv.address
                on_result(adv.address, None, adv.data, adv.rssi)

        self.device.on("inquiry_result", on_result)
        self.device.on("advertisement", on_advertisement)
        le = False
        try:
            await self.device.start_discovery()
            try:
                await self.device.start_scanning(filter_duplicates=True)
                le = True
            except Exception:
                pass    # a dongle without LE still finds the radios
            await asyncio.sleep(seconds)
            await self.device.stop_discovery()
            if le:
                await self.device.stop_scanning()
        finally:
            self.device.remove_listener("inquiry_result", on_result)
            self.device.remove_listener("advertisement", on_advertisement)
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

    # -- Low Energy: the Uniden scanners -------------------------------------------

    def connect_le(self, mac, on_notify):
        """Link to a scanner over LE, pair or reuse the pairing, and subscribe to its frames."""
        self.drop_le(mac)
        try:
            session = self.run(self._connect_le(mac, on_notify),
                               2 * CONNECT_SECONDS + ENCRYPT_SECONDS + LE_PAIR_SECONDS + 2 * GATT_SECONDS + 15)
        except concurrent.futures.TimeoutError as e:
            raise RuntimeError(f"connecting to {mac} over LE took too long") from e
        self.le_sessions[mac] = session
        return session

    async def _connect_le(self, mac, on_notify):
        from bumble import core, hci
        from bumble.device import ConnectionParametersPreferences, Peer

        # As a scan saw it; otherwise random (an SDS150's address is static random), then public
        known = self.le_addresses.get(mac)
        tries = [known] if known else [hci.Address(mac, hci.Address.RANDOM_DEVICE_ADDRESS), hci.Address(f"{mac}/P")]
        # From the dongle's public address, the identity LE pairing gives (as BlueZ does). Connecting from the
        # random one, an SDS150 found its pairing on only some connections and timed out on the rest
        own = (hci.OwnAddressType.PUBLIC if self.device.public_address != hci.Address.ANY
               else hci.OwnAddressType.RANDOM)
        conn, errors = None, []
        for address in tries:
            try:
                conn = await self.device.connect(
                    address, transport=core.PhysicalTransport.LE, timeout=CONNECT_SECONDS, own_address_type=own,
                    connection_parameters_preferences={hci.HCI_LE_1M_PHY: ConnectionParametersPreferences(
                        connection_interval_min=LE_INTERVAL_MS[0], connection_interval_max=LE_INTERVAL_MS[1],
                        supervision_timeout=LE_SUPERVISION_MS)})
                break
            except Exception as e:
                errors.append(f"{address}: {type(e).__name__} {e}".strip())
        if conn is not None:
            conn.airscribe_reasons = []
            conn.on("disconnection", conn.airscribe_reasons.append)
        if conn is None:
            raise RuntimeError(f"couldn't reach {mac} over LE ({'; '.join(errors)}). Is its Bluetooth on, "
                               "and nothing else (U/AWARE) connected to it?")
        step = "pairing"
        try:
            warning = await self._secure_le(conn, mac)
            peer = Peer(conn)
            step = "asking for a larger MTU"
            try:
                await asyncio.wait_for(peer.request_mtu(517), GATT_SECONDS)   # its frames run to ~480 bytes
            except Exception:
                pass
            step = "finding its services"
            await asyncio.wait_for(peer.discover_services(), GATT_SECONDS)
            found = []
            for s in peer.services:
                step = f"finding the characteristics of service {s.uuid}"
                found.append((s.uuid.to_bytes(), await asyncio.wait_for(s.discover_characteristics(), GATT_SECONDS)))
            char = pick_characteristic(found)
            if char is None:
                raise RuntimeError(f"{mac} has no characteristic that notifies and takes writes: is it an SDS150?")
            step = "subscribing to its frames"
            await asyncio.wait_for(peer.subscribe(char, on_notify), GATT_SECONDS)
        except BaseException as e:
            try:
                await conn.disconnect()
            except Exception:
                pass
            if isinstance(e, RuntimeError):
                raise       # already says what happened
            # Bumble cancels what's waiting when the link drops: the scanner hung up at this step
            if isinstance(e, asyncio.CancelledError) or conn.handle not in self.device.connections:
                raise RuntimeError(f"{mac} hung up while AirScribe was {step}. {SCANNER_HINT}") from e
            if isinstance(e, Exception) and not isinstance(e, RuntimeError):
                raise RuntimeError(f"{mac} over LE, {step}: {type(e).__name__} {e}".strip()) from e
            raise
        session = LeSession(conn, peer, char, warning)
        session.on_disconnect = None
        conn.on("disconnection", lambda reason: self._on_le_disconnection(mac, session, reason))
        return session

    async def _secure_le(self, conn, mac):
        """Encrypt with the pairing we have, or pair (Just Works). :returns: a warning, or None."""
        keys = None
        if self.device.keystore is not None:
            try:
                keys = await self.device.keystore.get(str(conn.peer_address))
            except Exception:
                keys = None
        if keys is not None and (keys.ltk or keys.ltk_central):
            try:
                await asyncio.wait_for(conn.encrypt(), ENCRYPT_SECONDS)
                return None
            except (Exception, asyncio.CancelledError) as e:
                await asyncio.sleep(0.3)    # the link's end, if it's ending, to say why
                reasons = getattr(conn, "airscribe_reasons", [])
                code = getattr(e, "error_code", None)
                if (reasons and reasons[-1] in SCANNER_REFUSED) or code in SCANNER_REFUSED:
                    # It has forgotten us (Reset Pairings): it hangs up ~0.3 s after asking to pair. Drop the
                    # key, or every retry tries it again, as a phone that kept its old key did 57 times
                    try:
                        await self.device.keystore.delete(str(conn.peer_address))
                    except Exception:
                        pass
                    if conn.handle not in self.device.connections:
                        raise RuntimeError(f"{mac} refused the pairing AirScribe had kept; it's forgotten, and the "
                                           f"next try pairs afresh. {SCANNER_HINT}") from e
                    # Still linked: pair afresh on this link, below
                elif conn.handle not in self.device.connections:
                    # The link was lost, not refused: the pairing is still good on both sides, so it's kept
                    why = reason_name(reasons[-1]) if reasons else type(e).__name__
                    raise RuntimeError(f"the link to {mac} dropped while encrypting ({why}); "
                                       "its pairing is kept, and the next try uses it") from e
        try:
            await asyncio.wait_for(conn.pair(), LE_PAIR_SECONDS)
            return None
        except (Exception, asyncio.CancelledError) as e:
            if conn.handle not in self.device.connections:
                raise RuntimeError(f"{mac} hung up while pairing ({type(e).__name__}). {SCANNER_HINT}") from e
            return f"the link to {mac} isn't encrypted ({type(e).__name__} {e}). {SCANNER_HINT}"

    def _on_le_disconnection(self, mac, session, reason):
        # On the loop thread, which the link's close() must not hold up
        if self.le_sessions.get(mac) is session:
            del self.le_sessions[mac]
        if session.on_disconnect:
            threading.Thread(target=session.on_disconnect, args=(reason,), daemon=True).start()

    def write_le(self, mac, data):
        session = self.le_sessions.get(mac)
        if not session:
            raise OSError(f"no link to {mac}")
        self.run(session.peer.write_value(session.characteristic, bytes(data), with_response=False), 5)

    def drop_le(self, mac):
        session = self.le_sessions.pop(mac, None)
        if not session:
            return
        session.on_disconnect = None
        try:
            self.run(asyncio.wait_for(session.connection.disconnect(), 5), 10)
        except Exception:
            pass

    def close(self):
        if self.closed:
            return
        self.closed = True
        for mac in list(self.sessions):
            self.drop(mac)
        for mac in list(self.le_sessions):
            self.drop_le(mac)
        if self.transport is not None:
            # Bumble's USB close waits for its libusb event thread before
            # freeing anything; stopping the loop before it has finished leaves
            # libusb to be torn down under that thread, which aborts the
            # process. So it gets time, and the loop stops after it.
            try:
                self.run(self.transport.close(), 20)
            except Exception:
                pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        if not self.loop.is_running():
            self.loop.close()


def _release(sock):
    sock.shutdown()
    sock.close()


class BumbleBackend(LinkControls):
    """The sidecar's `bumble` backend: the same commands as BluezBackend."""

    def __init__(self, emit, transport="usb:0", keys=None, control_ch=None, audio_ch=None,
                 stack=None):
        self.emit = emit
        self.control_ch = control_ch
        self.audio_ch = audio_ch
        self.links = {}
        self.scanners = {}       # mac -> sds.ScannerLink
        self.opus = None         # found when a scanner first connects
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
                    f"{dongle_hint(e)}") from e
        self.stack = stack

    def scan(self):
        return self.stack.scan()

    def connect(self, mac, link=None):
        mac = mac.upper()
        if link == "sds-ble":
            return self._connect_scanner(mac)
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

    def _connect_scanner(self, mac):
        """A Uniden SDS150 over LE: its frames through sds.ScannerLink."""
        current = self.scanners.get(mac)
        if current and not current.stop.is_set():
            return
        if self.opus is None:
            self.opus = sds.find_decoder() or False
            if not self.opus:
                self.emit({"event": "sidecar-error", "mac": mac,
                           "error": "no Opus-capable ffmpeg found; the scanner's audio cannot be decoded"})
        holder = {}

        def on_notify(value):
            scanner = holder.get("link")
            if scanner is not None:
                scanner.on_notify(value)

        session = self.stack.connect_le(mac, on_notify)
        if session.warning:
            self.emit({"event": "sidecar-error", "mac": mac, "error": session.warning})
        scanner = sds.ScannerLink(mac, self.emit, lambda data: self.stack.write_le(mac, data),
                                  decoder=self.opus or None)
        scanner.on_gone = lambda: self._scanner_gone(mac, scanner)
        session.on_disconnect = lambda reason: self._scanner_gone(mac, scanner, reason)
        holder["link"] = scanner
        self.scanners[mac] = scanner
        scanner.open(detail="Bluetooth LE")

    def _scanner(self, mac):
        scanner = self.scanners.get(mac.upper())
        if scanner is None or scanner.stop.is_set():
            raise RuntimeError(f"{mac} isn't connected over Bluetooth LE")
        return scanner

    def scanner_key(self, mac, key, hold_ms=100):
        self._scanner(mac).press(key, hold_ms)

    def scanner_waterfall(self, mac, seconds):
        self._scanner(mac).waterfall(seconds)

    def _scanner_gone(self, mac, scanner, reason=None):
        """It disconnected, or stopped answering: say so, and why; the server retries."""
        if reason is not None and not scanner.stop.is_set():
            self.emit({"event": "sidecar-error", "mac": mac,
                       "error": f"the scanner's link dropped: {reason_name(reason)}"})
        if self.scanners.get(mac) is scanner:
            del self.scanners[mac]
        scanner.close()
        self.stack.drop_le(mac)

    def disconnect(self, mac):
        mac = mac.upper()
        scanner = self.scanners.pop(mac, None)
        if scanner:
            scanner.close()
            self.stack.drop_le(mac)
            return
        link = self.links.pop(mac, None)
        if link:
            link.close()
        self.stack.drop(mac)
        if link:
            self.emit({"event": "status", "mac": mac, "state": "disconnected"})

    def shutdown(self):
        """Release every radio, then the dongle. See BluezBackend.shutdown for why."""
        for mac in list(self.links) + list(self.scanners):
            self.disconnect(mac)
        self.stack.close()
