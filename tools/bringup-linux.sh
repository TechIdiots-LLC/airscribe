#!/usr/bin/env bash
# Checks an Ubuntu host is ready to run AirScribe against a real radio, and
# collects the facts the BlueZ backend needs. Read-only: it pairs nothing,
# connects nothing and never keys a transmitter.
#
#   ./tools/bringup-linux.sh              # environment only
#   ./tools/bringup-linux.sh AA:BB:CC:DD:EE:FF   # also inspect that radio
#
# The radio must already be paired (bluetoothctl: scan on / pair / trust).
# Remember it pairs as TWO devices, one MAC apart - pass either.

set -uo pipefail
MAC="${1:-}"
RADIO_UUID="39144315-32fa-40db-85ed-fbfeba2d86e6"
ok=0; warn=0

say()  { printf '%s\n' "$*"; }
head2(){ printf '\n== %s ==\n' "$*"; }
pass() { printf '  [ ok ] %s\n' "$*"; ok=$((ok+1)); }
fail() { printf '  [FAIL] %s\n' "$*"; warn=$((warn+1)); }

head2 "Host"
say "  $( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null || uname -s )"
say "  kernel $(uname -r)"

head2 "Runtimes"
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node')
  # node:sqlite arrived in 22.5; below it the store cannot open at all.
  node -e 'process.exit(require("node:module").builtinModules.includes("sqlite")?0:1)' 2>/dev/null \
    && pass "node $v (has node:sqlite)" \
    || fail "node $v is too old - node:sqlite needs 22.5+"
else
  fail "node not installed"
fi
command -v python3 >/dev/null && pass "$(python3 -V)" || fail "python3 not installed"

head2 "Bluetooth stack"
[ -d /sys/class/bluetooth ] && pass "/sys/class/bluetooth present" \
  || fail "no Bluetooth subsystem in this kernel (a container or WSL cannot do this)"
command -v bluetoothctl >/dev/null && pass "bluetoothctl present" \
  || fail "bluetoothctl missing - apt install bluez"
command -v sdptool >/dev/null && pass "sdptool present" \
  || fail "sdptool missing - apt install bluez-tools (needed to resolve RFCOMM channels)"
systemctl is-active --quiet bluetooth 2>/dev/null && pass "bluetooth.service running" \
  || fail "bluetooth.service not running"

head2 "Adapters"
if command -v hciconfig >/dev/null; then hciconfig -a 2>/dev/null | sed 's/^/  /'
else bluetoothctl list 2>/dev/null | sed 's/^/  /' || say "  (none found)"; fi

head2 "Can this user reach BlueZ over D-Bus?"
if bluetoothctl list >/dev/null 2>&1; then
  pass "yes, as $(id -un)"
else
  fail "no - a non-root service account needs a D-Bus policy for org.bluez"
fi

head2 "Python RFCOMM support"
python3 - <<'PY'
import socket
have = all(hasattr(socket, n) for n in ("AF_BLUETOOTH", "BTPROTO_RFCOMM"))
print(f"  [{' ok ' if have else 'FAIL'}] AF_BLUETOOTH / BTPROTO_RFCOMM")
try:
    socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM).close()
    print("  [ ok ] an RFCOMM socket can be created")
except OSError as e:
    print(f"  [FAIL] cannot create an RFCOMM socket: {e}")
PY

head2 "Known devices"
bluetoothctl devices 2>/dev/null | sed 's/^/  /' || say "  (none)"

if [ -n "$MAC" ]; then
  head2 "Radio $MAC"
  info=$(bluetoothctl info "$MAC" 2>/dev/null)
  if [ -z "$info" ]; then
    fail "not known to BlueZ - pair it first"
  else
    printf '%s\n' "$info" | grep -iE 'Name|Paired|Trusted|Connected|RSSI' | sed 's/^/  /'
    if printf '%s\n' "$info" | grep -qi "$RADIO_UUID"; then
      pass "advertises the BS AOC service - this is a supported radio"
    else
      fail "no BS AOC service ($RADIO_UUID) - not a supported radio, or SDP not yet cached"
    fi
    head2 "RFCOMM channels (what the backend must resolve via SDP)"
    if command -v sdptool >/dev/null; then
      sdptool browse "$MAC" 2>/dev/null \
        | grep -iE 'Service Name|Channel|UUID 128|Serial Port' | sed 's/^/  /' \
        || say "  (browse returned nothing - is the radio on and in range?)"
    else
      say "  sdptool missing, cannot browse"
    fi
  fi
fi

printf '\n== Summary ==\n  %d ok, %d need attention\n' "$ok" "$warn"
[ "$warn" -eq 0 ] || say "  Fix the failures above before expecting a radio to connect."
