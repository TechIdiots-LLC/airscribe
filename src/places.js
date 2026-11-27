/**
 * Places and addresses, from OpenStreetMap or an address file, for Findings (docs/findings.md#places-and-addresses):
 * the businesses, schools and towns a transmission names, and the house numbers each street has, so a misheard
 * place comes back as the one that's there, a house number can be checked, and the Map can put a pin on it.
 */
import { words } from './roads.js';

// OpenStreetMap's place=, for the towns and the parts of them people say ("Burncoat", "Orchard Grove")
export const TOWNS = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter', 'borough']);
// The keys a named place is a business, school, hall or the like by
const KINDS = ['amenity', 'shop', 'leisure', 'tourism', 'office', 'healthcare', 'craft', 'historic', 'aeroway',
  'public_transport', 'railway', 'emergency', 'club', 'man_made', 'building'];
// Named but not a place anyone is sent to
const SKIP = /^(bench|waste_basket|vending_machine|bicycle_parking|post_box|telephone|clock|drinking_water|hydrant|yes|platform|stop_position|tower|mast|pole|survey_point|street_cabinet|utility_pole)$/;

/** The middle of a geometry, [lon, lat]: a point's own, a line's middle vertex, a polygon's outer ring's mean. */
export function middle(g) {
  if (!g) return null;
  const ring = g.type === 'Point' ? [g.coordinates]
    : g.type === 'LineString' ? [g.coordinates[Math.floor(g.coordinates.length / 2)]]
    : g.type === 'MultiPoint' ? g.coordinates
    : g.type === 'Polygon' ? g.coordinates[0]
    : g.type === 'MultiPolygon' ? g.coordinates[0]?.[0]
    : null;
  const pts = (ring ?? []).filter((c) => Number.isFinite(c?.[0]) && Number.isFinite(c?.[1]));
  if (!pts.length) return null;
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return [round(pts.reduce((s, c) => s + c[0], 0) / pts.length), round(pts.reduce((s, c) => s + c[1], 0) / pts.length)];
}

/**
 * A town, or a named business, school or the like, from OpenStreetMap's tags.
 * @param {object} tags - Its tags.
 * @param {[number, number]|null} at - [lon, lat].
 * @returns {{kind: 'town'|'place', name: string, key: string, class: string, street: string|null, lon: number,
 *   lat: number}|null} It, or null for anything else.
 */
export function place(tags, at) {
  const name = String(tags?.name ?? '').trim();
  if (!name || !at || tags.highway) return null;
  const key = words(name);
  if (!key) return null;
  if (TOWNS.has(tags.place)) return { kind: 'town', name, key, class: tags.place, street: null, lon: at[0], lat: at[1] };
  const k = KINDS.find((x) => tags[x] && !SKIP.test(tags[x]));
  if (!k) return null;
  const cls = k === 'building' || tags[k] === 'yes' ? k : tags[k];
  return { kind: 'place', name, key, class: String(cls), street: tags['addr:street'] ? String(tags['addr:street']).trim() : null, lon: at[0], lat: at[1] };
}

/** A house number as kept: "16", "16a"; null for what isn't one. */
export function houseNumber(s) {
  const m = /^\s*(\d{1,6})\s*([a-z])?\s*$/i.exec(String(s ?? ''));
  return m ? `${Number(m[1])}${(m[2] ?? '').toLowerCase()}` : null;
}

/**
 * The addresses of a building or point: OpenStreetMap's addr:housenumber and addr:street, or an address file's
 * number and street (OpenAddresses' names); a number like "16;18" or "16-18" is each of them.
 * @param {object} p - Its tags or properties.
 * @param {[number, number]|null} at - [lon, lat].
 * @returns {{number: string, street: string, key: string, town: string|null, lon: number, lat: number}[]}
 */
export function addresses(p, at) {
  const num = p?.['addr:housenumber'] ?? p?.number ?? p?.NUMBER;
  const street = String(p?.['addr:street'] ?? p?.street ?? p?.STREET ?? '').trim();
  if (num === undefined || num === null || !street || !at) return [];
  const key = words(street);
  if (!key) return [];
  const town = String(p['addr:city'] ?? p.city ?? p.CITY ?? '').trim() || null;
  const parts = String(num).split(/[;,]/).flatMap((s) => {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(s);
    return range ? [range[1], range[2]] : [s];
  });
  return [...new Set(parts.map(houseNumber).filter(Boolean))].map((number) => ({ number, street, key, town, lon: at[0], lat: at[1] }));
}

/**
 * What a GeoJSON feature holds besides a road: a town or place, and its addresses.
 * @param {object} f - The feature (osmium's export, OpenAddresses, overpass turbo...).
 * @returns {{place: object|null, addresses: object[]}}
 */
export function fromFeature(f) {
  const p = f?.properties ?? {};
  const tags = p.tags && typeof p.tags === 'object' ? p.tags : p;
  const at = middle(f?.geometry);
  return { place: place(tags, at), addresses: addresses(tags, at) };
}

/** An Overpass element with `out tags center` (or a node's own place), the same. */
export function fromOverpass(e) {
  const at = e?.type === 'node' ? [e.lon, e.lat] : e?.center ? [e.center.lon, e.center.lat] : null;
  const c = at && Number.isFinite(at[0]) && Number.isFinite(at[1]) ? at : null;
  return { place: place(e?.tags ?? {}, c), addresses: addresses(e?.tags ?? {}, c) };
}

/** A point feature of OpenMapTiles' poi or place layer, the same: its class stands for OSM's tag. */
export function fromTile(layer, props, at) {
  if (layer === 'place') return { place: place({ name: props.name ?? props.name_en, place: props.class }, at), addresses: [] };
  const cls = props.subclass ?? props.class;
  return { place: place({ name: props.name ?? props.name_en, amenity: cls }, at), addresses: [] };
}
