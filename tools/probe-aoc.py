#!/usr/bin/env python3
"""Find a radio's RFCOMM channels and capture its BS AOC audio stream.

Written for Windows, where a paired radio's channels can be reached with
Python's AF_BLUETOOTH sockets but there is no SDP lookup to name them. On
Linux the sidecar resolves channels through SDP instead, so this is a
diagnostic rather than something the project depends on.

Two things it establishes, both confirmed against a UV-Pro:

  * The Bluetooth link must already be up before a raw RFCOMM connect will
    succeed; from cold it fails with "destination host was down" or times out.
    Opening the radio's SPP COM port first is enough to bring it up. This is
    why the Linux backend must call BlueZ's Connect() before opening sockets.

  * The audio channel identifies itself: the radio reports `is_aoc_connected`
    in its HT status, so opening each candidate channel and re-reading the
    status shows which one flips the bit.

Everything here is read-only. It sends GET_HT_STATUS and nothing else, and
never keys the transmitter.

    python tools/probe-aoc.py <MAC> --control 4 --scan 1,2,3
    python tools/probe-aoc.py <MAC> --control 4 --audio 2 --capture 30
"""
import argparse
import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
from htframe import FrameReader  # noqa: E402

GET_HT_STATUS = bytes([0xFF, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x14])
CMD_NAMES = {0x00: "audio (odd)", 0x01: "AUDIO END", 0x02: "ack",
             0x03: "audio", 0x09: "transmit audio"}


def rfcomm(mac, channel, timeout=8):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    s.settimeout(timeout)
    s.connect((mac, channel))
    return s


def ht_status(ctrl):
    """Return (is_aoc_connected, is_in_rx, is_sq, rssi) or None."""
    ctrl.sendall(GET_HT_STATUS)
    ctrl.settimeout(3)
    buf = b""
    try:
        while len(buf) < 13:
            chunk = ctrl.recv(64)
            if not chunk:
                break
            buf += chunk
    except (TimeoutError, socket.timeout):
        pass
    if len(buf) < 13 or buf[0] != 0xFF:
        return None
    m = buf[4:4 + 4 + buf[3]]
    return bool(m[6] & 0x02), bool(m[5] & 0x10), bool(m[5] & 0x20), m[7] >> 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mac", help="radio MAC, e.g. 38:D2:00:01:56:51")
    ap.add_argument("--control", type=int, default=4, help="SPP/control RFCOMM channel")
    ap.add_argument("--scan", help="comma-separated channels to test for BS AOC")
    ap.add_argument("--audio", type=int, help="known BS AOC channel, to capture from")
    ap.add_argument("--capture", type=float, default=20.0, help="capture seconds")
    ap.add_argument("--out", default="aoc_capture.bin")
    args = ap.parse_args()

    try:
        ctrl = rfcomm(args.mac, args.control)
    except OSError as e:
        raise SystemExit(
            f"control channel {args.control} failed: {e}\n"
            "The link is probably cold - open the radio's SPP COM port once, then retry."
        )
    print(f"control channel {args.control}: connected")
    print(f"baseline status: {ht_status(ctrl)}")

    if args.scan:
        for ch in [int(c) for c in args.scan.split(",")]:
            try:
                cand = rfcomm(args.mac, ch, timeout=6)
            except OSError as e:
                print(f"channel {ch}: {e}")
                continue
            time.sleep(1.0)
            st = ht_status(ctrl)
            aoc = st[0] if st else None
            print(f"channel {ch}: open -> is_aoc_connected={aoc}"
                  f"{'   <== BS AOC audio channel' if aoc else ''}")
            cand.close()
            time.sleep(1.0)

    if args.audio:
        audio = rfcomm(args.mac, args.audio)
        audio.setblocking(False)
        print(f"capturing {args.capture}s from channel {args.audio} ...")
        reader, raw, counts = FrameReader(), bytearray(), {}
        polls, last = [], 0.0
        end = time.time() + args.capture
        while time.time() < end:
            try:
                data = audio.recv(8192)
                if data:
                    raw += data
                    for cmd, _payload in reader.feed(data):
                        counts[cmd] = counts.get(cmd, 0) + 1
            except BlockingIOError:
                time.sleep(0.02)
            except OSError:
                time.sleep(0.02)
            if time.time() - last > 2.0:
                last = time.time()
                st = ht_status(ctrl)
                if st:
                    polls.append(st[1:])
        audio.close()
        with open(args.out, "wb") as fh:
            fh.write(raw)
        print(f"\n{len(raw)} bytes -> {args.out}")
        print("status polls (is_in_rx, is_sq, rssi):", polls)
        if counts:
            print("frames decoded by sidecar/htframe.py:")
            for cmd in sorted(counts):
                print(f"  cmd 0x{cmd:02X} {CMD_NAMES.get(cmd, '?'):<15} x{counts[cmd]}")
        else:
            print("no frames - the radio produced no audio during the window")
    ctrl.close()


if __name__ == "__main__":
    main()
