#!/usr/bin/env python3
"""Find a radio's RFCOMM channels and capture its BS AOC audio stream.

Works on Linux and Windows, because it needs nothing but stdlib sockets.

Channel numbers differ per radio and SDP is the documented way to resolve
them, but `sdptool browse` is unreliable against these radios and BlueZ's own
Connect() fails with br-connection-profile-unavailable, since no profile
driver claims a vendor service. So this probes instead, which needs no SDP:

  * the control channel answers a GAIA query and the others stay silent;
  * the audio channel identifies itself, because opening it flips
    `is_aoc_connected` in the radio's own HT status.

**The channels are opened once and held.** Closing the control channel and
reopening it does not work: the radio then refuses it, and after a few such
cycles refuses it permanently until its Bluetooth is power-cycled. So
discovery hands back live sockets rather than channel numbers, and the caller
keeps them for as long as it needs the radio. The backend has to do the same.

Read-only. It sends GET_HT_STATUS and nothing else, and never keys the
transmitter.

    python3 tools/probe-aoc.py <MAC>                 # find channels, then capture
    python3 tools/probe-aoc.py <MAC> --discover      # find channels only
"""
import argparse
import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
from htframe import FrameReader  # noqa: E402

GET_HT_STATUS = bytes([0xFF, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x14])
SETTLE = 0.6  # the radio needs a moment to free a channel after a session ends
CMD_NAMES = {0x00: "audio (odd)", 0x01: "AUDIO END", 0x02: "ack",
             0x03: "audio", 0x09: "transmit audio"}


def release(sock):
    """Hand a channel back to the radio.

    A bare close() is not enough for it to free the session, so the socket is
    shut down explicitly and given a moment to settle. Only for channels being
    rejected during probing — the ones that are kept are never released.
    """
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    sock.close()
    time.sleep(SETTLE)


def rfcomm(mac, channel, timeout=6):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    s.settimeout(timeout)
    try:
        s.connect((mac, channel))
    except OSError:
        s.close()
        raise
    return s


def ht_status(ctrl):
    """Return (is_aoc_connected, is_in_rx, is_sq, rssi), or None if no reply."""
    try:
        ctrl.sendall(GET_HT_STATUS)
    except OSError:
        return None
    ctrl.settimeout(3)
    buf = b""
    try:
        while len(buf) < 13:
            chunk = ctrl.recv(64)
            if not chunk:
                break
            buf += chunk
    except (TimeoutError, socket.timeout, OSError):
        pass
    if len(buf) < 13 or buf[0] != 0xFF:
        return None
    m = buf[4:4 + 4 + buf[3]]
    return bool(m[6] & 0x02), bool(m[5] & 0x10), bool(m[5] & 0x20), m[7] >> 4


def find_control(mac, last):
    """Open channels until one answers GAIA. Returns (channel, live socket)."""
    print(f"looking for the control channel on {mac} ...")
    for ch in range(1, last + 1):
        try:
            s = rfcomm(mac, ch, timeout=4)
        except OSError as e:
            print(f"  channel {ch:2d}: {e.strerror or e}")
            continue
        if ht_status(s):
            print(f"  channel {ch:2d}: answered GAIA  <== CONTROL (held open)")
            return ch, s
        print(f"  channel {ch:2d}: open, but silent")
        release(s)
    raise SystemExit(
        "\nNo channel answered a GAIA query.\n"
        "If channels opened but none answered, the radio's control service is\n"
        "wedged - power-cycle its Bluetooth. Also check no other host has it\n"
        "paired, since these radios serve one at a time."
    )


def find_audio(mac, ctrl, control_ch, last):
    """Open channels until is_aoc_connected flips. Returns (channel, socket)."""
    print("\nlooking for the audio channel (watching is_aoc_connected) ...")
    for ch in range(1, last + 1):
        if ch == control_ch:
            continue
        try:
            cand = rfcomm(mac, ch, timeout=4)
        except OSError as e:
            print(f"  channel {ch:2d}: {e.strerror or e}")
            continue
        time.sleep(1.0)
        st = ht_status(ctrl)
        if st and st[0]:
            print(f"  channel {ch:2d}: is_aoc_connected=True  <== BS AOC AUDIO (held open)")
            return ch, cand
        print(f"  channel {ch:2d}: is_aoc_connected={st[0] if st else '?'}")
        release(cand)
    return None, None


def capture(ctrl, audio, audio_ch, seconds, out):
    """Read the audio channel through the project's own frame codec."""
    audio.setblocking(False)
    print(f"\ncapturing {seconds}s from channel {audio_ch} ...")
    reader, raw, counts, polls, last = FrameReader(), bytearray(), {}, [], 0.0
    end = time.time() + seconds
    while time.time() < end:
        try:
            data = audio.recv(8192)
            if data:
                raw += data
                for cmd, _payload in reader.feed(data):
                    counts[cmd] = counts.get(cmd, 0) + 1
        except (BlockingIOError, OSError):
            time.sleep(0.02)
        if time.time() - last > 2.0:
            last = time.time()
            st = ht_status(ctrl)
            if st:
                polls.append(st[1:])
    with open(out, "wb") as fh:
        fh.write(raw)
    print(f"\n{len(raw)} bytes -> {out}")
    print("status polls (is_in_rx, is_sq, rssi):", polls)
    if counts:
        print("frames decoded by sidecar/htframe.py:")
        for cmd in sorted(counts):
            print(f"  cmd 0x{cmd:02X} {CMD_NAMES.get(cmd, '?'):<15} x{counts[cmd]}")
    else:
        print("no frames - the radio produced no audio during the window")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mac", help="radio MAC, e.g. 38:D2:00:01:56:51")
    ap.add_argument("--discover", action="store_true",
                    help="find the channels and stop, instead of capturing")
    ap.add_argument("--last", type=int, default=10, help="highest channel to probe")
    ap.add_argument("--capture", type=float, default=45.0, help="capture seconds")
    ap.add_argument("--out", default="aoc_capture.bin")
    args = ap.parse_args()

    control_ch, ctrl = find_control(args.mac, args.last)
    audio_ch, audio = None, None
    try:
        audio_ch, audio = find_audio(args.mac, ctrl, control_ch, args.last)
        print(f"\n  control channel : {control_ch}")
        print(f"  audio channel   : {audio_ch if audio_ch else 'not found'}")
        if audio and not args.discover:
            capture(ctrl, audio, audio_ch, args.capture, args.out)
    finally:
        # Released only on the way out, once the radio is genuinely finished
        # with. Anything earlier and the channel will not reopen.
        if audio:
            release(audio)
        release(ctrl)


if __name__ == "__main__":
    main()
