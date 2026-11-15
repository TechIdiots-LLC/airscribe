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
  bluez  Linux/BlueZ: the radio link through the kernel's RFCOMM sockets.
         See docs/bluetooth.md.
  bumble A USB dongle driven by Bumble instead of the OS, for an LXC
         container (where BlueZ can't work) or Windows. Same radio code as
         bluez above it. See sidecar/bumble_link.py.
"""

import argparse
import base64
import json
import signal
import math
import os
import random
import struct
import subprocess
import sys
import threading
import time

import sbc
from btinfo import is_radio, parse_devices
from bluez import LinkControls, RadioLink, channel_record, decode_channel, encode_channel

RATE = 32000  # radio audio: 32 kHz, 16-bit, mono
CHUNK_MS = 100

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        try:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, ValueError, OSError):
            # The server has gone: it exits first when the service stops. An
            # error here would cut short the teardown that's releasing the
            # radios, so drop this and anything after it.
            try:
                sys.stdout = open(os.devnull, "w")
            except OSError:
                pass


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

    def shutdown(self):
        for mac in list(self.active):
            self.disconnect(mac)

    # A pretend radio's controls, so the page can be tried with no radio. Its
    # channels are kept as the radio keeps them, 25-byte records, 30 slots to a
    # region as on a UV-Pro, so writing and backups go through the same code.
    SIM_REGIONS = ["Local", "Travel", "Region 3"]
    SIM_SLOTS = 30
    SIM_TABLES = [
        [{"id": 0, "name": "Holden PD", "rx_hz": 460387500, "tx_hz": 465387500, "scan": True,
          "bandwidth": "narrow", "rx_tone": "127.3", "tx_tone": "127.3"},
         {"id": 1, "name": "Rutld FD", "rx_hz": 154250000, "tx_hz": 154250000, "scan": True,
          "bandwidth": "narrow", "tx_disable": True},
         {"id": 2, "name": "W1BIM", "rx_hz": 146970000, "tx_hz": 146370000, "scan": False,
          "rx_tone": "", "tx_tone": "114.8"}],
        [{"id": 0, "name": "Boston FD", "rx_hz": 483162500, "tx_hz": 483162500, "scan": True,
          "bandwidth": "narrow", "tx_disable": True},
         {"id": 1, "name": "Mass SP", "rx_hz": 155475000, "tx_hz": 155475000, "scan": True,
          "bandwidth": "narrow", "tx_disable": True}],
        [],
    ]

    def _sim(self, mac):
        if mac not in self.active:
            raise RuntimeError(f"{mac} isn't connected")
        if not hasattr(self, "controls"):
            self.controls = {}
        if mac not in self.controls:
            tables = []
            for table in self.SIM_TABLES:
                slots = [encode_channel({"id": i}) for i in range(self.SIM_SLOTS)]
                for ch in table:
                    slots[ch["id"]] = encode_channel(ch)
                tables.append(slots)
            self.controls[mac] = {
                "settings": {"channel_a": 0, "channel_b": 1, "scan": False, "dual": 0, "squelch": 3},
                "volume": 7, "region": 0, "tables": tables,
                "position": {"lat": 42.3601, "lon": -71.8551, "alt_m": 190, "speed": 0, "heading": 0},
            }
        return self.controls[mac]

    def _table(self, s, region):
        """A region's programmed channels, as the radio's channel table has them."""
        return [{k: c[k] for k in ("id", "name", "rx_hz", "tx_hz", "scan")}
                for c in map(decode_channel, s["tables"][region]) if not c["empty"]]

    def radio_info(self, mac):
        s = self._sim(mac)
        return {"settings": dict(s["settings"]), "volume": s["volume"], "region": s["region"],
                "regions": list(self.SIM_REGIONS), "channels": self._table(s, s["region"]),
                "scanning": s["settings"]["scan"], "position": s["position"]}

    def _region(self, s, region):
        region = s["region"] if region is None else int(region)
        if not 0 <= region < len(self.SIM_REGIONS):
            raise ValueError(f"region is 0 to {len(self.SIM_REGIONS) - 1}")
        return region

    def read_region(self, mac, region=None):
        s = self._sim(mac)
        region = self._region(s, region)
        time.sleep(0.2)   # a real radio takes a few seconds; the page should show it's waiting
        return {"region": region, "name": self.SIM_REGIONS[region], "count": self.SIM_SLOTS,
                "channels": [decode_channel(r) for r in s["tables"][region]]}

    def write_region(self, mac, region, channels):
        s = self._sim(mac)
        region = self._region(s, region)
        records = [channel_record(ch) for ch in channels]
        if len({r[0] for r in records}) != len(records):
            raise ValueError("a slot is given twice")
        for rec in records:
            if rec[0] >= self.SIM_SLOTS:
                raise ValueError(f"the radio has {self.SIM_SLOTS} channels in a region; there's no channel {rec[0] + 1}")
        results = []
        for rec in records:
            s["tables"][region][rec[0]] = rec
            results.append({"id": rec[0], "ok": True, "channel": decode_channel(rec)})
        time.sleep(0.2)
        if region == s["region"]:
            emit({"event": "channels", "mac": mac, "region": region, "channels": self._table(s, region)})
        return {"region": region, "name": self.SIM_REGIONS[region], "results": results}

    def control(self, mac, action, value):
        s = self._sim(mac)
        limits = {"volume": 15, "squelch": 9}
        if action in limits:
            v = int(value)
            if not 0 <= v <= limits[action]:
                raise ValueError(f"{action} is 0 to {limits[action]}")
            if action == "volume":
                s["volume"] = v
            else:
                s["settings"]["squelch"] = v
        elif action == "scan":
            s["settings"]["scan"] = bool(value)
        elif action == "dual":
            s["settings"]["dual"] = 1 if value else 0
        elif action in ("channel_a", "channel_b"):
            v = int(value)
            if not any(c["id"] == v for c in self._table(s, s["region"])):
                raise ValueError(f"channel {v} isn't programmed in this region")
            s["settings"][action] = v
        elif action == "region":
            v = int(value)
            if not 0 <= v < len(self.SIM_REGIONS):
                raise ValueError(f"region is 0 to {len(self.SIM_REGIONS) - 1}")
            s["region"] = v
            s["settings"]["channel_a"] = s["settings"]["channel_b"] = 0
            emit({"event": "channels", "mac": mac, "region": v, "channels": self._table(s, v)})
        else:
            raise ValueError(f"unknown control {action}")
        return self.radio_info(mac)

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


class Unavailable:
    """A backend that could not start: every command says why."""

    def __init__(self, reason):
        self.reason = reason

    def scan(self):
        raise RuntimeError(self.reason)

    def connect(self, _mac):
        raise RuntimeError(self.reason)

    def disconnect(self, _mac):
        raise RuntimeError(self.reason)

    def radio_info(self, _mac):
        raise RuntimeError(self.reason)

    def control(self, _mac, _action, _value):
        raise RuntimeError(self.reason)

    def read_region(self, _mac, _region=None):
        raise RuntimeError(self.reason)

    def write_region(self, _mac, _region, _channels):
        raise RuntimeError(self.reason)

    def shutdown(self):
        pass


class BluezBackend(LinkControls):
    """Linux/BlueZ. Holds one RadioLink per connected radio."""

    def __init__(self, control_ch=None, audio_ch=None):
        self.links = {}
        self.control_ch = control_ch
        self.audio_ch = audio_ch
        self.decoder = sbc.find_decoder()
        if not self.decoder:
            emit({"event": "sidecar-error",
                  "error": "no SBC-capable ffmpeg found; audio cannot be decoded"})

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
        link = self.links.get(mac)
        if link and not link.stop.is_set():
            return
        if link:
            # The radio stopped answering and the link gave up. Without this
            # the server's retry would find it here, report success, and never
            # connect again.
            del self.links[mac]
            link.close()
        # BlueZ's Connect() hands each service to a profile driver and nothing
        # claims a vendor UUID, so it reports
        # br-connection-profile-unavailable even though the link came up.
        # Bringing the link up is all we need, so its failure is not fatal.
        try:
            _bluetoothctl("connect", mac)
        except (OSError, subprocess.SubprocessError):
            pass
        link = RadioLink(mac, emit, decoder=self.decoder,
                         control_ch=self.control_ch, audio_ch=self.audio_ch)
        link.open()
        self.links[mac] = link

    def disconnect(self, mac):
        link = self.links.pop(mac, None)
        if link:
            link.close()
            emit({"event": "status", "mac": mac, "state": "disconnected"})

    def shutdown(self):
        """Release every radio before exiting.

        Not optional: a socket the process merely abandons leaves the radio
        holding the session, and it will refuse that channel next time. A
        server restart would otherwise wedge every radio it had open.
        """
        for mac in list(self.links):
            self.disconnect(mac)


class Shutdown:
    """Releases the radios once, however many ways the end arrives.

    Stopping the service sends SIGTERM to every process in it, and the server
    then kills this one as well, so two signals arrive together. A second
    handler run inside the first would exit in the middle of the teardown:
    with Bumble, while libusb was still closing, which aborted the process
    (LXC 113) and can leave a radio's channels held. End of input is the third
    way in.
    """

    def __init__(self, backend):
        self.backend = backend
        self.started = False

    def __call__(self):
        """Shut the backend down. True the first time, False after."""
        if self.started:
            return False
        self.started = True
        self.backend.shutdown()
        return True


def _bumble_backend(args):
    # Imported here: Bumble is only installed where this backend is used
    from bumble_link import BumbleBackend
    return BumbleBackend(emit, transport=args.transport, keys=args.keys,
                         control_ch=args.control_channel, audio_ch=args.audio_channel)


BACKENDS = {"sim": SimBackend, "bluez": BluezBackend, "bumble": _bumble_backend}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=BACKENDS, default="bluez")
    # Probing for channels costs the radio sessions it frees slowly, so a
    # known-good pair can be given to skip it. See docs/bluetooth.md.
    ap.add_argument("--control-channel", type=int)
    ap.add_argument("--audio-channel", type=int)
    # bumble: which dongle (Bumble's transport name), and where its pairing keys live
    ap.add_argument("--transport", default="usb:0")
    ap.add_argument("--keys")
    args = ap.parse_args()
    if args.backend == "bluez":
        backend = BluezBackend(args.control_channel, args.audio_channel)
    elif args.backend == "bumble":
        try:
            backend = _bumble_backend(args)
        except RuntimeError as e:
            # Said once, then every request gets the same answer, rather than
            # exiting and being restarted in a loop by the server
            emit({"event": "sidecar-error", "error": str(e)})
            backend = Unavailable(str(e))
    else:
        backend = BACKENDS[args.backend]()

    # The parent kills this process on shutdown, so releasing the radios has
    # to happen on a signal as well as on end-of-input.
    shutdown = Shutdown(backend)

    def _on_signal(_signum, _frame):
        if shutdown():
            sys.exit(0)

    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(_sig, _on_signal)
        except (ValueError, AttributeError, OSError):
            pass

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
            # The radio's controls: what they read now, and changing one
            elif cmd == "radio":
                result = backend.radio_info(req["mac"])
            elif cmd == "control":
                result = backend.control(req["mac"], req["action"], req.get("value"))
            # Whole channels: every slot of a region read (for a backup), or
            # some written and each read back
            elif cmd == "channels":
                result = backend.read_region(req["mac"], req.get("region"))
            elif cmd == "write_channels":
                result = backend.write_region(req["mac"], req.get("region"), req["channels"])
            elif cmd == "ping":
                result = "pong"
            else:
                raise ValueError(f"unknown command {cmd}")
            emit({"id": req["id"], "ok": True, "result": result})
        except Exception as e:  # report to the caller; never kill the loop
            emit({"id": req.get("id") if isinstance(req, dict) else None, "ok": False, "error": str(e)})

    # stdin closed: the parent has gone away.
    shutdown()


if __name__ == "__main__":
    main()
