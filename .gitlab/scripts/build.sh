#!/bin/bash
# Builds the release files, in an ubuntu:24.04 job on the Linux runner, as root:
#
#   1. AirScribe's .deb (build/build-deb.sh)
#   2. the Proxmox template from it (proxmox/build-template.sh), and its files checked (proxmox/test-template.sh,
#      which can only look inside it here: the job that has Docker boots it)
#
# usage: .gitlab/scripts/build.sh OUTDIR VERSION
#
# VERSION names the files: the release's (0.1.0), or a CI build's (0.1.0+ci12.abc1234).
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 OUTDIR VERSION" >&2; exit 2; }
out=$(readlink -m "$1")
version=$2
repo=$(cd "$(dirname "$0")/../.." && pwd)

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl zstd
# npm, for the .deb's node_modules: Node 24 from NodeSource, as the template has
if ! command -v npm >/dev/null; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL --retry 3 -o /etc/apt/keyrings/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q
    apt-get install -y -q --no-install-recommends nodejs
fi

mkdir -p "$out"
deb=$(bash "$repo/build/build-deb.sh" "$version" "$out")
dpkg-deb --info "$deb" | sed -n '/Package:/,$p'

# the template's name keeps the version's "+" out: v0.1.0-ci12-abc1234
if [[ $version =~ ^(.*)\+ci([0-9]+)\.(.*)$ ]]; then
    label=v${BASH_REMATCH[1]}-ci${BASH_REMATCH[2]}-${BASH_REMATCH[3]}
else
    label=v$version
fi
template=$out/AirScribe-$label-proxmox-amd64.tar.zst
bash "$repo/proxmox/build-template.sh" "$deb" "$template"
bash "$repo/proxmox/test-template.sh" "$template"
ls -la "$out"
