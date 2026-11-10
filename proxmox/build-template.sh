#!/bin/bash
# Builds the AirScribe Proxmox LXC template: Proxmox's own Ubuntu 24.04 template with Node 24 from NodeSource and
# AirScribe's .deb installed, set up to listen on the container's network, ready for its first boot.
#
# usage (as root, on Linux): proxmox/build-template.sh AIRSCRIBE.deb OUTPUT.tar.zst [BASE.tar.zst]
#
# BASE is Proxmox's ubuntu-24.04-standard template; without it, it's downloaded and checked against the SHA-512 in
# Proxmox's template index (aplinfo). Needs tar, zstd and curl.
#
# How (MediaRiffle's proxmox/build-template.sh, adapted): unpack the base, chroot into it, add NodeSource's
# repository (Ubuntu 24.04's Node is 18; AirScribe needs 22.13 or newer, and the repository stays so the container
# gets Node's updates), bring it up to date and install the .deb (its postinst sees no running systemd, so it only
# creates the service user and data folder; the service is enabled here instead), then reset what must differ per
# container (machine ID, SSH host keys), arm airscribe-firstboot and pack the filesystem. No Docker and no systemd:
# this runs as root in an ordinary CI container. /proc and /sys are mounted for apt when allowed.
set -euo pipefail

BASE_URL=http://download.proxmox.com/images/system/ubuntu-24.04-standard_24.04-2_amd64.tar.zst
BASE_SHA512=45c2978e6b97fe292ada95fe06834276015e5739a594db4de2fdfd830fa0c37942e8ae118fc1e32ffd9154b3f9378b592738b668ea3957db41f2907b86f219de
NODE_MAJOR=24
NODESOURCE_KEY_URL=https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key

[ $# -ge 2 ] || { echo "usage: $0 AIRSCRIBE.deb OUTPUT.tar.zst [BASE.tar.zst]" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "$0: run as root" >&2; exit 1; }
deb=$(readlink -f "$1")
# -m: the output's folder may not exist yet
output=$(readlink -m "$2")
base=${3:+$(readlink -f "$3")}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
root=$work/rootfs
mounted=()

log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() {
    for ((i = ${#mounted[@]} - 1; i >= 0; i--)); do umount -l "${mounted[i]}" 2>/dev/null || true; done
    rm -rf "$work"
}
trap cleanup EXIT
in_root() { chroot "$root" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive "$@"; }

if [ -z "$base" ]; then
    log "downloading Proxmox's Ubuntu 24.04 template"
    base=$work/base.tar.zst
    curl -fsSL --retry 3 -o "$base" "$BASE_URL"
fi
echo "$BASE_SHA512  $base" | sha512sum -c --quiet - || { log "the base template's checksum doesn't match"; exit 1; }

log "unpacking it"
mkdir -p "$root"
zstd -dc "$base" | tar -x -C "$root" --numeric-owner -p --xattrs --xattrs-include='*'

# What apt needs: /proc and /sys (when the build may mount them), a few device nodes, DNS, and services kept from
# starting (there's no init in a chroot)
for fs in proc sys; do
    if mount -t "$fs" "$fs" "$root/$fs" 2>/dev/null; then mounted+=("$root/$fs"); fi
done
[ ${#mounted[@]} -gt 0 ] || log "(not allowed to mount /proc here: installing without it)"
made_dev=()
for node in null:1:3 zero:1:5 random:1:8 urandom:1:9; do
    IFS=: read -r name major minor <<< "$node"
    if [ ! -e "$root/dev/$name" ]; then mknod -m 666 "$root/dev/$name" c "$major" "$minor"; made_dev+=("$name"); fi
done
resolv=$root/etc/resolv.conf
resolv_link=$(readlink "$resolv" 2>/dev/null || true)
mv "$resolv" "$work/resolv.conf.orig" 2>/dev/null || true
cp -L /etc/resolv.conf "$resolv"
printf '#!/bin/sh\nexit 101\n' > "$root/usr/sbin/policy-rc.d"
chmod 0755 "$root/usr/sbin/policy-rc.d"

log "adding NodeSource's Node $NODE_MAJOR repository"
# ffmpeg is in universe
grep -rqs universe "$root/etc/apt/sources.list" "$root/etc/apt/sources.list.d" ||
    { log "the base template has no universe repository"; exit 1; }
install -d -m 0755 "$root/etc/apt/keyrings"
# An armoured key, which apt reads as it is when the file ends in .asc
curl -fsSL --retry 3 -o "$root/etc/apt/keyrings/nodesource.asc" "$NODESOURCE_KEY_URL"
grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$root/etc/apt/keyrings/nodesource.asc" ||
    { log "NodeSource's signing key didn't download"; exit 1; }
cat > "$root/etc/apt/sources.list.d/nodesource.sources" <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_$NODE_MAJOR.x
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.asc
EOF
# NodeSource's nodejs over Ubuntu's, whichever is newer
cat > "$root/etc/apt/preferences.d/nodesource" <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF

log "updating Ubuntu and installing AirScribe"
cp "$deb" "$root/tmp/airscribe.deb"
in_root apt-get update -q
in_root apt-get -y -q -o Dpkg::Options::=--force-confold dist-upgrade
# curl: for checking it answers. bluez: BlueZ's tools, for a container given the host's Bluetooth (docs/proxmox.md)
in_root apt-get install -y -q --no-install-recommends ca-certificates /tmp/airscribe.deb curl bluez
rm -f "$root/tmp/airscribe.deb"
in_root node --version

log "setting it up for a container"
# Listen on the container's network; airscribe-firstboot sets the port and a password from
# /etc/airscribe/firstboot.env before AirScribe first starts. Until it has, AirScribe refuses to start: it won't
# listen beyond loopback without a credential.
in_root node /opt/airscribe/tools/configure.mjs /etc/airscribe/airscribe.config.json --host 0.0.0.0
chown root:"$(stat -c %g "$root/var/lib/airscribe")" "$root/etc/airscribe/airscribe.config.json"
chmod 0640 "$root/etc/airscribe/airscribe.config.json"

install -m 0755 "$here/airscribe-firstboot" "$root/usr/local/sbin/airscribe-firstboot"
install -m 0644 "$here/airscribe-firstboot.service" "$root/etc/systemd/system/airscribe-firstboot.service"
install -m 0644 "$here/firstboot.env" "$root/etc/airscribe/firstboot.env"
touch "$root/etc/airscribe/firstboot-pending"
# Enabled without a running systemd (systemctl works on the files in a chroot). The container has no Bluetooth
# adapter of its own, so BlueZ's daemon isn't started unless one is given to it.
in_root systemctl enable airscribe.service airscribe-firstboot.service
in_root systemctl disable bluetooth.service >/dev/null 2>&1 || true

cat > "$root/etc/motd" <<'MOTD'

  AirScribe: open http://<this container's address>:8100/ and sign in with the password in
  /root/airscribe-first-login.txt. Settings: /etc/airscribe/airscribe.config.json, then
  systemctl restart airscribe. Logs: journalctl -u airscribe. See docs/proxmox.md in the repository.

MOTD

log "cleaning up"
rm -f "$root/usr/sbin/policy-rc.d"
in_root apt-get clean
rm -rf "$root"/var/lib/apt/lists/* "$root"/tmp/* "$root"/var/tmp/* "$root/root/.bash_history" "$root/root/.npm"
# Per-container identity: a new machine ID at first boot, SSH host keys made by pct (or by airscribe-firstboot)
: > "$root/etc/machine-id"
rm -f "$root/var/lib/dbus/machine-id" "$root"/etc/ssh/ssh_host_*
# Nothing of AirScribe's own yet: the database is made when the container first starts
find "$root/var/lib/airscribe" -mindepth 1 -delete
find "$root/var/log" -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete
find "$root/var/log" -type f -exec truncate -s 0 {} +
for name in "${made_dev[@]}"; do rm -f "$root/dev/$name"; done
rm -f "$resolv"
if [ -n "$resolv_link" ]; then ln -s "$resolv_link" "$resolv"
elif [ -e "$work/resolv.conf.orig" ]; then mv "$work/resolv.conf.orig" "$resolv"; fi
for ((i = ${#mounted[@]} - 1; i >= 0; i--)); do umount -l "${mounted[i]}"; done
mounted=()

log "packing"
mkdir -p "$(dirname "$output")"
tar -C "$root" --numeric-owner --xattrs --xattrs-include='*' -cf - . | zstd -q -T0 -19 --long=27 -o "$output" -f
# check the archive reads back
zstd -dc --long=27 "$output" | tar -t >/dev/null
log "template: $output ($(du -h "$output" | cut -f1))"
