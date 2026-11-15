// Which page is showing: the feed, Insights, the Map or Admin, one at a time. A
// module of its own so every script shares the one switch.
const VIEWS = ['main', 'insights', 'mapview', 'admin'];

/**
 * Show one view and hide the others. Pages that load on demand listen for
 * `airscribe:view`.
 * @param {string} name - 'main', 'insights', 'mapview' or 'admin'.
 * @returns {void}
 */
export function showView(name) {
  for (const v of VIEWS) {
    const section = document.getElementById(v);
    if (section) section.hidden = v !== name;
  }
  for (const b of document.querySelectorAll('[data-view]')) {
    b.classList.toggle('active', b.dataset.view === name);
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
