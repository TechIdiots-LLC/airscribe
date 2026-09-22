"""Framing used on the radio's audio RFCOMM channel.

Ported from the behaviour of HTCommander's RadioAudio.cs. A frame is

    0x7E  <command byte>  <payload, escaped>  0x7E

where 0x7D and 0x7E inside the payload become 0x7D followed by the byte XOR
0x20. Command bytes seen on receive: 0x00 / 0x03 audio, 0x01 audio end,
0x02 ack, 0x09 transmitted audio (the radio echoing what it is sending).
Payload of the audio commands is SBC, 32 kHz mono.
"""

FLAG = 0x7E
ESC = 0x7D


def escape(cmd: int, payload: bytes) -> bytes:
    out = bytearray([FLAG, cmd])
    for b in payload:
        if b in (FLAG, ESC):
            out += bytes([ESC, b ^ 0x20])
        else:
            out.append(b)
    out.append(FLAG)
    return bytes(out)


def unescape(data: bytes) -> bytes:
    out = bytearray()
    it = iter(data)
    for b in it:
        if b == ESC:
            nxt = next(it, None)
            if nxt is None:
                break
            out.append(nxt ^ 0x20)
        else:
            out.append(b)
    return bytes(out)


class FrameReader:
    """Accumulates stream bytes and yields (command, payload) frames.

    Tolerates garbage before a frame, and back-to-back flags (the closing 0x7E
    of one frame is also the opening one of the next).
    """

    def __init__(self, limit: int = 1 << 20):
        self.buf = bytearray()
        self.limit = limit

    def feed(self, data: bytes):
        self.buf += data
        if len(self.buf) > self.limit:  # never found a frame; do not grow forever
            self.buf.clear()
            return
        while True:
            start = self.buf.find(FLAG)
            if start < 0:
                self.buf.clear()
                return
            end = self.buf.find(FLAG, start + 1)
            if end < 0:
                del self.buf[:start]
                return
            body = bytes(self.buf[start + 1 : end])
            if not body:  # two flags in a row: the second starts the next frame
                del self.buf[:end]
                continue
            del self.buf[:end]  # keep the closing flag: it may open the next frame
            raw = unescape(body)
            if raw:
                yield raw[0], raw[1:]
