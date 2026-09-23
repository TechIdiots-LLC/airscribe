// The public page.
//
// It carries no credential and knows nothing the server has not chosen to
// publish: the filters it offers are the ones the server says exist, and the
// rows are already stripped and already past the delay. There is no live
// event stream here — a public page that updated the instant a transmission
// ended would defeat the delay it is polling behind.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

let filters = { enabled: false, audio: false, delayMinutes: 0 };

/**
 * @param {string} path - API path under /api.
 * @returns {Promise<any>} The parsed body.
 */
async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/**
 * @param {object} t - A public transmission row.
 * @returns {HTMLElement} Its entry in the feed.
 */
function render(t) {
  const when = new Date(t.started_at);
  const where = [t.channel_name, t.channel_hz ? `${(t.channel_hz / 1e6).toFixed(4)} MHz` : null]
    .filter(Boolean).join(' ');
  return el('li', {},
    el('div', { className: 'meta' },
      `${when.toLocaleString()} · ${(t.duration_ms / 1000).toFixed(1)}s`,
      t.radio ? ` · ${t.radio}` : '',
      where ? el('span', { className: 'chan' }, ` · ${where}`) : ''),
    el('div', { className: `tx-text ${t.text ? '' : 'pending'}` },
      t.text || '(no transcript)'),
    // Offered only where the server says clips are published; the link would
    // 404 otherwise, and a dead link is worse than none.
    t.has_audio
      ? el('audio', { controls: true, preload: 'metadata',
                      src: `/api/public/transmissions/${t.id}/audio` })
      : '');
}

/** @returns {Promise<void>} Fetch and draw the current view. */
async function load() {
  const params = new URLSearchParams();
  const group = $('filter-group').value;
  const q = $('search').value.trim();
  if (group) params.set('group', group);
  if (q) params.set('q', q);
  const rows = await api(`/public/transmissions?${params}`);
  $('feed').replaceChildren(...rows.map(render));
  $('empty').hidden = rows.length > 0;
}

/** @returns {Promise<void>} Set the page up from what the server publishes. */
async function boot() {
  filters = await api('/public/filters');
  if (!filters.enabled) {
    $('off').hidden = false;
    $('feed-panel').hidden = true;
    return;
  }
  // Stated rather than hidden: a reader should know they are not watching
  // live traffic, and roughly how far behind they are.
  $('delay').textContent = filters.delayMinutes
    ? `delayed ${filters.delayMinutes} min`
    : 'live';
  $('filter-group').replaceChildren(
    el('option', { value: '' }, 'All'),
    ...filters.groups.map((g) => el('option', { value: g }, g)),
  );
  $('filter-group').onchange = load;
  let typing;
  $('search').oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(load, 250);
  };
  await load();
  // Polled rather than streamed. Nothing arrives sooner than the delay, so
  // a minute is frequent enough and costs the server almost nothing.
  setInterval(load, 60_000);
}

boot().catch((e) => {
  $('feed-panel').hidden = true;
  $('off').hidden = false;
  $('off').replaceChildren(
    el('h2', {}, 'Unavailable'),
    el('p', { className: 'meta' }, e.message),
  );
});
