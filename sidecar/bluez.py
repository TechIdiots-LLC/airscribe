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

import socket
import threading
import time

from htframe import FrameReader
import sbc as sbc_codec

# GAIA: FF 01 <flags> <payload len> <group hi/lo> <command hi/lo> <payload>
GET_HT_STATUS = bytes([0xFF, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x14])

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
    }


class RadioLink:
    """One connected radio: two held sockets and the threads reading them."""

    def __init__(self, mac, emit, decoder=None, control_ch=None, audio_ch=None):
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

    # -- control channel ---------------------------------------------------

    def status(self):
        """Ask the radio its state. None when it does not answer."""
        with self.lock:
            try:
                self.ctrl.settimeout(3)
                self.ctrl.sendall(GET_HT_STATUS)
                buf = b""
                while len(buf) < 13:
                    chunk = self.ctrl.recv(64)
                    if not chunk:
                        break
                    buf += chunk
            except OSError:
                return None
        return parse_ht_status(buf)

    # -- finding the channels ---------------------------------------------

    def find_control(self, last):
        for ch in range(1, last + 1):
            try:
                s = _rfcomm(self.mac, ch, timeout=4)
            except OSError:
                continue
            self.ctrl, self.control_ch = s, ch
            if self.status():
                return
            self.ctrl, self.control_ch = None, None
            _release(s)
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
                cand = _rfcomm(self.mac, ch, timeout=4)
            except OSError:
                continue
            time.sleep(1.0)
            st = self.status()
            if st and st["aoc_connected"]:
                self.audio, self.audio_ch = cand, ch
                return
            _release(cand)
            time.sleep(SETTLE)
        raise RuntimeError("no channel reported itself as the BS AOC audio channel")

    def open(self, last=10):
        """Connect both channels, or raise having released whatever opened."""
        try:
            if self.control_ch:
                self.ctrl = _rfcomm(self.mac, self.control_ch)
                if not self.status():
                    raise RuntimeError(
                        f"channel {self.control_ch} did not answer GAIA; "
                        "remove it from the config to probe instead"
                    )
            else:
                self.find_control(last)

            if self.audio_ch:
                self.audio = _rfcomm(self.mac, self.audio_ch)
            else:
                self.find_audio(last)
        except Exception:
            self.close()
            raise

        self.emit({"event": "status", "mac": self.mac, "state": "connected",
                   "detail": f"control ch{self.control_ch}, audio ch{self.audio_ch}"})
        for target in (self._read_audio, self._poll_status):
            t = threading.Thread(target=target, daemon=True)
            t.start()
            self.threads.append(t)

    def close(self):
        self.stop.set()
        for sock in (self.audio, self.ctrl):
            if sock:
                _release(sock)
        self.audio = self.ctrl = None

    # -- the two loops -----------------------------------------------------

    def _poll_status(self):
        """Report squelch, RSSI and loss of the radio."""
        misses = 0
        while not self.stop.is_set():
            st = self.status()
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
                self.emit({"event": "radio-status", "mac": self.mac, "rssi": st["rssi"],
                           "in_rx": st["in_rx"], "squelch": st["squelch"],
                           "in_tx": st["in_tx"], "scanning": st["scanning"]})
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

        while not self.stop.is_set():
            try:
                data = self.audio.recv(8192)
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
