"""Parsing of `bluetoothctl` output, kept separate so it can be tested."""

# Vendor "BS AOC" SDP service. HTCommander (upstream main,
# src/linux/runner/bluetooth_classic_plugin.cc) treats a device exposing this
# UUID as a compatible radio, and also uses it to find the audio RFCOMM
# channel. Matching on it survives rebrands, unlike matching on the name.
RADIO_SERVICE_UUID = "39144315-32fa-40db-85ed-fbfeba2d86e6"


def parse_devices(text: str):
    """`bluetoothctl devices` -> [{"mac", "name"}]."""
    out = []
    for line in text.splitlines():
        parts = line.split(" ", 2)
        if len(parts) == 3 and parts[0] == "Device":
            out.append({"mac": parts[1], "name": parts[2]})
    return out


def parse_uuids(info: str):
    """`bluetoothctl info <mac>` -> lowercase list of service UUIDs."""
    uuids = []
    for line in info.splitlines():
        line = line.strip()
        if line.startswith("UUID:") and "(" in line:
            uuids.append(line[line.rindex("(") + 1 : line.rindex(")")].lower())
    return uuids


def is_radio(info: str) -> bool:
    return RADIO_SERVICE_UUID in parse_uuids(info)
