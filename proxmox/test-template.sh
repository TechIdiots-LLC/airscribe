#!/bin/bash
# Tests an AirScribe Proxmox template. Exits non-zero on failure.
#
# usage (as root): proxmox/test-template.sh TEMPLATE.tar.zst
#
# With Docker (a privileged GitLab runner, a GitHub runner): boots the template the way a new container starts, with
# Docker standing in for pct and a firstboot.env as an admin would write it, and checks AirScribe answers on the port
# it sets, refuses the API without signing in, and signs in with the password it sets. Without Docker (an ordinary
# GitLab Docker-executor job): checks the template's files and runs airscribe-firstboot in a chroot of it, with no
# password given, so the one it makes is checked instead.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 TEMPLATE.tar.zst" >&2; exit 2; }
template=$(readlink -f "$1")
log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { log "FAILED: $*"; exit 1; }

PORT=8200
PASSWORD='template-test-password'
env_file=$(mktemp)
printf 'AIRSCRIBE_PORT=%s\nAIRSCRIBE_PASSWORD=%s\n' "$PORT" "$PASSWORD" > "$env_file"
settings_ok() {   # $1: the settings file's text
    grep -q "\"port\": $PORT" <<< "$1" || fail "the port wasn't applied"
    grep -q '"host": "0.0.0.0"' <<< "$1" || fail "it doesn't listen on the container's network"
    grep -q '"passwordHash": "scrypt\$' <<< "$1" || fail "no password hash in the settings"
    ! grep -q "$PASSWORD" <<< "$1" || fail "the password is in the settings in plain text"
}

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    name=airscribe-template-test-$$
    image=airscribe-template-test:$$
    # shellcheck disable=SC2329  # run by the trap
    cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker rmi "$image" >/dev/null 2>&1 || true; rm -f "$env_file"; }
    trap cleanup EXIT

    log "importing the template"
    zstd -dc --long=27 "$template" | docker import - "$image" >/dev/null
    docker create --name "$name" --hostname airscribe --privileged --cgroupns=private \
        --tmpfs /run --tmpfs /run/lock "$image" /sbin/init >/dev/null
    docker cp "$env_file" "$name:/etc/airscribe/firstboot.env"
    log "booting"
    docker start "$name" >/dev/null
    in_ct() { docker exec "$name" "$@"; }
    code=""
    for _ in $(seq 90); do
        code=$(in_ct curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)
        [ "$code" = 200 ] && break
        if in_ct systemctl is-failed -q airscribe-firstboot 2>/dev/null; then break; fi
        sleep 2
    done
    if [ "$code" != 200 ]; then
        in_ct journalctl -u airscribe-firstboot -u airscribe --no-pager | tail -60 || true
        fail "AirScribe didn't answer on port $PORT (last: ${code:-none})"
    fi
    log "AirScribe answers on $PORT"
    settings_ok "$(in_ct cat /etc/airscribe/airscribe.config.json)"
    [ "$(in_ct stat -c '%U:%G %a' /etc/airscribe/airscribe.config.json)" = "root:airscribe 640" ] ||
        fail "the settings file should be root:airscribe 640"

    api() { in_ct curl -s -o /dev/null -w '%{http_code}' "$@"; }
    [ "$(api "http://127.0.0.1:$PORT/api/radios")" = 401 ] || fail "the API answered without signing in"
    [ "$(api -X POST -H 'Content-Type: application/json' -d '{"password":"not-it"}' \
        "http://127.0.0.1:$PORT/api/login")" = 401 ] || fail "a wrong password was accepted"
    in_ct curl -s -c /tmp/jar -o /dev/null -X POST -H 'Content-Type: application/json' \
        -d "{\"password\":\"$PASSWORD\"}" "http://127.0.0.1:$PORT/api/login"
    [ "$(api -b /tmp/jar "http://127.0.0.1:$PORT/api/radios")" = 200 ] ||
        fail "signing in with the firstboot.env password didn't work"
    session=$(in_ct curl -s -b /tmp/jar "http://127.0.0.1:$PORT/api/session")
    grep -q '"role":"admin"' <<< "$session" || fail "the password should sign in as admin: $session"
    log "signed in: $session"

    in_ct test ! -e /etc/airscribe/firstboot-pending || fail "firstboot-pending is still there"
    in_ct test -s /root/airscribe-first-login.txt || fail "no first-login note"
    [ "$(in_ct stat -c %a /root/airscribe-first-login.txt)" = 600 ] || fail "the first-login note is readable by others"
    in_ct sh -c 'test -s /etc/machine-id' || fail "no machine ID"
    in_ct sh -c 'ls /etc/ssh/ssh_host_*_key >/dev/null' || fail "no SSH host keys"
    in_ct test -f /var/lib/airscribe/airscribe.sqlite || fail "AirScribe made no database"
    in_ct systemctl is-active -q airscribe-update.path || fail "Admin → Updates' updater isn't watching"
    [ -n "$(in_ct cat /var/lib/airscribe/update/running)" ] || fail "AirScribe didn't write the version it runs"
    updates=$(in_ct curl -s -b /tmp/jar "http://127.0.0.1:$PORT/api/admin/updates")
    grep -q '"whyNot":null' <<< "$updates" || fail "Admin → Updates says this install can't update itself: $updates"
    [ "$(in_ct stat -c %U /var/lib/airscribe/airscribe.sqlite)" = airscribe ] || fail "the database isn't AirScribe's"
    in_ct sh -c 'node --version; python3 --version; ffmpeg -hide_banner -decoders 2>/dev/null | grep -w sbc' ||
        fail "node, python3 or ffmpeg's SBC decoder is missing"
    log "template boot test passed"
    exit 0
fi

log "no Docker here: checking the template's files instead of booting it"
[ "$(id -u)" = 0 ] || fail "run as root (to unpack the template with its owners)"
work=$(mktemp -d)
trap 'rm -rf "$work" "$env_file"' EXIT
root=$work/rootfs
mkdir -p "$root"
zstd -dc --long=27 "$template" | tar -x -C "$root" --numeric-owner -p
test -f "$root/opt/airscribe/src/index.js" || fail "no AirScribe program"
test -d "$root/opt/airscribe/node_modules/express" || fail "no node_modules"
test ! -e "$root/opt/airscribe/node_modules/airscribe" || fail "node_modules links back to AirScribe itself"
test -x "$root/usr/bin/node" || fail "no Node"
test -x "$root/usr/bin/ffmpeg" || fail "no ffmpeg"
test -L "$root/etc/systemd/system/multi-user.target.wants/airscribe.service" || fail "the service isn't enabled"
test -L "$root/etc/systemd/system/multi-user.target.wants/airscribe-firstboot.service" || fail "first boot isn't armed"
test -L "$root/etc/systemd/system/multi-user.target.wants/airscribe-update.path" || fail "Admin → Updates' updater isn't armed"
test -x "$root/usr/lib/airscribe/airscribe-update" || fail "no updater"
test -f "$root/etc/airscribe/firstboot-pending" || fail "first boot isn't armed"
grep -q '"host": "0.0.0.0"' "$root/etc/airscribe/airscribe.config.json" || fail "it doesn't listen on the container's network"
! grep -q '"passwordHash": "scrypt' "$root/etc/airscribe/airscribe.config.json" || fail "the template has a password"
test ! -s "$root/etc/machine-id" || fail "the template has a machine ID"
! ls "$root"/etc/ssh/ssh_host_*_key >/dev/null 2>&1 || fail "the template has SSH host keys"
[ -z "$(ls -A "$root/var/lib/airscribe")" ] || fail "the template has AirScribe data"
[ "$(stat -c %U "$root/var/lib/airscribe" 2>/dev/null || true)" != root ] || fail "the data folder belongs to root"
[ -z "$(ls -A "$root/dev")" ] || fail "the template has device nodes"

log "running airscribe-firstboot in a chroot, with no password given"
printf 'AIRSCRIBE_PORT=%s\n' "$PORT" > "$root/etc/airscribe/firstboot.env"
for node in null:1:3 urandom:1:9; do
    IFS=: read -r n major minor <<< "$node"
    mknod -m 666 "$root/dev/$n" c "$major" "$minor"
done
chroot "$root" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/local/sbin/airscribe-firstboot
made=$(sed -n '/^Sign in with this password/{n;n;p}' "$root/root/airscribe-first-login.txt" | tr -d ' ')
[ ${#made} -eq 24 ] || fail "the first-login note has no 24-character password"
grep -q "\"port\": $PORT" "$root/etc/airscribe/airscribe.config.json" || fail "the port wasn't applied"
grep -q '"passwordHash": "scrypt\$' "$root/etc/airscribe/airscribe.config.json" || fail "no password hash"
! grep -q "$made" "$root/etc/airscribe/airscribe.config.json" || fail "the password is in the settings in plain text"
chroot "$root" /usr/bin/node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { verifyPassword } from '/opt/airscribe/src/auth.js';
  const c = JSON.parse(readFileSync('/etc/airscribe/airscribe.config.json', 'utf8'));
  process.exit(verifyPassword('$made', c.auth.passwordHash) ? 0 : 1);
" || fail "the password in the note doesn't match the hash in the settings"
test ! -e "$root/etc/airscribe/firstboot-pending" || fail "firstboot-pending is still there"
log "running it again keeps that password"
chroot "$root" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/local/sbin/airscribe-firstboot >/dev/null
! grep -q '^Sign in with this password' "$root/root/airscribe-first-login.txt" ||
    fail "a second run made another password instead of keeping the first"
log "template file test passed"
