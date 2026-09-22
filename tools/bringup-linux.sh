#!/usr/bin/env bash
# Checks an Ubuntu host is ready to run AirScribe against a real radio, and
# collects the facts the BlueZ backend needs. Read-only: it pairs nothing,
# connects nothing and never keys a transmitter.
#
#   ./tools/bringup-linux.sh              # environment only
#   ./tools/bringup-linux.sh AA:BB:CC:DD:EE:FF   # also inspect that radio
#
# The radio must already be paired (bluetoothctl: scan on / pair / trust).
# It may present more than one bond; pass whichever one `scan on` showed.

set -uo pipefail
MAC="${1:-}"
RADIO_UUID="39144315-32fa-40db-85ed-fbfeba2d86e6"
ok=0; warn=0

say()  { printf '%s\n' "$*"; }
head2(){ printf '\n== %s ==\n' "$*"; }
pass() { printf '  [ ok ] %s\n' "$*"; ok=$((ok+1)); }
fail() { printf '  [FAIL] %s\n' "$*"; warn=$((warn+1)); }
# Not every absence blocks a radio: sdptool is a diagnostic, so its absence is
# worth mentioning without counting against the summary.
note() { printf '  [note] %s\n' "$*"; }

head2 "Host"
say "  $( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null || uname -s )"
say "  kernel $(uname -r)"

head2 "Runtimes"
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node')
  # node:sqlite arrived in 22.5; below it the store cannot open at all.
  # Load it rather than looking in builtinModules, which omits experimental
  # modules and so reports "missing" on every version, including 24.
  node -e 'try{require("node:sqlite")}catch(e){process.exit(1)}' 2>/dev/null \
    && pass "node $v (node:sqlite loads)" \
    || fail "node $v cannot load node:sqlite - needs 22.5+"
else
  fail "node not installed"
fi
command -v python3 >/dev/null && pass "$(python3 -V)" || fail "python3 not installed"
# The radio sends SBC; without a decoder a radio connects and transcribes
# nothing. Having ffmpeg is not enough - a build can omit the codec.
if command -v ffmpeg >/dev/null; then
  if ffmpeg -hide_banner -decoders 2>/dev/null | awk '{print $2}' | grep -qx sbc; then
    pass "ffmpeg has the SBC decoder"
  else
    fail "ffmpeg is installed but has no SBC decoder - audio cannot be decoded"
  fi
else
  fail "ffmpeg not installed - apt install ffmpeg (needed to decode radio audio)"
fi

head2 "Bluetooth stack"
[ -d /sys/class/bluetooth ] && pass "/sys/class/bluetooth present" \
  || fail "no Bluetooth subsystem in this kernel (a container or WSL cannot do this)"
command -v bluetoothctl >/dev/null && pass "bluetoothctl present" \
  || fail "bluetoothctl missing - apt install bluez"
command -v sdptool >/dev/null && pass "sdptool present" \
  || note "sdptool missing (apt install bluez-tools) - a diagnostic only"
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
    head2 "RFCOMM channels"
    # SDP browsing is a diagnostic here, not how the backend finds channels:
    # it needs a live link, and BlueZ's Connect() refuses to leave one
    # standing for these radios. Probing is the real mechanism.
    if printf '%s\n' "$info" | grep -qi 'Connected: yes'; then
      if command -v sdptool >/dev/null; then
        out=$(sdptool browse "$MAC" 2>&1)
        if printf '%s\n' "$out" | grep -qiE 'Channel|Service Name'; then
          printf '%s\n' "$out" | grep -iE 'Service Name|Channel|UUID 128' | sed 's/^/  /'
        else
          say "  sdptool browsed nothing useful (expected against these radios)"
        fi
      else
        say "  sdptool missing, cannot browse"
      fi
    else
      say "  radio not connected, so SDP cannot be browsed - this is fine."
    fi
    say "  Find the channels the way the backend does:"
    say "      python3 tools/probe-aoc.py $MAC --discover"
  fi
fi

printf '\n== Summary ==\n  %d ok, %d need attention\n' "$ok" "$warn"
[ "$warn" -eq 0 ] || say "  Fix the failures above before expecting a radio to connect."
