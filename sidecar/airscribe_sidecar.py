#!/usr/bin/env python3
"""Bluetooth helper for airscribe.

Speaks JSON lines on stdio (see src/sidecar.js). Requests: {"id", "cmd", ...}.
Replies: {"id", "ok", "result" | "error"}. Pushed events: {"event", ...}.

Audio events mirror the radio's own framing: an `audio-start` opens a run,
`audio` chunks carry PCM, and `audio-end` closes it. See docs/bluetooth.md.

Backends:
  sim    A fake radio that "hears" a burst of tone every few seconds, with the
         run markers a real radio sends. Lets the whole pipeline run with no
         Bluetooth hardware.
  bluez  Linux/BlueZ. Device listing works; the RFCOMM audio link is NOT yet
         implemented and connect() says so. See docs/bluetooth.md.
"""

import argparse
import base64
import json
import math
import random
import struct
import subprocess
import sys
import threading
import time

from btinfo import is_radio, parse_devices

RATE = 32000  # radio audio: 32 kHz, 16-bit, mono
CHUNK_MS = 100

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def _bluetoothctl(*args):
    return subprocess.run(
        ["bluetoothctl", *args], capture_output=True, text=True, timeout=10, check=True
    ).stdout


class SimBackend:
    def __init__(self):
        self.active = {}

    def scan(self):
        return [
            {"mac": "00:11:22:33:44:55", "name": "UV-PRO (simulated)", "radio": True},
            {"mac": "00:11:22:33:44:66", "name": "VR-N7600 (simulated)", "radio": True},
        ]

    def connect(self, mac):
        if mac in self.active:
            return
        stop = threading.Event()
        self.active[mac] = stop
        threading.Thread(target=self._run, args=(mac, stop), daemon=True).start()

    def disconnect(self, mac):
        stop = self.active.pop(mac, None)
        if stop:
            stop.set()

    def _run(self, mac, stop):
        emit({"event": "status", "mac": mac, "state": "connected", "rssi": 9})
        n = CHUNK_MS * RATE // 1000
        phase = 0.0
        while not stop.is_set():
            # Quiet, then a "transmission" of 2-4 s, bracketed by the same run
            # markers a real radio sends, so the segmenter is exercised the way
            # it will be used. A tone with syllable-like amplitude wobble gives
            # the energy fallback something to see as well.
            for talking, secs in ((False, random.uniform(2, 4)), (True, random.uniform(2, 4))):
                if talking:
                    emit({"event": "audio-start", "mac": mac, "transmit": False})
                for i in range(int(secs * 1000 / CHUNK_MS)):
                    if stop.is_set():
                        break
                    samples = []
                    for k in range(n):
                        if talking:
                            env = 0.35 + 0.25 * math.sin(2 * math.pi * 3.5 * (i * n + k) / RATE)
                            s = env * math.sin(phase)
                            phase += 2 * math.pi * 600 / RATE
                        else:
                            s = random.uniform(-0.002, 0.002)
                        samples.append(int(s * 32767))
                    pcm = struct.pack(f"<{n}h", *samples)
                    emit({
                        "event": "audio",
                        "mac": mac,
                        "rx": talking,
                        "transmit": False,
                        "pcm": base64.b64encode(pcm).decode(),
                    })
                    time.sleep(CHUNK_MS / 1000)
                if talking:
                    emit({"event": "audio-end", "mac": mac})
        emit({"event": "status", "mac": mac, "state": "disconnected"})


class BluezBackend:
    def scan(self):
        # BlueZ's known devices (pair the radio once first). Each is checked
        # for the radio service UUID, so headphones and phones are flagged
        # `radio: false` rather than guessed from their names.
        try:
            devices = parse_devices(_bluetoothctl("devices"))
            for d in devices:
                d["radio"] = is_radio(_bluetoothctl("info", d["mac"]))
        except (OSError, subprocess.SubprocessError) as e:
            raise RuntimeError(f"bluetoothctl unavailable: {e}")
        return sorted(devices, key=lambda d: not d["radio"])

    def connect(self, mac):
        raise RuntimeError(
            "bluez RFCOMM audio link not implemented yet (needs testing against a real radio)"
        )

    def disconnect(self, mac):
        pass


BACKENDS = {"sim": SimBackend, "bluez": BluezBackend}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=BACKENDS, default="bluez")
    backend = BACKENDS[ap.parse_args().backend]()

    for line in sys.stdin:
        try:
            req = json.loads(line)
            cmd = req["cmd"]
            if cmd == "scan":
                result = backend.scan()
            elif cmd == "connect":
                result = backend.connect(req["mac"])
            elif cmd == "disconnect":
                result = backend.disconnect(req["mac"])
            elif cmd == "ping":
                result = "pong"
            else:
                raise ValueError(f"unknown command {cmd}")
            emit({"id": req["id"], "ok": True, "result": result})
        except Exception as e:  # report to the caller; never kill the loop
            emit({"id": req.get("id") if isinstance(req, dict) else None, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
