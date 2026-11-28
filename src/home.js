/**
 * Where the radios are, near enough to list what's near them: RadioReference's ZIP code, else the middle of the
 * channels placed on the map.
 * @param {{radioreference?: object|null, store: import('./store.js').Store}} o - Where to look.
 * @returns {Promise<{lat: number, lon: number}|null>} The place; null when neither says.
 */
export async function homeOf({ radioreference, store }) {
  if (radioreference?.ready()) {
    const z = await radioreference.zipInfo().catch(() => null);
    if (Number.isFinite(z?.lat) && Number.isFinite(z?.lon)) return { lat: z.lat, lon: z.lon };
  }
  const placed = store.channelsSeen().filter((c) => c.lat !== null && c.lon !== null);
  if (!placed.length) return null;
  return { lat: placed.reduce((t, c) => t + c.lat, 0) / placed.length, lon: placed.reduce((t, c) => t + c.lon, 0) / placed.length };
}
