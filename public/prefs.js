// What one chooses on the pages (the Map's layers and tab, the feed's filters...), kept with the account signed in,
// so it follows them to another browser or to the server's other address; and in this browser, for before signing
// in and for a server without accounts. The pages read them from localStorage as before: the account's are copied
// there before any page script runs, as each imports this. See docs/accounts.md#choices-on-the-pages.

// Kept with the account. Not the sign-in, nor what belongs to this device: speaking findings aloud and its voice
const SYNCED = new Set([
  'airscribe.hideSilent', 'airscribe.mapStyle', 'airscribe.map.channels', 'airscribe.map.channelsHidden',
  'airscribe.map.radio', 'airscribe.map.inView', 'airscribe.map.hideSilent', 'airscribe.map.words', 'airscribe.map.tab',
  'airscribe.map.stations', 'airscribe.map.stationHours', 'airscribe.map.roads', 'airscribe.map.roadsHours',
  'airscribe.uniden.states', 'airscribe.channels.services',
]);
const SAVE_MS = 800;

let signedIn = false;      // an account's choices were read
const pending = {};
let timer = null;

const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** The account's choices, or null when this isn't an account's sign-in. */
async function fetchChoices() {
  try {
    const res = await fetch('/api/account/choices', { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Bring this browser into line with the account: its choices over this browser's, and those it hasn't made yet
 * taken from this browser (the first time, what was chosen here before carries over).
 * @returns {boolean} Whether anything here changed.
 */
function adopt(choices) {
  let changed = false;
  for (const k of SYNCED) {
    const here = local.get(k);
    if (Object.hasOwn(choices, k)) {
      if (here !== choices[k]) (local.set(k, choices[k]), changed = true);
    } else if (here !== null) {
      pending[k] = here;
    }
  }
  if (Object.keys(pending).length) save();
  return changed;
}

function save(now = false) {
  clearTimeout(timer);
  const send = () => {
    const body = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    if (!signedIn || !Object.keys(body).length) return;
    fetch('/api/account/choices', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
    }).catch(() => {});
  };
  if (now) send();
  else timer = setTimeout(send, SAVE_MS);
}

/**
 * A choice remembered: a fallback when there's none, or storage is blocked.
 * @param {string} key - Its key.
 * @param {string} fallback - Its default.
 * @returns {string} The choice.
 */
export function recall(key, fallback) {
  return local.get(key) ?? fallback;
}

/**
 * Remember a choice in this browser, and with the account when it's one kept there.
 * @param {string} key - Its key.
 * @param {string|null} value - The choice; null forgets it.
 */
export function keep(key, value) {
  // The pages write some as they start: only a change is sent
  if (local.get(key) === value) return;
  local.set(key, value);
  if (!signedIn || !SYNCED.has(key)) return;
  pending[key] = value;
  save();
}

// Before any page script reads them: a signed-in account's choices, copied here
const first = await fetchChoices();
if (first) {
  signedIn = true;
  adopt(first);
}

// Signed in on this page (the form, a second step): its choices, and the page again with them should they differ
document.addEventListener('airscribe:signed-in', async (e) => {
  if (signedIn || !e.detail?.user) return;
  const choices = await fetchChoices();
  if (!choices) return;
  signedIn = true;
  if (adopt(choices)) location.reload();
});
addEventListener('pagehide', () => save(true));
