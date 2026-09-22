# Installing on Ubuntu

Tested against Ubuntu 24.04 with a USB Bluetooth adapter. 22.04 should work
too; both ship a new enough BlueZ, and the Node requirement is met from
NodeSource on either.

One thing costs the afternoon here, and it is not the service unit: it is
**letting a non-root account talk to BlueZ**. Pairing, D-Bus policy and the
service account all have to agree, and when any one of them does not the
failure looks the same — the radio simply never connects. Run
[`tools/bringup-linux.sh`](../tools/bringup-linux.sh) before writing a unit
file; it checks each of those separately and says which one refused.

## Packages

```sh
sudo apt install bluez bluez-tools python3
```

`bluez-tools` is for `sdptool`, which resolves the radio's RFCOMM channel
numbers. They differ per device and must not be hardcoded — see
[bluetooth.md](bluetooth.md).

Node from NodeSource, because the distribution's is too old:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install nodejs
```

**Node 22.5 or newer is required**, not merely preferred: the store uses
`node:sqlite`, which does not exist before it. The bring-up script checks for
the module itself rather than parsing a version string.

## Pair the radio first

Pair as yourself, once, before any of the service setup. The daemon keeps the
bond in `/var/lib/bluetooth`, so the service never needs to pair anything.

Put the radio into pairing mode first, then:

```sh
bluetoothctl
  power on
  agent on
  default-agent
  scan on
  # wait for a line naming the radio, e.g.
  #   [NEW] Device 38:D2:00:01:56:51 UV-PRO
  pair 38:D2:00:01:56:51
  trust 38:D2:00:01:56:51
  scan off
  quit
```

`agent on` and `default-agent` matter: without an agent registered there is
nothing to answer the pairing request, and `pair` fails in a way that looks
like the radio ignored it.

**Do not assume the address.** Let `scan on` show you what the radio actually
advertises — it appears by name (`UV-PRO`). These radios can present more than
one bond, in quick succession; pair each one that appears, since on the unit
tested the services were not evenly distributed between them.

Confirm it took:

```sh
bluetoothctl connect 38:D2:00:01:56:51    # SDP browsing needs a live link
./tools/bringup-linux.sh 38:D2:00:01:56:51
```

That should report the **BS AOC service** present. If it does not, the radio is
either unpaired, powered off, out of range, or not a supported model.

The connect matters: a paired-but-disconnected radio still reports its cached
UUIDs, so the BS AOC check passes, but `sdptool browse` returns nothing and the
RFCOMM channel numbers stay unknown.

## The code

A checkout under `/opt` suits a service that is also being worked on:

```sh
sudo git clone https://github.com/TechIdiots-LLC/airscribe.git /opt/airscribe
cd /opt/airscribe
sudo npm ci --omit=dev
```

For transcription, install the engine and a model — see
[transcription.md](transcription.md):

```sh
sudo pip install sherpa-onnx --break-system-packages
```

A virtualenv is tidier on 24.04, where pip otherwise refuses to touch the
system Python. If you use one, point `stt["sherpa-onnx"].python` at its
interpreter.

## A service account, and the Bluetooth problem

```sh
sudo groupadd --system airscribe
sudo useradd --system --gid airscribe \
  --home-dir /var/lib/airscribe --create-home \
  --shell /usr/sbin/nologin --comment "AirScribe service" airscribe
sudo usermod -aG bluetooth airscribe
sudo install -d -o airscribe -g airscribe -m 0750 /var/lib/airscribe
sudo install -d -o airscribe -g airscribe -m 0750 /etc/airscribe
```

Group membership alone is usually **not** enough. BlueZ is reached over the
system D-Bus, and its shipped policy grants the interesting methods to root.
Granting the `bluetooth` group explicitly, in
`/etc/dbus-1/system.d/airscribe.conf`:

```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy group="bluetooth">
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.Adapter1"/>
    <allow send_interface="org.bluez.Device1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

Then `sudo systemctl reload dbus`, and verify **as the service account** rather
than assuming:

```sh
sudo -u airscribe /opt/airscribe/tools/bringup-linux.sh 38:D2:00:01:56:51
```

The script's D-Bus check runs as whoever invoked it, which is the whole point
of running it this way. Passing as your own user and failing as `airscribe` is
the signature of a policy problem.

## Configuration

```sh
sudo install -o airscribe -g airscribe -m 0600 \
  /opt/airscribe/airscribe.config.json.sample /etc/airscribe/airscribe.config.json
sudoedit /etc/airscribe/airscribe.config.json
```

`0600` because the file holds credentials. Generate them rather than inventing
them:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## The unit

`/etc/systemd/system/airscribe.service`:

```ini
[Unit]
Description=AirScribe
Documentation=https://github.com/TechIdiots-LLC/airscribe
After=network-online.target bluetooth.service
Wants=network-online.target
Requires=bluetooth.service

[Service]
Type=simple
User=airscribe
Group=airscribe
SupplementaryGroups=bluetooth
WorkingDirectory=/opt/airscribe
ExecStart=/usr/bin/node /opt/airscribe/src/index.js --config /etc/airscribe/airscribe.config.json
Restart=always
RestartSec=5
ReadWritePaths=/var/lib/airscribe /etc/airscribe

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_BLUETOOTH

[Install]
WantedBy=multi-user.target
```

`Requires=bluetooth.service` rather than `After=` alone: with no daemon there
is nothing to connect to, so starting anyway only produces a confusing log.

`Restart=always` is required, not optional — a radio dropping its link is
normal, and the supervisor restarting the process is how the session is
rebuilt.

**`RestrictAddressFamilies` must list `AF_BLUETOOTH`.** Leave it out and every
socket to the radio fails with a permission error that never mentions
Bluetooth. Do not add `PrivateDevices`, which cuts the adapter off the same
silent way.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now airscribe
journalctl -u airscribe -f
```

## Before there is a real radio backend

The BlueZ backend is not written yet — `connect()` says so. Until it lands,
the simulator exercises everything around it:

```sh
node src/index.js --simulate
```

That brings up the whole pipeline with a fake radio and a mock transcriber, so
the service, the ports and the web UI can be shaken out without hardware.

## Not verified yet

The D-Bus policy and the unit's hardening options are reasoned from how BlueZ
and systemd behave, not yet confirmed against a running install. Expect to
adjust them, and please correct this page when you do.
