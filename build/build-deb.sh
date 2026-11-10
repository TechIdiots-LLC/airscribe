#!/bin/bash
# Makes AirScribe's .deb, for Ubuntu 24.04 and Debian 12 or newer.
#
# usage: build/build-deb.sh VERSION OUTDIR
#
# VERSION is the release's (package.json), e.g. 0.1.0 or 0.2.0-rc.1, or a CI build's 0.1.0+ci12.abc1234; the
# package's version is VERSION-1, with a pre-release's "-" as "~" so that it sorts before the release. Writes
# OUTDIR/airscribe_<version>-1_all.deb and prints its path. Needs npm (for the production node_modules) and dpkg-deb.
#
# The package is "all": AirScribe is JavaScript and Python, and its one dependency tree (express) has no native
# code. It needs Node 22.13 or newer, which Ubuntu 24.04 doesn't have: the Proxmox template adds NodeSource's
# repository (docs/installing.md).
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 VERSION OUTDIR" >&2; exit 2; }
version=$1
out=$(readlink -m "$2")
repo=$(cd "$(dirname "$0")/.." && pwd)
linux=$repo/deploy/linux

# 0.2.0-rc.1 -> 0.2.0~rc.1 (sorts before 0.2.0); 0.1.0+ci12.abc1234 stays
debver=$(echo "$version" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+)-/\1~/')-1
pkg=$(mktemp -d)
trap 'rm -rf "$pkg"' EXIT
app=$pkg/opt/airscribe

# The program: what src/index.js loads, the sidecar it starts, the page it serves, and the diagnostics in tools/
mkdir -p "$app"
cp -r "$repo/src" "$repo/public" "$app/"
mkdir -p "$app/sidecar" "$app/tools"
find "$repo/sidecar" -maxdepth 1 -name '*.py' ! -name 'test_*.py' -exec install -m 0644 {} "$app/sidecar/" \;
chmod 0755 "$app/sidecar/airscribe_sidecar.py"
for f in "$repo"/tools/*; do
    [ -f "$f" ] || continue   # e.g. a local __pycache__
    case "$f" in *.sh | *.py | *.mjs) install -m 0755 "$f" "$app/tools/" ;; *) install -m 0644 "$f" "$app/tools/" ;; esac
done
install -m 0644 "$repo/package.json" "$repo/package-lock.json" "$repo/airscribe.config.json.sample" \
    "$repo/LICENSE" "$repo/NOTICE.md" "$app/"
# The version the server reports, and Admin -> Updates compares against: the release's, not package.json's
# (a CI build's carries +ci<n>)
sed -i -E "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$version\"/" "$app/package.json"
grep -q "\"version\": \"$version\"" "$app/package.json" || { echo "$0: couldn't set the version in package.json" >&2; exit 1; }
# To stderr: this script's stdout is the .deb's path, which callers read
(cd "$app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) >&2
# Not needed to run it; the lock file has served its purpose
rm -f "$app/package-lock.json"
find "$app" -name '__pycache__' -prune -exec rm -rf {} +

install -D -m 0644 "$linux/airscribe.service" "$pkg/usr/lib/systemd/system/airscribe.service"
install -D -m 0640 "$linux/airscribe.config.json" "$pkg/etc/airscribe/airscribe.config.json"

doc=$pkg/usr/share/doc/airscribe
install -D -m 0644 "$repo/README.md" "$doc/README.md"
install -D -m 0644 "$repo/CHANGELOG.md" "$doc/CHANGELOG.md"
mkdir -p "$doc/docs" && install -m 0644 "$repo"/docs/*.md "$doc/docs/"
cat > "$doc/copyright" <<EOF
AirScribe, Copyright (c) 2026 TechIdiots LLC, under the Apache License, version 2.0
(/opt/airscribe/LICENSE). The radio protocol comes from BenLink and HTCommander: see /opt/airscribe/NOTICE.md.
/opt/airscribe/node_modules holds express and its dependencies, each under the licence in its own folder.
EOF

mkdir -p "$pkg/DEBIAN"
for f in postinst prerm postrm; do install -m 0755 "$linux/debian/$f" "$pkg/DEBIAN/$f"; done
(cd "$pkg" && find etc -type f | sed 's|^|/|' | sort) > "$pkg/DEBIAN/conffiles"
size=$(du -sk --exclude=DEBIAN "$pkg" | cut -f1)
cat > "$pkg/DEBIAN/control" <<EOF
Package: airscribe
Version: $debver
Architecture: all
Maintainer: TechIdiots LLC <noreply@techidiots.net>
Installed-Size: $size
Depends: nodejs (>= 22.13), python3 (>= 3.10), ffmpeg, adduser, passwd
Recommends: bluez, curl
Suggests: python3-venv, intel-opencl-icd
Section: hamradio
Priority: optional
Homepage: https://gitlab.techidiots.net/techidiots-llc/airscribe
Description: writes down what is on the air
 A web front end for Bluetooth handheld radios: it connects to the radios,
 splits their audio into one clip per transmission, transcribes each clip and
 shows the text, with the audio, in a browser.
EOF

mkdir -p "$out"
deb=$out/airscribe_${debver}_all.deb
dpkg-deb --root-owner-group -Zxz --build "$pkg" "$deb" >/dev/null
echo "$deb"
