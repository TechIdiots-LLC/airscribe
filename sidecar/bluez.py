"""The real radio link, over BlueZ.

Everything here was learned from a BTech UV-Pro; see docs/bluetooth.md for the
evidence behind each rule.

Two RFCOMM channels are opened and then **held for the life of the
connection**. That is not an optimisation — closing the control channel and
reopening it gets ECONNREFUSED from the radio, and repeating that wedges its
control service until its Bluetooth is power-cycled. So this connects once,
holds, and releases only on disconnect.

Channel numbers differ per radio and are not stable, so they are discovered
rather than configured: the control channel is the one that answers a GAIA
query, and the audio channel is the one whose opening flips
`is_aoc_connected` in the radio's own status. Probing costs sessions the radio
is slow to free, so a known-good pair can be given in the config to skip it.

Audio is decoded per transmission. The radio delimits each one, so a run's SBC
is collected and decoded when the run closes.
"""

import contextlib
import socket
import threading
import time

from htframe import FrameReader
import sbc as sbc_codec

# GAIA: FF 01 <flags> <payload len> <group hi/lo> <command hi/lo> <payload>
GET_HT_STATUS = bytes([0xFF, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x14])
# READ_STATUS (5) with power-status type 4, "battery level as a percentage".
# The two-byte argument is the type as a big-endian short.
GET_BATTERY = bytes([0xFF, 0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x05, 0x00, 0x04])

BATTERY_EVERY = 60  # seconds; a percentage does not move fast
POSITION_EVERY = 60  # seconds; a monitoring radio rarely moves

# GET_DEV_INFO (4), argument 3 - carries the channel count among much else.
GET_DEV_INFO = bytes([0xFF, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x04, 0x03])
READ_RF_CH = 13     # one channel's name and frequencies, by index
WRITE_RF_CH = 14    # one channel, the same 25-byte record READ_RF_CH returns

AUDIO_CMDS = {0x00, 0x03}   # received audio
TRANSMIT_CMD = 0x09         # audio the radio is itself sending
AUDIO_END = 0x01

SETTLE = 0.6                # the radio frees a channel slowly
STATUS_PERIOD = 1.0         # how often to poll squelch/RSSI
MAX_RUN_BYTES = 8 << 20     # a stuck transmitter must not exhaust memory


def _release(sock):
    """Hand a channel back. A bare close() does not free it on the radio."""
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def _rfcomm(mac, channel, timeout=8):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    s.settimeout(timeout)
    try:
        s.connect((mac, channel))
    except OSError:
        s.close()
        raise
    return s


def read_rf_ch_frame(channel_id):
    """Build a READ_RF_CH request for one channel index."""
    return bytes([0xFF, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, READ_RF_CH, channel_id & 0xFF])


def parse_channel(buf):
    """Name and frequencies of one channel, or None.

    Layout follows the reference parser: after the four GAIA command bytes
    comes a status byte, the channel id, two 30-bit frequencies, sub-audio
    tones, two flag bytes, then a ten-byte name.
    """
    if len(buf) < 12 or buf[0] != 0xFF:
        return None
    m = buf[4:4 + 4 + buf[3]]
    if len(m) < 30 or m[4] != 0x00:
        return None

    def freq(at):
        # The top two bits are the modulation, not part of the frequency.
        return (((m[at] & 0x3F) << 24) | (m[at + 1] << 16) | (m[at + 2] << 8) | m[at + 3])

    name = bytes(m[20:30]).split(b"\x00")[0].decode("utf-8", "replace").strip()
    return {
        "id": m[5],
        "name": name,
        "rx_hz": freq(10),
        "tx_hz": freq(6),
        "scan": bool(m[18] & 0x80),
    }


def parse_channel_count(buf):
    """How many channels the radio holds, from a GET_DEV_INFO reply."""
    if len(buf) < 12 or buf[0] != 0xFF:
        return None
    m = buf[4:4 + 4 + buf[3]]
    return m[13] if len(m) > 13 else None


def parse_battery(buf):
    """Percentage from a READ_STATUS reply, or None if it is not one.

    Reply payload is: status byte, the power-status type as a big-endian
    short, then the value. Only type 4 is a percentage.
    """
    if len(buf) < 12 or buf[0] != 0xFF:
        return None
    m = buf[4:4 + 4 + buf[3]]
    if len(m) < 8 or (m[4] != 0x00):
        return None
    if ((m[5] << 8) | m[6]) != 4:
        return None
    return m[7]


def parse_ht_status(buf):
    """Decode a GAIA HT-status reply.

    Offsets follow the reference parser: the GAIA command begins at byte 4,
    and within it byte 5 carries the power/TX/squelch/RX bits.
    :param buf: Raw bytes read from the control channel.
    :returns: dict, or None if this is not a well-formed status reply.
    """
    if len(buf) < 13 or buf[0] != 0xFF or buf[1] != 0x01:
        return None
    m = buf[4:4 + 4 + buf[3]]
    if len(m) < 9:
        return None
    return {
        "power_on": bool(m[5] & 0x80),
        "in_tx": bool(m[5] & 0x40),
        "squelch": bool(m[5] & 0x20),
        "in_rx": bool(m[5] & 0x10),
        "scanning": bool(m[5] & 0x02),
        "gps_locked": bool(m[6] & 0x08),
        "hfp_connected": bool(m[6] & 0x04),
        "aoc_connected": bool(m[6] & 0x02),
        "rssi": m[7] >> 4,
        # Split across two bytes: the low nibble of m[6] and bits of m[8].
        "channel": (((m[8] & 0x3C) >> 2) << 4) + (m[6] >> 4),
        # The region (bank of channels) the radio is on; "channel" is an index
        # into that region's table, so a different region means other names
        "region": ((m[7] & 0x0F) << 2) | (m[8] >> 6),
        # Dual watch: 0 off, else the VFO selected (1 A, 2 B, 3 C)
        "dual": (m[5] & 0x0C) >> 2,
    }


# ---- Reading and changing the radio's settings ------------------------------
# Byte layouts from HTCommander's protocol reference
# (Ylianst/HTCommander docs/blogs/radio-command-protocol.md and
# src/lib/radio/radio_models.dart). Offsets below are into the un-framed
# command, `m`: [group hi, group lo, cmd hi, cmd lo, status, payload...].

CMD_WRITE_SETTINGS = 11
CMD_SET_VOLUME = 23
CMD_SET_REGION = 60
READ_SETTINGS = 10
GET_VOLUME = 22
READ_REGION_NAME = 73
GET_POSITION = 76


def gaia(cmd, payload=b""):
    """A basic-group (2) GAIA command frame: FF 01 00 <len> 00 02 <cmd hi> <cmd lo> <payload>."""
    payload = bytes(payload)
    return bytes([0xFF, 0x01, 0x00, len(payload), 0x00, 0x02, (cmd >> 8) & 0xFF, cmd & 0xFF]) + payload


def unframe(buf):
    """The command inside a GAIA frame, or None if it isn't a successful reply."""
    if len(buf) < 9 or buf[0] != 0xFF or buf[1] != 0x01:
        return None
    m = buf[4:4 + 4 + buf[3]]
    if len(m) < 5 or m[4] != 0x00:
        return None
    return m


def parse_dev_info(buf):
    """Channel and region counts from a GET_DEV_INFO reply, or None."""
    m = unframe(buf)
    if m is None or len(m) < 15:
        return None
    return {
        "channel_count": m[13],
        "region_count": ((m[11] & 0x03) << 4) | ((m[12] & 0xF0) >> 4),
        "noaa": bool(m[12] & 0x08),
        "vfo": bool(m[12] & 0x02),
    }


def parse_settings(buf):
    """The settings block from a READ_SETTINGS reply, or None.

    "raw" is everything after the status byte: a write sends it back with only
    the bytes being changed altered, so every field this doesn't model is kept.
    """
    m = unframe(buf)
    if m is None or len(m) < 15:
        return None
    return {
        "channel_a": ((m[5] & 0xF0) >> 4) | (m[14] & 0xF0),
        "channel_b": (m[5] & 0x0F) | ((m[14] & 0x0F) << 4),
        "scan": bool(m[6] & 0x80),
        "dual": (m[6] & 0x30) >> 4,
        "squelch": m[6] & 0x0F,
        "raw": bytes(m[5:]),
    }


def settings_payload(raw, channel_a=None, channel_b=None, dual=None, scan=None, squelch=None):
    """A WRITE_SETTINGS payload: the last-read block, with only these changed.

    Built as HTCommander's RadioSettings.toByteArray does it: the channel ids
    are split between the first byte (low nibbles) and the tenth (high
    nibbles); scan, dual watch and squelch share the second, whose 0x40 bit
    (a hands-free call mode) is kept as read.
    """
    data = bytearray(raw)
    if len(data) < 10:
        raise ValueError("the radio's settings block is too short to change")
    cur_a = ((data[0] & 0xF0) >> 4) | (data[9] & 0xF0)
    cur_b = (data[0] & 0x0F) | ((data[9] & 0x0F) << 4)
    a = cur_a if channel_a is None else channel_a
    b = cur_b if channel_b is None else channel_b
    d = (data[1] & 0x30) >> 4 if dual is None else dual
    s = bool(data[1] & 0x80) if scan is None else scan
    q = data[1] & 0x0F if squelch is None else squelch
    data[0] = ((a & 0x0F) << 4) | (b & 0x0F)
    data[1] = (0x80 if s else 0) | (data[1] & 0x40) | ((d & 0x03) << 4) | (q & 0x0F)
    data[9] = (a & 0xF0) | ((b >> 4) & 0x0F)
    return bytes(data)


def parse_volume(buf):
    """Volume, 0 to 15, from a GET_VOLUME reply, or None."""
    m = unframe(buf)
    return m[5] if m is not None and len(m) > 5 else None


def parse_region_name(buf):
    """(index, name) from a READ_REGION_NAME reply, or None. The name is ten
    null-padded bytes, GBK as the radio writes it (ASCII reads the same)."""
    m = unframe(buf)
    if m is None or len(m) < 6:
        return None
    raw = bytes(m[6:16]).split(b"\x00")[0]
    try:
        name = raw.decode("gbk")
    except UnicodeDecodeError:
        name = raw.decode("utf-8", "replace")
    return m[5], name.strip()


def parse_position(buf):
    """Where the radio's GPS puts it, from a GET_POSITION reply, or None
    without a fix. Latitude and longitude are 24-bit signed minutes x 500."""
    m = unframe(buf)
    if m is None or len(m) < 17:
        return None

    def coord(at):
        v = (m[at] << 16) | (m[at + 1] << 8) | m[at + 2]
        if v & 0x800000:
            v -= 0x1000000
        return round(v / 60.0 / 500.0, 6)

    pos = {
        "lat": coord(5),
        "lon": coord(8),
        "alt_m": (m[11] << 8) | m[12],
        "speed": (m[13] << 8) | m[14],
        "heading": (m[15] << 8) | m[16],
    }
    if len(m) >= 21:
        pos["time"] = (m[17] << 24) | (m[18] << 16) | (m[19] << 8) | m[20]
    if not (-90 <= pos["lat"] <= 90 and -180 <= pos["lon"] <= 180):
        return None
    return pos


# ---- Channels: the record the radio keeps for each -----------------------------
# 25 bytes, as READ_RF_CH returns after its status byte and WRITE_RF_CH takes
# (HTCommander's RadioChannelInfo): the slot, the transmit and receive
# frequencies in hertz with the modulation in each one's top two bits, the
# transmit and receive sub-audio tones, two bytes of flags, and a ten-byte name.

RECORD = 25
MODULATIONS = ("FM", "AM", "DMR")
MAX_HZ = (1 << 30) - 1


def tone_name(v):
    """A sub-audio tone as the radio keeps it, as text: CTCSS in hundredths of
    a hertz (1000 and up) is "127.3", DCS by its code's digits (below 1000) is
    "D023", and 0, no tone, is ""."""
    if not v:
        return ""
    if v >= 1000:
        return f"{v / 100:.1f}"
    return f"D{v:03d}"


def tone_value(text):
    """The other way: "127.3" (CTCSS, in hertz), "D023" (DCS), or "" for none."""
    s = str(text or "").strip().upper()
    if not s:
        return 0
    if s.startswith("D"):
        code = s[1:]
        if len(code) != 3 or any(c not in "01234567" for c in code):
            raise ValueError(f"{text} isn't a DCS code")
        return int(code)
    try:
        hz = float(s)
    except ValueError:
        raise ValueError(f"{text} isn't a tone: CTCSS in hertz, or D and a DCS code") from None
    if not 60.0 <= hz <= 260.0:
        raise ValueError(f"{text} Hz isn't a CTCSS tone")
    return round(hz * 100)


def decode_channel(rec):
    """Everything one channel record holds, and the record itself (as "raw",
    so it can be written back exactly, bits this doesn't model included)."""
    rec = bytes(rec)

    def freq(at):
        return ((rec[at] & 0x3F) << 24) | (rec[at + 1] << 16) | (rec[at + 2] << 8) | rec[at + 3]

    flags, more = rec[13], rec[14]
    name = rec[15:25].split(b"\x00")[0].decode("utf-8", "replace").strip()
    mod = rec[5] >> 6
    return {
        "id": rec[0],
        "name": name,
        "rx_hz": freq(5),
        "tx_hz": freq(1),
        "mod": MODULATIONS[mod] if mod < len(MODULATIONS) else "FM",
        "bandwidth": "wide" if flags & 0x10 else "narrow",
        "rx_tone": tone_name((rec[11] << 8) | rec[12]),
        "tx_tone": tone_name((rec[9] << 8) | rec[10]),
        "scan": bool(flags & 0x80),
        "power": "high" if flags & 0x40 else "medium" if flags & 0x02 else "low",
        "talk_around": bool(flags & 0x20),
        "tx_disable": bool(flags & 0x01),
        "mute": bool(more & 0x10),
        "empty": not name and not freq(5),
        "raw": rec.hex(),
    }


def _number(value, what, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{what} must be a whole number from {low} to {high}")
    return value


def encode_channel(ch):
    """The record for a channel described by its fields, as decode_channel
    gives them. Built from nothing, as HTCommander's channel import builds one:
    flags not given are off (de-emphasis stays on). A receive frequency of 0
    is an empty slot, the way the radio keeps one."""
    slot = _number(ch.get("id"), "a channel's slot", 0, 255)
    rx = _number(ch.get("rx_hz") or 0, "a receive frequency", 0, MAX_HZ)
    if not rx:
        return bytes([slot]) + bytes(RECORD - 1)
    tx = _number(ch.get("tx_hz") or rx, "a transmit frequency", 1, MAX_HZ)
    mod = str(ch.get("mod") or "FM").upper()
    if mod not in ("FM", "AM"):
        raise ValueError(f"a channel is FM or AM here, not {mod}")
    rec = bytearray(RECORD)
    rec[0] = slot
    rec[1:5] = tx.to_bytes(4, "big")
    rec[5:9] = rx.to_bytes(4, "big")
    rec[1] |= MODULATIONS.index(mod) << 6
    rec[5] |= MODULATIONS.index(mod) << 6
    rec[9:11] = tone_value(ch.get("tx_tone")).to_bytes(2, "big")
    rec[11:13] = tone_value(ch.get("rx_tone")).to_bytes(2, "big")
    power = ch.get("power") or "high"
    if power not in ("high", "medium", "low"):
        raise ValueError("power is high, medium or low")
    bandwidth = ch.get("bandwidth") or "wide"
    if bandwidth not in ("wide", "narrow"):
        raise ValueError("bandwidth is wide or narrow")
    rec[13] = ((0x80 if ch.get("scan") else 0) | (0x40 if power == "high" else 0)
               | (0x20 if ch.get("talk_around") else 0) | (0x10 if bandwidth == "wide" else 0)
               | (0x02 if power == "medium" else 0) | (0x01 if ch.get("tx_disable") else 0))
    rec[14] = 0x10 if ch.get("mute") else 0
    name = str(ch.get("name") or "").strip()
    if any(not 32 <= ord(c) < 127 for c in name) or len(name) > 10:
        raise ValueError(f"{name!r}: a channel's name is up to ten plain letters, digits and signs")
    rec[15:15 + len(name)] = name.encode("ascii")
    return bytes(rec)


def channel_record(ch):
    """What to write for one channel: a record as it was read ("raw", for
    putting a backup back exactly), or one built from its fields."""
    if ch.get("raw"):
        try:
            rec = bytes.fromhex(str(ch["raw"]))
        except ValueError:
            raise ValueError("a channel's raw record isn't hex") from None
        if len(rec) != RECORD:
            raise ValueError(f"a channel's record is {RECORD} bytes")
        if ch.get("id") is not None and _number(ch["id"], "a channel's slot", 0, 255) != rec[0]:
            rec = bytes([ch["id"]]) + rec[1:]
        return rec
    return encode_channel(ch)


def same_channel(a, b):
    """Whether two records describe the same channel: everything decoded, or
    both empty (an empty slot's other bits are whatever the radio left)."""
    da, db = decode_channel(a), decode_channel(b)
    if da["empty"] and db["empty"]:
        return da["id"] == db["id"]
    da.pop("raw")
    db.pop("raw")
    return da == db


class LinkControls:
    """The radio controls, for a backend that keeps a RadioLink per radio in
    `self.links` (BlueZ and Bumble alike)."""

    def _link(self, mac):
        link = self.links.get(mac.upper())
        if link is None or link.stop.is_set():
            raise RuntimeError(f"{mac} isn't connected")
        return link

    def radio_info(self, mac):
        return self._link(mac).info()

    def control(self, mac, action, value):
        return self._link(mac).control(action, value)

    def read_region(self, mac, region=None):
        return self._link(mac).read_region(region)

    def write_region(self, mac, region, channels):
        return self._link(mac).write_region(region, channels)


class RadioLink:
    """One connected radio: two held sockets and the threads reading them.

    `opener(mac, channel, timeout)` returns a connected socket and raises
    OSError when the radio refuses; `release(sock)` hands one back. They are
    the kernel's RFCOMM sockets by default. The Bumble backend passes its own,
    whose objects act enough like sockets for everything here
    (sidecar/bumble_link.py).
    """

    def __init__(self, mac, emit, decoder=None, control_ch=None, audio_ch=None,
                 opener=None, release=None):
        self.opener = opener or (lambda m, ch, timeout: _rfcomm(m, ch, timeout=timeout))
        self.release = release or _release
        self.mac = mac
        self.emit = emit
        self.decoder = decoder
        self.control_ch = control_ch
        self.audio_ch = audio_ch
        self.ctrl = None
        self.audio = None
        self.stop = threading.Event()
        self.lock = threading.Lock()   # the control socket is shared
        self.threads = []
        self.channels = {}             # index -> {name, rx_hz, ...}
        self.channel = None            # the one the radio is on now
        self.channels_region = None    # the region the channel table was read for
        self.channel_count = 0         # slots in each region
        self.region_count = 0
        self._region_names = None
        self.position = None           # the radio's GPS fix, when it has one
        # Set while channels are read or written in another region: the radio
        # is moved there and back, which the status poll mustn't take for a
        # region changed on the radio and read the table for
        self.editing = threading.Event()

    # -- control channel ---------------------------------------------------

    def request(self, frame, reply=True, timeout=3.0):
        """Send one GAIA command and return its reply frame, or b"".

        Reads the length out of the header rather than assuming one, because
        replies differ per command - a status reply and a battery reply are
        not the same size, and reading a fixed count leaves the rest of one
        in the socket to corrupt the next.

        The reply is the frame carrying the same command (the radio sets the
        top bit on replies); anything else is skipped. Some commands get no
        reply, or none on some firmware (SET_REGION, WRITE_SETTINGS), and
        their late or missing answer would otherwise be read as the answer to
        the next question, putting every one after it out by one. A command
        sent with reply=False is sent and not waited for.
        """
        want = ((frame[6] << 8) | frame[7]) & 0x7FFF if len(frame) >= 8 else None
        with self.lock:
            # close() clears self.ctrl from another thread; a poll in flight
            # then finds no channel, which is the same as a dead one
            ctrl = self.ctrl
            if ctrl is None:
                return b""
            try:
                ctrl.settimeout(timeout)
                ctrl.sendall(frame)
                if not reply:
                    return b""
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    head = self._recv_exactly(ctrl, 4)
                    if len(head) < 4 or head[0] != 0xFF or head[1] != 0x01:
                        return b""
                    # header(4) + group/command(4) + payload + optional checksum
                    rest = 4 + head[3] + (head[2] & 1)
                    got = head + self._recv_exactly(ctrl, rest)
                    if want is None or (len(got) >= 8 and (((got[6] << 8) | got[7]) & 0x7FFF) == want):
                        return got
                    # A stray: an earlier command's late reply, or a notification
                return b""
            except OSError:
                return b""

    @staticmethod
    def _recv_exactly(sock, n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                break
            buf += chunk
        return buf

    def status(self):
        """Ask the radio its state. None when it does not answer."""
        return parse_ht_status(self.request(GET_HT_STATUS))

    def battery(self):
        """Battery percentage, or None when the radio does not say."""
        return parse_battery(self.request(GET_BATTERY))

    def read_channels(self):
        """Read the radio's channel table once, for names and frequencies.

        A transcript without the channel it came from is half the story on a
        scanning radio, and the status poll reports only an index. Read at
        connect because the table rarely changes and each read is a request
        competing with the audio channel.
        """
        reply = self.request(GET_DEV_INFO)
        info = parse_dev_info(reply)
        if info:
            self.region_count = info["region_count"]
        count = info["channel_count"] if info else parse_channel_count(reply)
        if not count:
            return
        self.channel_count = count
        # Read for the region the radio is on now: channel ids are indexes into
        # the current region's table
        st = self.status()
        if st:
            self.channels_region = st["region"]
        channels = {}
        for i in range(count):
            if self.stop.is_set():
                return
            ch = parse_channel(self.request(read_rf_ch_frame(i)))
            # Unprogrammed slots come back with no name and no frequency.
            if ch and (ch["name"] or ch["rx_hz"]):
                channels[ch["id"]] = ch
        self.channels = channels
        self.emit({"event": "channels", "mac": self.mac, "region": self.channels_region,
                   "channels": list(self.channels.values())})

    # -- settings, volume, regions, position --------------------------------

    def read_settings(self):
        """The radio's settings now, with the raw block a write is built from."""
        return parse_settings(self.request(gaia(READ_SETTINGS)))

    def volume(self):
        """The radio's volume, 0 to 15, or None."""
        return parse_volume(self.request(gaia(GET_VOLUME)))

    def region_names(self):
        """The names of the radio's regions (banks of channels), read once."""
        if self._region_names is None and self.region_count:
            names = []
            for i in range(self.region_count):
                got = parse_region_name(self.request(gaia(READ_REGION_NAME, [i])))
                names.append(got[1] if got and got[0] == i else "")
            self._region_names = names
        return self._region_names or []

    def info(self):
        """Everything the controls show, read from the radio now."""
        s = self.read_settings()
        if s is None:
            raise RuntimeError("the radio didn't send its settings")
        st = self.status() or {}
        return {
            "settings": {k: v for k, v in s.items() if k != "raw"},
            "volume": self.volume(),
            "region": st.get("region", self.channels_region),
            "regions": self.region_names(),
            "channels": sorted(self.channels.values(), key=lambda c: c["id"]),
            "scanning": st.get("scanning"),
            "position": self.position,
        }

    def write_settings(self, **changes):
        """Change some settings: read them fresh, alter only what's asked,
        write the block back, and read again to see what the radio kept."""
        before = self.read_settings()
        if before is None:
            raise RuntimeError("the radio didn't send its settings")
        reply = self.request(gaia(CMD_WRITE_SETTINGS, settings_payload(before["raw"], **changes)))
        m = unframe(reply) if reply else None
        if reply and m is None:
            raise RuntimeError("the radio refused the settings")
        # Older firmware sends no reply; either way, what it has now is the answer
        time.sleep(0.3)
        after = self.read_settings()
        if after is None:
            raise RuntimeError("the radio didn't send its settings back")
        unkept = [k for k, v in changes.items() if v is not None and after.get(k) != v]
        if unkept:
            raise RuntimeError(f"the radio didn't take the change to {', '.join(unkept)}")
        return after

    def control(self, action, value):
        """Change one thing on the radio, and return the controls' new state.

        channel_a/channel_b take a channel id; on VFO B in dual watch, B is
        also selected, since the radio only takes a change on the selected
        VFO (as HTCommander found). region changes the bank of channels; the
        channel table is read again for it.
        """
        if action == "volume":
            v = int(value)
            if not 0 <= v <= 15:
                raise ValueError("volume is 0 to 15")
            self.request(gaia(CMD_SET_VOLUME, [v]), timeout=2)
            if self.volume() != v:
                raise RuntimeError("the radio didn't take the new volume")
        elif action == "squelch":
            v = int(value)
            if not 0 <= v <= 9:
                raise ValueError("squelch is 0 to 9")
            self.write_settings(squelch=v)
        elif action == "scan":
            self.write_settings(scan=bool(value))
        elif action == "dual":
            self.write_settings(dual=1 if value else 0)
        elif action in ("channel_a", "channel_b"):
            v = int(value)
            if v not in self.channels:
                raise ValueError(f"channel {v} isn't programmed in this region")
            if action == "channel_a":
                self.write_settings(channel_a=v)
            else:
                s = self.read_settings()
                self.write_settings(channel_b=v, dual=2 if s and s["dual"] else None)
        elif action == "region":
            v = int(value)
            if not 0 <= v < max(self.region_count, 1):
                raise ValueError(f"region is 0 to {self.region_count - 1}")
            self._set_region(v)
            # Said first, so the status poll doesn't read the table a second time
            self.channels_region = v
            self.read_channels()
        else:
            raise ValueError(f"unknown control {action}")
        return self.info()

    def _set_region(self, v):
        """Move the radio to region v, and wait until it says it's there."""
        self.request(gaia(CMD_SET_REGION, [v]), reply=False)
        # No reply: watch the status until the radio reports the new region
        for _ in range(10):
            time.sleep(0.3)
            st = self.status()
            if st and st["region"] == v:
                return
        raise RuntimeError("the radio didn't move to that region")

    # -- reading and writing whole channels -------------------------------

    def read_record(self, slot):
        """One slot's 25-byte record as the radio has it now, or None.

        Checked to be the slot asked for: replies are matched by command, so a
        late answer to an earlier READ_RF_CH would otherwise pass for this one.
        """
        for _ in range(2):
            m = unframe(self.request(read_rf_ch_frame(slot)))
            if m is not None and len(m) >= 5 + RECORD and m[5] == slot:
                return bytes(m[5:5 + RECORD])
        return None

    def _slots(self):
        if not self.channel_count:
            info = parse_dev_info(self.request(GET_DEV_INFO))
            if info:
                self.channel_count = info["channel_count"]
                self.region_count = info["region_count"]
        if not self.channel_count:
            raise RuntimeError("the radio didn't say how many channels it holds")
        return self.channel_count

    @contextlib.contextmanager
    def in_region(self, region):
        """Do something in one region: the radio is moved there if it's on
        another, and back afterwards. Yields the region it was on."""
        st = self.status()
        if st is None:
            raise RuntimeError("the radio didn't answer")
        here = st["region"]
        if region is None or region == here:
            yield here
            return
        if not 0 <= region < max(self.region_count, 1):
            raise ValueError(f"region is 0 to {max(self.region_count, 1) - 1}")
        self.editing.set()
        try:
            self._set_region(region)
            yield here
        finally:
            try:
                self._set_region(here)
            finally:
                self.editing.clear()

    def read_region(self, region=None):
        """Every slot of one region, programmed or not, read from the radio now:
        what a backup keeps."""
        count = self._slots()
        with self.in_region(region) as here:
            records = []
            for slot in range(count):
                if self.stop.is_set():
                    raise RuntimeError("the radio disconnected")
                rec = self.read_record(slot)
                if rec is None:
                    raise RuntimeError(f"the radio didn't send channel {slot + 1}")
                records.append(rec)
        region = here if region is None else region
        return {"region": region, "name": self._region_name(region), "count": count,
                "channels": [decode_channel(r) for r in records]}

    def _region_name(self, region):
        names = self.region_names()
        return names[region] if 0 <= region < len(names) else ""

    def write_region(self, region, channels):
        """Write channels into slots of one region, each read back to see the
        radio kept it as sent (HTCommander reads one back after writing it, too).

        `channels` are records as read ({"raw"}, putting a backup back) or
        fields, as decode_channel gives them. A slot the radio refuses or
        changes is reported, and the rest are still written. The region's
        table is read again afterwards when it's the one the radio is on, so
        transmissions are filed under the new names.
        """
        records = [channel_record(ch) for ch in channels]
        if len({r[0] for r in records}) != len(records):
            raise ValueError("a slot is given twice")
        count = self._slots()
        for rec in records:
            if rec[0] >= count:
                raise ValueError(f"the radio has {count} channels in a region; there's no channel {rec[0] + 1}")
        results = []
        with self.in_region(region) as here:
            for rec in records:
                if self.stop.is_set():
                    raise RuntimeError("the radio disconnected")
                reply = self.request(gaia(WRITE_RF_CH, rec))
                if reply and unframe(reply) is None:
                    results.append({"id": rec[0], "ok": False, "error": "the radio refused it"})
                    continue
                back = self.read_record(rec[0])
                if back is None:
                    results.append({"id": rec[0], "ok": False, "error": "the radio didn't send it back"})
                elif not same_channel(back, rec):
                    results.append({"id": rec[0], "ok": False, "channel": decode_channel(back),
                                    "error": "the radio kept something other than what was sent"})
                else:
                    results.append({"id": rec[0], "ok": True, "channel": decode_channel(back)})
        if region is None or region == here:
            self.channels_region = here
            self.read_channels()
        region = here if region is None else region
        return {"region": region, "name": self._region_name(region), "results": results}

    # -- finding the channels ---------------------------------------------

    def find_control(self, last):
        for ch in range(1, last + 1):
            try:
                s = self.opener(self.mac, ch, 4)
            except OSError:
                continue
            self.ctrl, self.control_ch = s, ch
            if self.status():
                return
            self.ctrl, self.control_ch = None, None
            self.release(s)
            time.sleep(SETTLE)
        raise RuntimeError(
            "no channel answered a GAIA query; the radio's control service may "
            "be wedged - power-cycle its Bluetooth, and check no other host has "
            "it paired"
        )

    def find_audio(self, last):
        for ch in range(1, last + 1):
            if ch == self.control_ch:
                continue
            try:
                cand = self.opener(self.mac, ch, 4)
            except OSError:
                continue
            time.sleep(1.0)
            st = self.status()
            if st and st["aoc_connected"]:
                self.audio, self.audio_ch = cand, ch
                return
            self.release(cand)
            time.sleep(SETTLE)
        raise RuntimeError("no channel reported itself as the BS AOC audio channel")

    def open(self, last=10):
        """Connect both channels, or raise having released whatever opened."""
        try:
            if self.control_ch:
                self.ctrl = self.opener(self.mac, self.control_ch, 8)
                if not self.status():
                    raise RuntimeError(
                        f"channel {self.control_ch} did not answer GAIA; "
                        "remove it from the config to probe instead"
                    )
            else:
                self.find_control(last)

            if self.audio_ch:
                self.audio = self.opener(self.mac, self.audio_ch, 8)
            else:
                self.find_audio(last)
        except Exception:
            self.close()
            raise

        self.emit({"event": "status", "mac": self.mac, "state": "connected",
                   "detail": f"control ch{self.control_ch}, audio ch{self.audio_ch}"})
        try:
            self.read_channels()
        except OSError:
            pass   # names are a convenience; the radio still works without them
        for target in (self._read_audio, self._poll_status):
            t = threading.Thread(target=target, daemon=True)
            t.start()
            self.threads.append(t)

    def close(self):
        self.stop.set()
        for sock in (self.audio, self.ctrl):
            if sock:
                self.release(sock)
        self.audio = self.ctrl = None

    # -- the two loops -----------------------------------------------------

    def _poll_status(self):
        """Report squelch, RSSI, battery, and loss of the radio."""
        misses = 0
        battery = None
        last_battery = 0.0
        last_position = 0.0
        while not self.stop.is_set():
            st = self.status()
            # Polled far less often than status: a percentage does not move
            # fast, and every extra request competes with the audio channel.
            if st is not None and time.time() - last_battery > BATTERY_EVERY:
                last_battery = time.time()
                battery = self.battery()
            # Another region is another table of channels: the index the radio
            # reports would otherwise be looked up in the old one, and every
            # transmission after the switch filed under the wrong name
            if (st is not None and not self.editing.is_set() and self.channels_region is not None
                    and st["region"] != self.channels_region):
                self.channels_region = st["region"]
                try:
                    self.read_channels()
                except OSError:
                    pass
            # Where the radio is, from its own GPS, while it has a fix
            if st is not None and st["gps_locked"] and time.time() - last_position > POSITION_EVERY:
                last_position = time.time()
                pos = parse_position(self.request(gaia(GET_POSITION)))
                if pos and pos != self.position:
                    self.position = pos
                    self.emit({"event": "radio-position", "mac": self.mac, **pos})
            if st is None:
                misses += 1
                # One missed poll is normal while audio is flowing; several in
                # a row means the link is gone.
                if misses >= 3:
                    self.emit({"event": "status", "mac": self.mac,
                               "state": "disconnected", "detail": "radio stopped responding"})
                    self.stop.set()
                    return
            else:
                misses = 0
                self.channel = st["channel"]
                # Spread rather than listed field by field: the channel was
                # decoded here and then left out of the event, so it never
                # reached the server and every clip recorded no channel.
                # Reporting whatever was parsed makes that omission impossible.
                self.emit({"event": "radio-status", "mac": self.mac,
                           "battery": battery, **st})
            self.stop.wait(STATUS_PERIOD)

    def _read_audio(self):
        """Frame the audio channel, and decode one transmission at a time."""
        reader = FrameReader()
        run = bytearray()
        transmit = False
        open_run = False

        def finish():
            nonlocal run, open_run
            if open_run:
                self._emit_run(bytes(run), transmit)
                self.emit({"event": "audio-end", "mac": self.mac})
            run = bytearray()
            open_run = False

        sock = self.audio   # close() clears self.audio from another thread
        while sock is not None and not self.stop.is_set():
            try:
                data = sock.recv(8192)
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                break
            if not data:
                break
            for cmd, payload in reader.feed(data):
                if cmd in AUDIO_CMDS or cmd == TRANSMIT_CMD:
                    is_tx = cmd == TRANSMIT_CMD
                    if open_run and is_tx != transmit:
                        finish()          # the radio turned around mid-stream
                    if not open_run:
                        transmit = is_tx
                        open_run = True
                        self.emit({"event": "audio-start", "mac": self.mac,
                                   "transmit": transmit})
                    run += payload
                    if len(run) > MAX_RUN_BYTES:
                        finish()
                elif cmd == AUDIO_END:
                    finish()
        finish()

    def _emit_run(self, sbc_bytes, transmit):
        """Decode one transmission and hand it over as PCM."""
        if not sbc_bytes:
            return
        if not self.decoder:
            self.emit({"event": "sidecar-error", "mac": self.mac,
                       "error": "no SBC decoder available; install ffmpeg"})
            return
        try:
            pcm = sbc_codec.decode(sbc_bytes, self.decoder)
        except RuntimeError as e:
            self.emit({"event": "sidecar-error", "mac": self.mac, "error": str(e)})
            return

        # How much PCM this SBC should have produced. A shortfall means the
        # decoder dropped part of the run, which is invisible otherwise: the
        # clip simply arrives shorter than the transmission was, and sounds
        # like its tail.
        want = sbc_codec.expected_pcm_bytes(len(sbc_bytes))
        self.emit({
            "event": "run-stats", "mac": self.mac,
            "sbc_bytes": len(sbc_bytes),
            "frames": len(sbc_bytes) // sbc_codec.FRAME_BYTES,
            "pcm_bytes": len(pcm),
            "expected_pcm_bytes": want,
            "seconds": round(len(pcm) / 2 / sbc_codec.SAMPLE_RATE, 2),
        })
        if want and abs(len(pcm) - want) > want * 0.02:
            self.emit({
                "event": "sidecar-error", "mac": self.mac,
                "error": (f"SBC decode is short: {len(sbc_bytes)} bytes of SBC "
                          f"should give {want} bytes of PCM, got {len(pcm)} "
                          f"({len(pcm) / want:.0%})"),
            })
        import base64
        # Handed over in chunks so the segmenter sees the same shape of stream
        # it would from any other backend.
        step = sbc_codec.SAMPLE_RATE // 10 * 2      # 100 ms
        for i in range(0, len(pcm), step):
            self.emit({"event": "audio", "mac": self.mac, "rx": not transmit,
                       "transmit": transmit,
                       "pcm": base64.b64encode(pcm[i:i + step]).decode()})
