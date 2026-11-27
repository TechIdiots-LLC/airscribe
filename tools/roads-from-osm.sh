#!/bin/sh
# Makes the roads, places and addresses for Admin → Findings → Roads (docs/findings.md#roads) from an OpenStreetMap
# .osm.pbf (an extract, or the whole planet) with osmium, and sends them to AirScribe when given its address.
#
# usage: tools/roads-from-osm.sh INPUT.osm.pbf WEST,SOUTH,EAST,NORTH OUT.geojsonseq [AIRSCRIBE_URL]
#   AIRSCRIBE_TOKEN in the environment: an admin token from AirScribe's settings file (auth.tokens), to send it.
# needs: osmium-tool (apt install osmium-tool), curl to send.
set -eu

[ $# -ge 3 ] || { sed -n '5,7p' "$0" >&2; exit 2; }
input=$1
box=$2
out=$3
url=${4:-}
echo "$box" | grep -Eq '^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$' ||
    { echo "$0: the box is WEST,SOUTH,EAST,NORTH in degrees, like -72.1,42.2,-71.6,42.5" >&2; exit 2; }
command -v osmium >/dev/null || { echo "$0: needs osmium (apt install osmium-tool)" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The area, with each road that crosses its edge kept whole; then the roads, towns, named places and addresses;
# then one of those a line
osmium extract --overwrite --bbox "$box" -o "$work/area.osm.pbf" "$input"
osmium tags-filter --overwrite -o "$work/kept.osm.pbf" "$work/area.osm.pbf" \
    w/highway nwr/place nwr/addr:housenumber \
    nwr/amenity nwr/shop nwr/leisure nwr/tourism nwr/office nwr/healthcare nwr/craft nwr/historic nwr/aeroway \
    nwr/emergency nwr/club nwr/building=school,hospital,church,college,university,fire_station
osmium export --overwrite -f geojsonseq --geometry-types=point,linestring,polygon -o "$out" "$work/kept.osm.pbf"
echo "$out: $(wc -l < "$out") features"

[ -n "$url" ] || exit 0
[ -n "${AIRSCRIBE_TOKEN:-}" ] || { echo "$0: set AIRSCRIBE_TOKEN to an admin token to send it" >&2; exit 1; }
curl -fsS -T "$out" -X PUT \
    -H "Authorization: Bearer $AIRSCRIBE_TOKEN" -H 'Content-Type: application/octet-stream' \
    "${url%/}/api/admin/findings/roads?name=$(basename "$out")"
echo
