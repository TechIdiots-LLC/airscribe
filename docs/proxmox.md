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

Map the GPU's render node into the container. Find which node is the card on the host, and the `render` group's id
inside the container:

```sh
ls -l /dev/dri/by-path/                      # on the host
pct exec 140 -- getent group render          # in the container
pct set 140 -dev0 /dev/dri/renderD128,gid=<that id>
pct reboot 140
```

Several containers can map the same render node and use the card at once, so a media server can keep transcoding on
it. The package adds the service account to `render`. Then set up OpenVINO or whisper.cpp with Vulkan as
[transcription.md](transcription.md#using-an-intel-gpu) describes.

## Radios over Bluetooth

The kernel refuses Bluetooth sockets to anything outside the host's own network namespace, which an LXC container is,
so BlueZ inside one cannot reach a radio however the adapter is passed in, and the template's default `bluez` backend
reports `bluetoothctl unavailable`. Use the **`bumble`** backend instead: Bumble, a Bluetooth stack in Python, drives a
USB dongle directly. `tools/probe-bumble.py` paired with a UV-Pro, found its channels and captured its audio from inside
an unprivileged container this way ([bluetooth.md](bluetooth.md#through-bumble-in-an-lxc-container)). The backend
itself has been tested against a fake radio, not yet a real one.

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
runuser -u airscribe -- /opt/bumble/bin/python /opt/airscribe/tools/probe-bumble.py --transport usb:0A12:0001 --info
```

Run as `airscribe`, that also proves the service may open the dongle. Then point AirScribe at it, in
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

## Updating

**Admin → Updates** installs a newer release in place ([updating.md](updating.md)). By hand, download the release's
`.deb` into the container and:

```sh
apt-get install ./airscribe_<version>-1_all.deb
```

`/etc/airscribe/airscribe.config.json` and `/var/lib/airscribe` are kept. A `pct snapshot` first is cheap insurance.
