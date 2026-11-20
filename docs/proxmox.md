# Proxmox

Each release carries `AirScribe-v<version>-proxmox-amd64.tar.zst`: Proxmox's own Ubuntu 24.04 template with Node 24
(from NodeSource) and AirScribe's `.deb` installed, listening on the container's network. Its first boot sets the
port and a sign-in password, so there is nothing to install by hand.

## Create a container

1. Download the template from the release and put it in a storage that holds container templates, e.g. upload it
   under **local → CT Templates**, or copy it to `/var/lib/vz/template/cache/` on the node.
2. Create the container from it. Unprivileged is fine. 1 GB of memory and 8 GB of disk run the mock and the small
   models; add disk for clips and larger models.

   ```sh
   pct create 140 local:vztmpl/AirScribe-v0.1.0-proxmox-amd64.tar.zst \
     --hostname airscribe --unprivileged 1 --cores 2 --memory 2048 --rootfs local-lvm:16 \
     --net0 name=eth0,bridge=vmbr0,ip=dhcp --onboot 1
   ```

3. Optionally, before starting it, set the port or your own password in `/etc/airscribe/firstboot.env`:

   ```sh
   pct mount 140
   nano /var/lib/lxc/140/rootfs/etc/airscribe/firstboot.env   # AIRSCRIBE_PORT, AIRSCRIBE_PASSWORD
   pct unmount 140
   ```

4. Start it, and read where it listens and the password its first boot made:

   ```sh
   pct start 140
   pct exec 140 -- cat /root/airscribe-first-login.txt
   ```

Open the address it gives and sign in. The password is stored only as a hash in
`/etc/airscribe/airscribe.config.json`; the note in `/root` is the one copy of it, readable by root.

To change the password later, set `AIRSCRIBE_PASSWORD` in `firstboot.env` and run `airscribe-firstboot` again inside
the container, then `systemctl restart airscribe`. Run with no password set, it keeps the existing one.

## Settings, logs, data

| | |
| --- | --- |
| Settings | `/etc/airscribe/airscribe.config.json`, then `systemctl restart airscribe`. Every key: `/opt/airscribe/airscribe.config.json.sample` |
| Logs | `journalctl -u airscribe` |
| Data | `/var/lib/airscribe`: the database, the clips, and models if you put them there |

The template starts with the `mock` transcription engine, which labels every clip as a mock transcript. Set up a
real one from [transcription.md](transcription.md).

## Transcription on the host's Intel GPU

Map the GPU's render node into the container. Find which node is the card on the host (`ls -l /dev/dri/by-path/`),
then, with the `render` group's id looked up in the container (use the next free `devN`; the dongle may have `dev0`):

```sh
gid=$(pct exec <id> -- getent group render | cut -d: -f3); echo "render gid: $gid"
[ -n "$gid" ] && pct set <id> -dev1 /dev/dri/renderD128,gid=$gid
pct reboot <id>
```

Several containers can map the same render node and use the card at once, so a media server can keep transcoding on
it. The package adds the service account to `render`.

**OpenVINO, as it was set up on an Arc A750 (pve1, LXC 113), where it runs on the GPU:** Ubuntu 24.04's own compute
runtime (`intel-opencl-icd` 23.43) was enough for OpenVINO 2026.4.1. In the container:

```sh
apt install -y intel-opencl-icd clinfo
runuser -u airscribe -- clinfo -l                     # lists the card
python3 -m venv /opt/openvino
/opt/openvino/bin/pip install "openvino-genai>=2026.4" huggingface_hub
runuser -u airscribe -- /opt/openvino/bin/python -c "from openvino import Core; print(Core().available_devices)"
/opt/openvino/bin/hf download OpenVINO/whisper-base.en-fp16-ov --local-dir /var/lib/airscribe/models/whisper-base.en-fp16-ov
install -d -o airscribe -g airscribe /var/lib/airscribe/ov-cache
chown -R airscribe:airscribe /var/lib/airscribe/models
```

The device list should be `['CPU', 'GPU']` (a `hwloc … invalid information` notice before it, about how the
container's cores map onto the host's, is harmless). Then set `stt` in `/etc/airscribe/airscribe.config.json`:

```json
"stt": {
  "engine": "openvino",
  "openvino": {
    "python": "/opt/openvino/bin/python",
    "modelDir": "/var/lib/airscribe/models/whisper-base.en-fp16-ov",
    "device": "GPU",
    "cacheDir": "/var/lib/airscribe/ov-cache",
    "language": "en"
  }
}
```

`systemctl restart airscribe`. The first transmission logs `[stt] openvino worker running on GPU` (or the reason it
fell back to the CPU) and is slow while the model compiles for the card; `ov-cache` keeps the result. Clips recorded
before the change can be read again with `POST /api/transcribe-missing?engine=openvino`. whisper.cpp with Vulkan is
the other route ([transcription.md](transcription.md#using-an-intel-gpu)); it hasn't been run on the card yet.

## Radios over Bluetooth

The kernel refuses Bluetooth sockets to anything outside the host's own network namespace, which an LXC container is,
so BlueZ inside one cannot reach a radio however the adapter is passed in, and the template's default `bluez` backend
reports `bluetoothctl unavailable`. Use the **`bumble`** backend instead: Bumble, a Bluetooth stack in Python, drives a
USB dongle directly. `tools/probe-bumble.py` paired with a UV-Pro, found its channels and captured its audio from inside
an unprivileged container this way ([bluetooth.md](bluetooth.md#through-bumble-in-an-lxc-container)), and the backend
then connected to it, read its battery and channel names, and recorded its transmissions.

Give the container the dongle as a USB device. On the host:

```sh
lsusb                                              # find the dongle: bus, device and ID
echo "blacklist btusb" > /etc/modprobe.d/no-btusb.conf && rmmod btusb   # the host lets go of it
```

`btusb` is the host's driver for every Bluetooth dongle, so this turns off the host's own Bluetooth too. Then either
add the device in the container's **Resources → Add → Device** as `/dev/bus/usb/<bus>/<device>`, with **GID in CT** set
to the `airscribe` group's id so the service can open it, or the same from the host's shell:

```sh
gid=$(pct exec <id> -- getent group airscribe | cut -d: -f3)
pct set <id> -dev0 /dev/bus/usb/<bus>/<device>,gid=$gid
```

The device number changes if the dongle is unplugged (this is the way that was tried). To survive that, add to
`/etc/pve/lxc/<id>.conf` instead:

```
lxc.cgroup2.devices.allow: c 189:* rwm
lxc.mount.entry: /dev/bus/usb dev/bus/usb none bind,optional,create=dir
```

and let the container open it, with the dongle's ID from `lsusb`:

```sh
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0a12", ATTRS{idProduct}=="0001", MODE="0666"' \
  > /etc/udev/rules.d/90-airscribe-bt.rules
udevadm control --reload && udevadm trigger
```

Restart the container, then in it install Bumble (the version CI tests) and check it reaches the dongle:

```sh
apt update && apt install -y python3-venv libatomic1
python3 -m venv /opt/bumble && /opt/bumble/bin/pip install "bumble==0.0.236"
runuser -u airscribe -- /opt/bumble/bin/python /opt/airscribe/tools/probe-bumble.py --transport usb:0A12:0001 \
  --keys /var/lib/airscribe/bumble-keys.json --info
```

Run as `airscribe`, that also proves the service may open the dongle. (`--keys` is AirScribe's own key file, which
that user can read; the probe's default is `bumble-keys.json` in the current folder.) Then point AirScribe at it, in
`/etc/airscribe/airscribe.config.json`:

```json
"sidecar": {
  "python": "/opt/bumble/bin/python",
  "backend": "bumble",
  "transport": "usb:0A12:0001"
}
```

`systemctl restart airscribe`, then **Scan for radios** in the web page. With the radio in pairing mode, **Add** it
and connect; the first connection pairs, and the key is kept in `/var/lib/airscribe/bumble-keys.json`. If the probe
already paired this dongle with the radio, copying its `bumble-keys.json` there (owned by `airscribe`) skips that.

The probe is still useful on its own, as root and with AirScribe stopped, since only one program can hold the dongle:

```sh
P="/opt/bumble/bin/python /opt/airscribe/tools/probe-bumble.py --transport usb:0A12:0001"
$P --scan
$P <radio MAC>            # pairs (radio in pairing mode the first time), finds the channels, captures 45 s
```

### Which dongle

A Bluetooth 4.0 dongle such as a CSR8510 (`0a12:0001`) is enough for UV-Pros. An SDS150 sends its audio over Bluetooth
LE, which a 4.0 dongle carries in 27-byte packets: enough at 15 ms with the screen polled less during audio, but
with little to spare ([sds150-bluetooth.md](sds150-bluetooth.md#throughput)). A Bluetooth 5 dongle takes 251-byte
packets and the faster 2M PHY, as a phone does, and AirScribe asks for both when the dongle has them. The journal
shows what the link got: `packets: 251 bytes out, 251 in` and `PHY: ...LE_2M...`.

Bumble can drive Bluetooth 5 dongles built on Realtek's RTL8761B, such as the **TP-Link UB500** (`2357:0604`). They
need firmware loaded at every power-up, which Bumble does itself when it finds the files (not yet tried with AirScribe
on a real one). Put them in the container (the template has `curl`):

```sh
mkdir -p /lib/firmware/rtl_bt && cd /lib/firmware/rtl_bt
for f in rtl8761bu_fw.bin rtl8761bu_config.bin; do
  curl -fsSLO "https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/rtl_bt/$f"
done
```

(`bumble-rtk-fw-download`, Bumble's tool for this, fails to start in 0.0.236.) Then pass the dongle in and use its ID
everywhere the steps above have `0a12:0001`: the udev rule, `--transport usb:2357:0604` and `"transport":
"usb:2357:0604"`. `probe-bumble.py --info` lists `long LE packets : yes` and `LE 2M PHY : yes` for it, and
`firmware : NOT LOADED` if it didn't find the files.

**A new dongle has a new address, so pair everything again.** A radio or scanner keeps its pairing under the address
it paired with, so the old keys don't work on the new dongle. Move `/var/lib/airscribe/bumble-keys.json` aside (keep it
to go back to the old dongle), then connect each one with it ready to pair: a UV-Pro in pairing mode, an SDS150 in
**Menu > Settings > Bluetooth Options > Pairing**.

## Updating

**Admin → Updates** installs a newer release in place ([updating.md](updating.md)). By hand, download the release's
`.deb` into the container and:

```sh
apt-get install ./airscribe_<version>-1_all.deb
```

`/etc/airscribe/airscribe.config.json` and `/var/lib/airscribe` are kept. A `pct snapshot` first is cheap insurance.
