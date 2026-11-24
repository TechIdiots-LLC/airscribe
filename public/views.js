// Which page is showing: the feed, Insights, the Map, Packets, Admin or one's account,
// one at a time. A module of its own so every script shares the one switch.
// The page is kept in the address (#/map, #/admin, ...) so a reload stays on it and Back goes to the last one.
const VIEWS = ['main', 'insights', 'mapview', 'packets', 'findings', 'admin', 'account'];
const HASH = { main: '', mapview: 'map' };

const hashOf = (name) => `#/${HASH[name] ?? name}`;

/** @returns {string|null} The view the address names, if it names one (#signin, #invite=... aren't views). */
export function viewFromHash() {
  const m = /^#\/(\w*)$/.exec(location.hash);
  if (!m) return null;
  return VIEWS.find((v) => (HASH[v] ?? v) === m[1]) ?? null;
}

/** @returns {boolean} The view's header button is showing: this browser's sign-in may open it. */
export const offered = (name) => name === 'main'
  || [...document.querySelectorAll(`header [data-view="${name}"]`)].some((b) => !b.hidden);

/**
 * Show one view and hide the others. Pages that load on demand listen for
 * `airscribe:view`.
 * @param {string} name - 'main', 'insights', 'mapview', 'admin' or 'account'.
 * @param {'push' | 'replace' | 'none'} [history] - A new entry in the browser's history (Back returns), the current
 *   one changed, or the address left alone (Back or Forward brought it here).
 * @returns {void}
 */
export function showView(name, history = 'push') {
  for (const v of VIEWS) {
    const section = document.getElementById(v);
    if (section) section.hidden = v !== name;
  }
  for (const b of document.querySelectorAll('[data-view]')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  if (history !== 'none' && viewFromHash() !== name) {
    const url = name === 'main' ? location.pathname + location.search : hashOf(name);
    try {
      window.history[history === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
    } catch {
      // Some embedded browsers refuse: the page still switches
    }
  }
  document.dispatchEvent(new CustomEvent('airscribe:view', { detail: name }));
}

/** @returns {string} The view showing now. */
export const currentView = () => VIEWS.find((v) => document.getElementById(v)?.hidden === false) ?? 'main';

// The header's buttons, Admin's included, name the view they show
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-view]');
  if (b) showView(b.dataset.view);
});

// Back and Forward: the view the address names, where this sign-in may open it
window.addEventListener('popstate', () => {
  const name = location.hash ? viewFromHash() : 'main';
  if (name && name !== currentView() && offered(name)) {
    showView(name, 'none');
  }
});
