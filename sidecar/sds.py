"""A Uniden SDS150 over Bluetooth Low Energy: its framing, and one transmission at a time.

Worked out from the user's own capture of Uniden's U/AWARE app (docs/scanners.md). The scanner offers one
characteristic that takes writes without response and sends notifications, and both directions carry frames:

  09 50 54 | length (2, big-endian) | payload | sum of the payload's bytes (2, big-endian)

The app's payload is its sequence number (2), the last sequence number it heard from the scanner (2), then one
field: a type (1), a length (2) and the bytes. The scanner's payload is its sequence number and a field, with no
acknowledgement. The app sends one thing, `GST` (the remote command spec's Get Status, as over USB) as field
type C0 with 0x81 before it, every 200 ms; that alone keeps the audio coming. The scanner sends:

  A0  "System,Channel" as a transmission starts
  A1  audio: a counter byte, then one Opus packet (wideband CELT, 20 ms, mono)
  A2  "System,Department,Channel, frequency,talkgroup,..." just after it ends
  C0  replies (0x81 then the command's answer) and its own status lines (0x82)
  AF  a one-byte tick, unexplained

The scanner's squelch decides what's a transmission: audio comes only while it's open. A transmission is the
audio up to a pause, decoded with ffmpeg when it ends, as a radio's SBC is (sbc.py).
"""

import base64
import shutil
import subprocess
import threading
import time

MAGIC = b"\x09\x50\x54"
POLL_SECONDS = 0.2          # as often as the app asks
GAP_SECONDS = 0.6           # audio stops this long: the transmission is over (A2 comes ~0.2 s after)
SILENT_SECONDS = 6          # nothing at all from the scanner this long: it has gone
MAX_RUN_PACKETS = 5 * 60 * 50  # five minutes: a squelch stuck open mustn't grow forever
RATE = 32000                # what the rest of AirScribe takes (airscribe_sidecar.RATE)

T_START = 0xA0
T_AUDIO = 0xA1
T_END = 0xA2
T_TEXT = 0xC0


def checksum(payload):
    return sum(payload) & 0xFFFF


def frame(seq, ack, kind, data):
    """One frame from us to the scanner."""
    payload = (seq & 0xFFFF).to_bytes(2, "big") + (ack & 0xFFFF).to_bytes(2, "big") + bytes([kind]) \
        + len(data).to_bytes(2, "big") + data
    return MAGIC + len(payload).to_bytes(2, "big") + payload + checksum(payload).to_bytes(2, "big")


def gst(seq, ack=0xFFFF):
    """Get Status, as the app asks for it."""
    return frame(seq, ack, T_TEXT, b"\x81GST\r")


class FrameReader:
    """The scanner's frames out of its notifications, however they're cut."""

    def __init__(self):
        self.buf = bytearray()
        self.bad = 0

    def feed(self, data):
        """:returns: [(seq, kind, data)] for each whole frame so far."""
        self.buf += data
        out = []
        while True:
            i = self.buf.find(MAGIC)
            if i < 0:
                del self.buf[:max(0, len(self.buf) - 2)]
                return out
            del self.buf[:i]
            if len(self.buf) < 5:
                return out
            n = int.from_bytes(self.buf[3:5], "big")
            if len(self.buf) < 7 + n:
                return out
            payload = bytes(self.buf[5:5 + n])
            ok = n >= 5 and checksum(payload) == int.from_bytes(self.buf[5 + n:7 + n], "big")
            if not ok:
                self.bad += 1
                del self.buf[:1]    # look for the next start
                continue
            del self.buf[:7 + n]
            size = int.from_bytes(payload[3:5], "big")
            out.append((int.from_bytes(payload[:2], "big"), payload[2], payload[5:5 + size]))


def _text(data):
    return data.decode("utf-8", "replace").strip().rstrip("\r").strip()


def parse_start(data):
    """A0: "System,Channel"."""
    parts = [p.strip() for p in _text(data).split(",")]
    return {"system": parts[0] or None, "channel": parts[-1] or None} if len(parts) >= 2 else {}


def parse_end(data):
    """A2: "System,Department,Channel, frequency,talkgroup,..."; frequency as the scanner writes it."""
    parts = [p.strip() for p in _text(data).split(",")]
    if len(parts) < 4:
        return {}
    keys = ("system", "department", "channel", "frequency", "talkgroup")
    return {k: v for k, v in zip(keys, parts) if v}


# -- Opus, through ffmpeg -------------------------------------------------------

_CRC = []
for _i in range(256):
    _r = _i << 24
    for _ in range(8):
        _r = ((_r << 1) ^ 0x04C11DB7) if _r & 0x80000000 else _r << 1
    _CRC.append(_r & 0xFFFFFFFF)


def _crc(b):
    c = 0
    for x in b:
        c = ((c << 8) & 0xFFFFFFFF) ^ _CRC[((c >> 24) ^ x) & 0xFF]
    return c


def ogg_opus(packets, samples_per_packet=960):
    """Opus packets as an Ogg Opus stream, which is how ffmpeg will take them."""
    pages = []

    def page(data, granule, flags):
        segs = [255] * (len(data) // 255) + [len(data) % 255]
        h = bytearray(b"OggS\x00" + bytes([flags]) + granule.to_bytes(8, "little")
                      + (0x5344).to_bytes(4, "little") + len(pages).to_bytes(4, "little") + bytes(4)
                      + bytes([len(segs)]) + bytes(segs))
        p = h + data
        p[22:26] = _crc(p).to_bytes(4, "little")
        pages.append(bytes(p))

    head = b"OpusHead\x01\x01" + (0).to_bytes(2, "little") + (48000).to_bytes(4, "little") + bytes(3)
    page(head, 0, 2)
    page(b"OpusTags" + (9).to_bytes(4, "little") + b"AirScribe" + bytes(4), 0, 0)
    granule = 0
    for i, pkt in enumerate(packets):
        granule += samples_per_packet
        page(bytes(pkt), granule, 4 if i == len(packets) - 1 else 0)
    return b"".join(pages)


def find_decoder():
    """ffmpeg with an Opus decoder (its own is built in), or None."""
    exe = shutil.which("ffmpeg")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "-hide_banner", "-decoders"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    names = {line.split()[1] for line in out.splitlines() if len(line.split()) > 1}
    return exe if names & {"opus", "libopus"} else None


def decode(packets, exe="ffmpeg", rate=RATE):
    """Opus packets to 16-bit mono PCM at `rate`."""
    if not packets:
        return b""
    cmd = [exe, "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0",
           "-f", "s16le", "-acodec", "pcm_s16le", "-ar", str(rate), "-ac", "1", "pipe:1"]
    try:
        p = subprocess.run(cmd, input=ogg_opus(packets), capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"ffmpeg could not be run: {e}") from e
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg exited {p.returncode}: {p.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    return p.stdout



# -- one scanner -------------------------------------------------------------------

class Run:
    """One transmission coming in."""

    def __init__(self, start_info, now):
        self.packets = []
        self.start_info = dict(start_info)
        self.end_info = {}
        self.last = now
        self.announced = False


class ScannerLink:
    """One SDS150's session, whatever carries it: notifications in, writes out.

    `on_notify` (the transport's thread) only records what came. Everything else happens on this link's own
    thread, every POLL_SECONDS: asking for GST through `send(bytes)`, saying a transmission has started,
    decoding one that has ended, and noticing a scanner gone quiet, when `on_gone()` is called once so the
    transport can drop the link. One thread sending the events keeps them in order.
    """

    def __init__(self, mac, emit, send, decoder=None, on_gone=None, clock=time.monotonic):
        self.mac = mac
        self.emit = emit
        self.send = send
        self.decoder = decoder
        self.on_gone = on_gone
        self.clock = clock
        self.reader = FrameReader()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.seq = 0
        self.ack = 0xFFFF
        self.heard = clock()
        self.start_info = {}     # the last A0, and when
        self.start_at = None
        self.current = None
        self.thread = None

    def open(self, detail=None):
        self.heard = self.clock()
        self.emit({"event": "status", "mac": self.mac, "state": "connected", "detail": detail})
        self.thread = threading.Thread(target=self._loop, name=f"sds {self.mac}", daemon=True)
        self.thread.start()

    def on_notify(self, data):
        with self.lock:
            now = self.heard = self.clock()
            for seq, kind, body in self.reader.feed(bytes(data)):
                self.ack = seq
                if kind == T_AUDIO and len(body) > 1:
                    if self.current is None:
                        # Its A0 comes with the first audio, a moment either side
                        fresh = self.start_at is not None and now - self.start_at < 2
                        self.current = Run(self.start_info if fresh else {}, now)
                    self.current.last = now
                    self.current.packets.append(bytes(body[1:]))
                elif kind == T_START:
                    self.start_info, self.start_at = parse_start(body), now
                    if self.current is not None and not self.current.start_info:
                        self.current.start_info = dict(self.start_info)
                elif kind == T_END and self.current is not None:
                    self.current.end_info = parse_end(body)

    def tick(self):
        """One poll. :returns: False once the scanner has gone, or can't be written to."""
        with self.lock:
            now = self.clock()
            run = self.current
            announce = run is not None and not run.announced
            if announce:
                run.announced = True
            done = run is not None and (now - run.last >= GAP_SECONDS or len(run.packets) >= MAX_RUN_PACKETS)
            if done:
                self.current = None
            gone = now - self.heard > SILENT_SECONDS
            msg = gst(self.seq, self.ack)
            self.seq = (self.seq + 1) & 0xFFFF
        if announce:
            self._announce(run)
        if done:
            self._finish(run)
        if gone:
            self.emit({"event": "sidecar-error", "mac": self.mac,
                       "error": f"the scanner hasn't answered for {SILENT_SECONDS} s; reconnecting"})
            return False
        try:
            self.send(msg)
        except Exception as e:
            self.emit({"event": "sidecar-error", "mac": self.mac, "error": f"couldn't write to the scanner: {e}"})
            return False
        return True

    def _announce(self, run):
        self.emit({"event": "audio-start", "mac": self.mac, "transmit": False})
        if run.start_info:
            self.emit({"event": "scanner-channel", "mac": self.mac, **run.start_info})

    def _finish(self, run):
        """A transmission that has ended: labelled, decoded and handed over."""
        info = {**run.start_info, **run.end_info}
        if info:
            self.emit({"event": "scanner-channel", "mac": self.mac, **info})
        if run.packets and not self.decoder:
            self.emit({"event": "sidecar-error", "mac": self.mac,
                       "error": "no Opus-capable ffmpeg found; the scanner's audio cannot be decoded"})
        elif run.packets:
            try:
                pcm = decode(run.packets, self.decoder)
            except RuntimeError as e:
                self.emit({"event": "sidecar-error", "mac": self.mac, "error": str(e)})
                pcm = b""
            self.emit({"event": "run-stats", "mac": self.mac, "codec": "opus", "frames": len(run.packets),
                       "pcm_bytes": len(pcm), "expected_pcm_bytes": len(run.packets) * RATE // 50 * 2,
                       "seconds": round(len(pcm) / 2 / RATE, 2)})
            step = RATE // 10 * 2      # 100 ms, as the radios' audio comes
            for i in range(0, len(pcm), step):
                self.emit({"event": "audio", "mac": self.mac, "rx": True, "transmit": False,
                           "pcm": base64.b64encode(pcm[i:i + step]).decode()})
        self.emit({"event": "audio-end", "mac": self.mac})

    def _loop(self):
        while not self.stop.wait(POLL_SECONDS):
            if not self.tick():
                break
        if not self.stop.is_set() and self.on_gone:
            self.on_gone()

    def close(self):
        """Stop polling, hand over what was coming in, and say it's disconnected (once)."""
        if self.stop.is_set():
            return
        self.stop.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(5)
        with self.lock:
            run, self.current = self.current, None
        if run is not None:
            if not run.announced:
                self._announce(run)
            self._finish(run)
        self.emit({"event": "status", "mac": self.mac, "state": "disconnected"})
