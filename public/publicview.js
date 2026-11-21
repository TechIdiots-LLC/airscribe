// The public view: what a visitor who isn't signed in sees (docs/publishing.md).
//
// It knows nothing the server has not chosen to publish: the filters are the
// ones the server says exist, and the rows are already stripped and past the
// delay. Polled, not streamed: nothing arrives sooner than the delay.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

let timer = null;

/** @param {string} path - Under /api. @returns {Promise<any>} The parsed body. */
async function get(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/** @param {object} t - A public transmission row. @returns {HTMLElement} Its entry in the list. */
function render(t) {
  const when = new Date(t.started_at);
  const where = [t.channel_name, t.channel_hz ? `${(t.channel_hz / 1e6).toFixed(4)} MHz` : null]
    .filter(Boolean).join(' ');
  return el('li', {},
    el('div', { className: 'meta' },
      `${when.toLocaleString()} · ${(t.duration_ms / 1000).toFixed(1)}s`,
      t.radio ? ` · ${t.radio}` : '',
      where ? el('span', { className: 'chan' }, ` · ${where}`) : ''),
    el('div', { className: `tx-text ${t.text ? '' : 'pending'}` }, t.text || '(no transcript)'),
    // Only where clips are published; the link would 404 otherwise
    t.has_audio
      ? el('audio', { controls: true, preload: 'none', src: `/api/public/transmissions/${t.id}/audio` })
      : '');
}

/** @returns {Promise<void>} The list, for the filters as they are. */
async function load() {
  const params = new URLSearchParams();
  const group = $('public-group').value;
  const q = $('public-search').value.trim();
  if (group) params.set('group', group);
  if (q) params.set('q', q);
  const rows = await get(`/public/transmissions?${params}`);
  $('public-feed').replaceChildren(...rows.map(render));
  $('public-empty').hidden = rows.length > 0;
}

/**
 * Show the public view, where this node publishes anything.
 * @param {() => void} onSignIn - The Sign in button.
 * @returns {Promise<boolean>} False when nothing is published, so the page signs in instead.
 */
export async function showPublic(onSignIn) {
  const filters = await get('/public/filters').catch(() => ({ enabled: false }));
  if (!filters.enabled) return false;
  // Said, not hidden: a reader should know how far behind this is
  $('public-delay').textContent = filters.delayMinutes ? `${filters.delayMinutes} minutes behind` : 'as it happens';
  $('public-group').replaceChildren(
    el('option', { value: '' }, 'All'),
    ...filters.groups.map((g) => el('option', { value: g }, g)),
  );
  $('public-group').hidden = !filters.groups.length;
  $('public-group').onchange = () => load().catch(() => {});
  let typing;
  $('public-search').oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => load().catch(() => {}), 250);
  };
  $('public-signin').onclick = onSignIn;
  $('public-view').hidden = false;
  await load().catch((e) => {
    $('public-feed').replaceChildren(el('li', { className: 'tx-text error' }, e.message));
  });
  clearInterval(timer);
  timer = setInterval(() => load().catch(() => {}), 60_000);
  return true;
}

/** @returns {void} Gone, once signed in. */
export function hidePublic() {
  clearInterval(timer);
  timer = null;
  $('public-view').hidden = true;
}

/** @returns {boolean} Whether the public view is showing. */
export const publicShowing = () => !$('public-view').hidden;
