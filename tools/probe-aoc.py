#!/usr/bin/env python3
"""Find a radio's RFCOMM channels and capture its BS AOC audio stream.

Works on Linux and Windows, because it needs nothing but stdlib sockets.

Channel numbers differ per radio and SDP is the documented way to resolve
them, but `sdptool browse` is unreliable against these radios and BlueZ's own
Connect() fails outright with br-connection-profile-unavailable, since there
is no profile driver for a vendor service. So this probes instead, which turns
out to need no SDP at all:

  * the control channel answers a GAIA query and the others stay silent;
  * the audio channel identifies itself, because opening it flips
    `is_aoc_connected` in the radio's own HT status.

Read-only. It sends GET_HT_STATUS and nothing else, and never keys the
transmitter.

    python3 tools/probe-aoc.py <MAC> --discover
    python3 tools/probe-aoc.py <MAC> --control 4 --audio 2 --capture 30
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


def rfcomm(mac, channel, timeout=6, tries=1):
    """Open one RFCOMM channel.

    Retries because these radios refuse a channel that worked moments earlier,
    typically right after another session on it closed.
    """
    last = None
    for attempt in range(tries):
        s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        s.settimeout(timeout)
        try:
            s.connect((mac, channel))
            return s
        except OSError as e:
            s.close()
            last = e
            if attempt + 1 < tries:
                time.sleep(1.5)
    raise last


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


def discover(mac, last):
    """Work out which channel is control and which is BS AOC audio."""
    print(f"probing channels 1-{last} on {mac} ...")
    open_channels = []
    for ch in range(1, last + 1):
        try:
            s = rfcomm(mac, ch, timeout=4)
        except OSError as e:
            print(f"  channel {ch:2d}: {e.strerror or e}")
            continue
        open_channels.append(ch)
        print(f"  channel {ch:2d}: open")
        s.close()
        time.sleep(0.2)
    if not open_channels:
        raise SystemExit("\nNo channel accepted a connection. Is the radio on and in range?")

    print(f"\nopen channels: {open_channels}\nlooking for the control channel ...")
    control, ctrl_sock = None, None
    for ch in open_channels:
        try:
            s = rfcomm(mac, ch)
        except OSError:
            continue
        if ht_status(s):
            control, ctrl_sock = ch, s
            print(f"  channel {ch}: answered GAIA  <== CONTROL")
            break
        s.close()
        time.sleep(0.3)
    if control is None:
        raise SystemExit("No channel answered a GAIA query; cannot identify the rest.")

    print("\nlooking for the audio channel (watching is_aoc_connected) ...")
    audio = None
    for ch in open_channels:
        if ch == control:
            continue
        try:
            cand = rfcomm(mac, ch)
        except OSError as e:
            print(f"  channel {ch}: {e.strerror or e}")
            continue
        time.sleep(1.0)
        st = ht_status(ctrl_sock)
        if st and st[0]:
            audio = ch
            print(f"  channel {ch}: is_aoc_connected=True  <== BS AOC AUDIO")
            cand.close()
            break
        print(f"  channel {ch}: is_aoc_connected={st[0] if st else '?'}")
        cand.close()
        time.sleep(1.0)
    ctrl_sock.close()

    print(f"\n  control channel : {control}")
    print(f"  audio channel   : {audio if audio else 'not found'}")
    return control, audio


def capture(mac, control, audio_ch, seconds, out):
    # A channel that worked a minute ago can refuse now, so fall back to
    # probing again rather than failing. This is why the backend must
    # rediscover channels per connection instead of caching them.
    try:
        ctrl = rfcomm(mac, control, tries=3)
        audio = rfcomm(mac, audio_ch, tries=3)
    except OSError as e:
        print(f"channel {control}/{audio_ch} refused ({e.strerror or e}); re-probing ...")
        control, audio_ch = discover(mac, 10)
        if not (control and audio_ch):
            raise SystemExit("could not find both channels")
        print()
        ctrl = rfcomm(mac, control, tries=3)
        audio = rfcomm(mac, audio_ch, tries=3)
    audio.setblocking(False)
    print(f"control ch{control} + audio ch{audio_ch} connected; capturing {seconds}s")
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
    audio.close()
    ctrl.close()
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
    ap.add_argument("--discover", action="store_true", help="find the control and audio channels")
    ap.add_argument("--last", type=int, default=30, help="highest channel to probe")
    ap.add_argument("--control", type=int, help="known control channel")
    ap.add_argument("--audio", type=int, help="known BS AOC channel, to capture from")
    ap.add_argument("--capture", type=float, default=30.0, help="capture seconds")
    ap.add_argument("--out", default="aoc_capture.bin")
    args = ap.parse_args()

    if args.discover or not (args.control and args.audio):
        control, audio = discover(args.mac, args.last)
        if control and audio and not args.discover:
            print()
            capture(args.mac, control, audio, args.capture, args.out)
        elif control and audio:
            print()
            print("Capture with:")
            print(f"  python3 tools/probe-aoc.py {args.mac} "
                  f"--control {control} --audio {audio} --capture 45")
    else:
        capture(args.mac, args.control, args.audio, args.capture, args.out)


if __name__ == "__main__":
    main()
