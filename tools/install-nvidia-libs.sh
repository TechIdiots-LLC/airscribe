#!/bin/bash
# Installs NVIDIA's driver libraries in this container (CUDA, NVENC and NVDEC, Vulkan, nvidia-smi; not the kernel
# module, which is the Proxmox node's): the same version as the driver running on the node, which they must match.
# Run it as root once the card is passed in, and again after the node's driver is upgraded.
#
# usage: install-nvidia-libs.sh [--force] [VERSION]
#   VERSION   the driver version to install (580.95.05, say); default: the node's, from /proc/driver/nvidia/version
#   --force   install it again when it's there already
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
force=0 ver=
for a in "$@"; do
    case "$a" in
        --force) force=1 ;;
        -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "usage: $0 [--force] [VERSION]" >&2; exit 2 ;;
        *) ver=$a ;;
    esac
done
[ "$(id -u)" = 0 ] || { echo "Run it as root." >&2; exit 1; }
libdir=/usr/lib/x86_64-linux-gnu

if [ -z "$ver" ]; then
    if [ ! -r /proc/driver/nvidia/version ]; then
        echo "The Proxmox node isn't running NVIDIA's driver (no /proc/driver/nvidia/version): install it there first." >&2
        exit 1
    fi
    ver=$(grep -m1 '^NVRM' /proc/driver/nvidia/version | grep -oE '\b[0-9]{3}\.[0-9]+(\.[0-9]+)?\b' | head -1)
    [ -n "$ver" ] || { echo "Can't read the driver version from /proc/driver/nvidia/version:" >&2; cat /proc/driver/nvidia/version >&2; exit 1; }
    echo "The node runs NVIDIA's driver $ver."
fi
if [ -e "$libdir/libcuda.so.$ver" ] && [ $force = 0 ]; then
    echo "Its libraries are installed here already ($libdir/libcuda.so.$ver). --force installs them again."
    exit 0
fi

# kmod: the installer wants modprobe, even with no module to load
for p in curl ca-certificates kmod; do
    dpkg -s "$p" >/dev/null 2>&1 ||
        { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates kmod; break; }
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
run=$tmp/NVIDIA-Linux-x86_64-$ver.run
# Ordinary drivers are under XFree86/, data-centre ones under tesla/
for url in "https://download.nvidia.com/XFree86/Linux-x86_64/$ver/NVIDIA-Linux-x86_64-$ver.run" \
           "https://us.download.nvidia.com/tesla/$ver/NVIDIA-Linux-x86_64-$ver.run"; do
    echo "Downloading $url"
    curl -fsSL --retry 3 -o "$run" "$url" && break
    rm -f "$run"
done
[ -s "$run" ] || { echo "NVIDIA has no driver $ver to download." >&2; exit 1; }

echo "Installing the libraries (no kernel module)"
# --no-systemd: the node's suspend services don't belong here; the installer replaces an older version it finds
if ! sh "$run" --silent --no-kernel-modules --no-questions --ui=none --no-nouveau-check --no-x-check \
        --no-systemd --no-install-compat32-libs --no-backup --tmpdir="$tmp" --log-file-name="$tmp/installer.log"; then
    tail -30 "$tmp/installer.log" >&2
    echo "NVIDIA's installer failed (its log is above)." >&2
    exit 1
fi
ldconfig
test -e "$libdir/libcuda.so.$ver" || { echo "The installer finished but $libdir/libcuda.so.$ver isn't there." >&2; exit 1; }
echo "NVIDIA's libraries $ver are installed."
if [ -e /dev/nvidia0 ]; then
    nvidia-smi -L || echo "nvidia-smi can't reach the card: check the devices passed in (docs/proxmox.md)."
else
    echo "/dev/nvidia0 isn't passed in yet (docs/proxmox.md); nvidia-smi will list the card once it is."
fi
