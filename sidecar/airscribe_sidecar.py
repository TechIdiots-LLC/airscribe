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
from bluez import (LinkControls, RadioLink, bss_payload, channel_record, decode_channel, encode_channel,
                   parse_bss)

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


def ax25_frame(source, destination, path, info):
    """An AX.25 UI frame as a radio's modem hands one over: the addresses
    (destination, source, then the path; "*" marks one that repeated it), UI
    control and no-layer-3 PID, then the information field. No flags or check."""
    calls = [destination, source] + list(path)

    def address(call, last):
        base, _, ssid = call.rstrip("*").partition("-")
        a = bytearray(c << 1 for c in base.upper().ljust(6).encode("ascii")[:6])
        a.append(0x60 | ((int(ssid or 0) & 0x0F) << 1) | (0x80 if call.endswith("*") else 0) | (1 if last else 0))
        return bytes(a)

    return (b"".join(address(c, i == len(calls) - 1) for i, c in enumerate(calls))
            + bytes([0x03, 0xF0]) + info.encode("latin-1"))


def bss_packet(source, message, lat, lon):
    """The radios' own BSS packet: 0x01, then length/tag/value fields: from
    (0x20), message (0x24), and location (0x25) as the radio gives its own GPS,
    24-bit signed minutes x 500 for latitude then longitude."""
    def field(tag, value):
        return bytes([len(value) + 1, tag]) + value

    def coord(deg):
        return (round(deg * 60 * 500) & 0xFFFFFF).to_bytes(3, "big")

    return (b"\x01" + field(0x20, source.encode()) + field(0x24, message.encode())
            + field(0x25, coord(lat) + coord(lon)))


class SimBackend:
    # What the pretend radio's modem decodes now and then, around Holden, MA
    SIM_PACKETS = [
        ax25_frame("N1HLD-9", "APRS", ["WIDE1-1"], "!4221.06N/07151.78W>090/035/A=000620 Mobile in Holden"),
        ax25_frame("W1BIM", "APRS", ["N1RUT*", "WIDE2-1"], "=4222.15N/07157.28W#PHG5360 W1BIM digi, Rutland"),
        ax25_frame("KC1WX-13", "APRS", ["WIDE1-1"],
                   "@151200z4220.50N/07150.10W_180/004g009t045r000p012P008h82b10132 Holden WX"),
        ax25_frame("N1MCE-9", "TQ4W2V", ["WIDE2-1"], "`c51!f?>/]\"3x}="),
        ax25_frame("N1HLD-9", "APRS", ["WIDE1-1"], ":W1BIM    :Net tonight at 8pm{12"),
        ax25_frame("W1BIM", "APRS", [], ";CRANE    *151200z4221.30N/07152.40WcRoad work on Main St"),
        bss_packet("N1BSS", "On my way", 42.3551, -71.8702),
    ]

    def __init__(self):
        self.active = {}
        self.sent = 0

    def scan(self):
        return [
            {"mac": "00:11:22:33:44:55", "name": "UV-PRO (simulated)", "radio": True},
            {"mac": "00:11:22:33:44:66", "name": "VR-N7600 (simulated)", "radio": True},
        ]

    def connect(self, mac, link=None):
        if mac in self.active:
            return
        stop = threading.Event()
        self.active[mac] = stop
        threading.Thread(target=self._run, args=(mac, stop, link == "sds-ble"), daemon=True).start()

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
            # Its beacon as a new radio has it: no callsign, a person, sharing off
            bss = bytearray(46)
            bss[0], bss[1], bss[3] = 0x31, 0x04, 30
            bss[38:40] = b"/["
            self.controls[mac] = {
                "settings": {"channel_a": 0, "channel_b": 1, "scan": False, "dual": 0, "squelch": 3},
                "volume": 7, "region": 0, "tables": tables, "bss": bytes(bss),
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

    @staticmethod
    def _bss_reply(raw):
        """The block as a READ_BSS_SETTINGS reply frames it, for the same parser."""
        body = b"\x00" + raw
        return bytes([0xFF, 0x01, 0x00, len(body), 0x00, 0x02, 0x80, 33]) + body

    def read_bss(self, mac):
        return parse_bss(self._bss_reply(self._sim(mac)["bss"]))

    def write_bss(self, mac, changes):
        s = self._sim(mac)
        s["bss"] = bss_payload(s["bss"], changes)
        return self.read_bss(mac)

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

    # What a pretend SDS150 says each transmission was, in turn
    SIM_SCANNER = [
        {"system": "Worcester County", "department": "Holden", "channel": "Fire Operations",
         "frequency": "460.462500MHz"},
        {"system": "MA State Police", "department": "Troop C", "channel": "Dispatch", "frequency": "854.212500MHz",
         "talkgroup": "1201"},
    ]

    def _sim_screen(self, mac, key=None):
        """The pretend scanner's screen, as sds.parse_gst gives one: what it's on, and the last key pressed."""
        if not hasattr(self, "keys"):
            self.keys, self.wf_until = {}, {}
        if key is not None:
            self.keys[mac] = key
        ch = self.SIM_SCANNER[self.sent % len(self.SIM_SCANNER)]
        waterfall = time.monotonic() < self.wf_until.get(mac, 0)
        text = [time.strftime("        %b%d %H:%M"), ch["system"], ch["department"], ch["channel"],
                ch["frequency"], f"Last key: {self.keys.get(mac, '-')}", " SYSTEM      DEPT     CHANNEL "]
        modes = [""] * 6 + ["********* ********** *********"]
        screen = {"event": "scanner-screen", "mac": mac, "muted": True, "led": 0, "charge_led": 0,
                  "mode": "waterfall" if waterfall else "normal",
                  "lines": [{"text": t, "mode": m, "large": i == 3} for i, (t, m) in enumerate(zip(text, modes))]}
        if waterfall:
            screen["waterfall"] = {"hz": 460462500, "mod": "NFM", "marker": 120, "center_hz": 460462500,
                                   "lower_hz": 459742500, "upper_hz": 461182500}
        return screen

    def scanner_key(self, mac, key, hold_ms=100):
        import sds
        if mac not in self.active:
            raise RuntimeError(f"{mac} isn't connected")
        if str(key) not in sds.KEYS:
            raise ValueError(f"{key!r} isn't a key code the scanner takes")
        emit(self._sim_screen(mac, key))

    def scanner_waterfall(self, mac, seconds):
        if mac not in self.active:
            raise RuntimeError(f"{mac} isn't connected")
        self._sim_screen(mac)
        self.wf_until[mac] = time.monotonic() + max(0, min(float(seconds), 60))

    def _sim_scanner_tick(self, mac, i):
        """Every 100 ms of the pretend scanner: its screen each second, its waterfall while asked for."""
        if i % 10 == 0:
            emit(self._sim_screen(mac))
        if i % 3 == 0 and time.monotonic() < getattr(self, "wf_until", {}).get(mac, 0):
            levels = bytes(min(255, int(random.uniform(10, 40) + 120 * math.exp(-((c - 120) / 6) ** 2)))
                           for c in range(240))
            emit({"event": "scanner-waterfall", "mac": mac, "levels": base64.b64encode(levels).decode()})

    def _run(self, mac, stop, scanner=False):
        emit({"event": "status", "mac": mac, "state": "connected", **({} if scanner else {"rssi": 9})})
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
                    if scanner:
                        # As the scanner's A0 and A2 label a transmission (sds.py)
                        emit({"event": "scanner-channel", "mac": mac,
                              **self.SIM_SCANNER[self.sent % len(self.SIM_SCANNER)]})
                for i in range(int(secs * 1000 / CHUNK_MS)):
                    if stop.is_set():
                        break
                    if scanner:
                        self._sim_scanner_tick(mac, i)
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
                    # Every other burst, from the second, was a packet, which its
                    # modem decoded as it ended, as a real radio's does
                    if self.sent % 2 == 1 and not stop.is_set() and not scanner:
                        frame = self.SIM_PACKETS[(self.sent // 2) % len(self.SIM_PACKETS)]
                        emit({"event": "packet", "mac": mac, "channel": 0, "region": 0, "data": frame.hex()})
                    self.sent += 1
        emit({"event": "status", "mac": mac, "state": "disconnected"})


class Unavailable:
    """A backend that could not start: every command says why."""

    def __init__(self, reason):
        self.reason = reason

    def scan(self):
        raise RuntimeError(self.reason)

    def connect(self, _mac, _link=None):
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

    def read_bss(self, _mac):
        raise RuntimeError(self.reason)

    def write_bss(self, _mac, _changes):
        raise RuntimeError(self.reason)

    def scanner_key(self, _mac, _key, _hold_ms=100):
        raise RuntimeError(self.reason)

    def scanner_waterfall(self, _mac, _seconds):
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

    def connect(self, mac, link_kind=None):
        if link_kind == "sds-ble":
            raise RuntimeError("an SDS150 over Bluetooth needs the bumble backend (Low Energy); see docs/scanners.md")
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

    def scanner_key(self, _mac, _key, _hold_ms=100):
        raise RuntimeError("an SDS150 over Bluetooth needs the bumble backend (Low Energy); see docs/scanners.md")

    scanner_waterfall = scanner_key

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
                # link: how the radio is reached, from its model (src/models.js); "sds-ble" for an SDS150
                result = backend.connect(req["mac"], req.get("link"))
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
            # Its beacon: callsign, SSID, symbol, message, location sharing
            elif cmd == "bss":
                result = backend.read_bss(req["mac"])
            elif cmd == "write_bss":
                result = backend.write_bss(req["mac"], req["changes"])
            # An SDS150 over LE: a key pressed as on the scanner, and its waterfall asked for a while (sds.py)
            elif cmd == "scanner_key":
                result = backend.scanner_key(req["mac"], req["key"], req.get("hold_ms", 100))
            elif cmd == "scanner_waterfall":
                result = backend.scanner_waterfall(req["mac"], req.get("seconds", 15))
            elif cmd == "ping":
                result = "pong"
            else:
                raise ValueError(f"unknown command {cmd}")
            emit({"id": req["id"], "ok": True, "result": result})
        except Exception as e:  # report to the caller; never kill the loop
            # A timeout has no message of its own: its name, rather than an empty error
            emit({"id": req.get("id") if isinstance(req, dict) else None, "ok": False,
                  "error": str(e) or type(e).__name__})

    # stdin closed: the parent has gone away.
    shutdown()


if __name__ == "__main__":
    main()
