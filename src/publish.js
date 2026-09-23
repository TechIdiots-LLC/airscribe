/**
 * What a public visitor may see.
 *
 * One predicate, applied to the page, the list, the feed and every download.
 * Filtering a listing while leaving `/api/transmissions/1284/audio` fetchable
 * would hand the newest traffic to anyone counting upwards, so the rule lives
 * here rather than being spelled out per route.
 *
 * Three gates, and all of them default closed:
 *
 *   publish.enabled   is there a public surface at all
 *   radio.public      is this radio's traffic published
 *   delayMinutes      has enough time passed since it happened
 */

/** Publishing is off, and every sub-switch closed, until said otherwise. */
export const PUBLISH_DEFAULTS = {
  enabled: false,
  transcripts: true,
  audio: false,
  feed: true,
  delayMinutes: 30,
};

/**
 * The instant up to which transmissions may be shown publicly.
 *
 * Expressed as a cut-off rather than a per-row check so a query can apply it,
 * which keeps the delay from depending on every caller remembering it.
 * @param {object} publish - The `publish` config section.
 * @param {number} [now] - The current time, for testing.
 * @returns {number} A timestamp; transmissions at or before it are eligible.
 */
export function publicCutoff(publish = {}, now = Date.now()) {
  const minutes = Number(publish.delayMinutes ?? PUBLISH_DEFAULTS.delayMinutes);
  return now - Math.max(0, minutes) * 60_000;
}

/**
 * Whether one transmission may be shown publicly.
 * @param {object} row - A transmission row.
 * @param {object | undefined} radio - Its radio, or undefined if forgotten.
 * @param {object} publish - The `publish` config section.
 * @param {number} [now] - The current time, for testing.
 * @returns {boolean} True when a public visitor may see it.
 */
export function publishable(row, radio, publish = {}, now = Date.now()) {
  if (!publish.enabled) return false;
  // A radio that was removed takes its traffic out of the public view with
  // it: there is no longer anything saying it was meant to be published.
  if (!radio?.public) return false;
  return Boolean(row) && row.started_at <= publicCutoff(publish, now);
}

/**
 * Strip a transmission down to what a public visitor is allowed.
 *
 * The audio path is dropped unless clips are published, and the transcripts
 * are reduced to the default engine's. Which model reads best is an
 * operator's question; publishing three disagreeing versions of what somebody
 * said is worse than publishing one.
 * @param {object} row - A transmission row, with transcripts.
 * @param {object} publish - The `publish` config section.
 * @param {string | null} [primary] - The default engine's name.
 * @returns {object} A row safe to serve publicly.
 */
export function publicView(row, publish = {}, primary = null) {
  const scripts = row.transcripts ?? [];
  const chosen = scripts.find((t) => t.engine === primary && t.status === 'done')
    ?? scripts.find((t) => t.status === 'done')
    ?? null;
  return {
    id: row.id,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    transmit: row.transmit,
    channel: row.channel,
    channel_name: row.channel_name,
    channel_hz: row.channel_hz,
    radio: row.radio_name ?? null,
    group: row.radio_group ?? null,
    source: row.source ?? null,
    text: publish.transcripts === false ? null : (chosen?.text ?? null),
    // Named so a reader knows which model produced it, but never the whole
    // set: the disagreement between engines is not a public matter.
    engine: publish.transcripts === false ? null : (chosen?.engine ?? null),
    has_audio: Boolean(publish.audio),
  };
}
