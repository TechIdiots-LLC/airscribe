/**
 * Radios HTCommander supports, and the only place a model is described.
 * Adding a radio is a new row here; nothing else branches on model, except on
 * `link`: a model with `link: 'radiocli'` isn't reached over Bluetooth but
 * sends its recordings in, a transmission at a time (docs/scanners.md).
 *
 * `match` is a case-insensitive fragment of the Bluetooth name the radio
 * advertises. These fragments are guesses from the model names, not captured
 * advertisements, so the UI always lets the operator pick the model by hand.
 * `tested` follows the upstream README, which marks several as untested.
 */
export const MODELS = [
  // The UV-Pro is the reference radio: BenLink's original target, the best
  // tested upstream, and the one this project is developed against.
  { id: 'uv-pro', vendor: 'BTech', name: 'UV-Pro', match: ['UV-PRO'], tested: true },
  { id: 'uv-50pro', vendor: 'BTech', name: 'UV-50Pro', match: ['UV-50PRO'], tested: false },
  { id: 'ga-5wb', vendor: 'Radioddity', name: 'GA-5WB', match: ['GA-5WB'], tested: false },
  { id: 'db50-b', vendor: 'Radioddity', name: 'DB50-B Mini', match: ['DB50-B'], tested: true },
  { id: 'rt-660', vendor: 'Radtel', name: 'RT-660', match: ['RT-660'], tested: false },
  { id: 'vr-n75', vendor: 'Vero', name: 'VR-N75', match: ['VR-N75'], tested: true },
  { id: 'vr-n76', vendor: 'Vero', name: 'VR-N76', match: ['VR-N76'], tested: false },
  { id: 'vr-n7500', vendor: 'Vero', name: 'VR-N7500', match: ['VR-N7500'], tested: false },
  { id: 'vr-n7600', vendor: 'Vero', name: 'VR-N7600', match: ['VR-N7600'], tested: true },
  // Uniden scanners, through radiocli (github.com/albeebe/radiocli), which records each transmission from the
  // headphone socket with what the scanner says it is; radiocli has been tried on an SDS150 only
  { id: 'sds150', vendor: 'Uniden', name: 'SDS150', match: [], tested: false, link: 'radiocli' },
  { id: 'sds100', vendor: 'Uniden', name: 'SDS100', match: [], tested: false, link: 'radiocli' },
  { id: 'sds200', vendor: 'Uniden', name: 'SDS200', match: [], tested: false, link: 'radiocli' },
];

/**
 * @param {string|null|undefined} id - A model id.
 * @returns {boolean} Whether that model sends recordings in rather than being connected to.
 */
export const sendsRecordings = (id) => MODELS.some((m) => m.id === id && m.link === 'radiocli');

/**
 * An id for a scanner, which has no Bluetooth address of its own: shaped like one, as radios are keyed by
 * their address throughout, with the locally administered bit set (02:...) so it can't be a real radio's.
 * @returns {string} A new id.
 */
export function newScannerId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  b[0] = 0x02;
  return [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/**
 * Guess a model from an advertised Bluetooth name.
 * @param {string} name - The advertised device name.
 * @returns {string | null} A model id, or null when nothing matches.
 */
export function guessModel(name) {
  const n = String(name ?? '').toUpperCase();
  // Longest fragment first so VR-N7500 is not taken for VR-N75.
  const rows = MODELS.flatMap((m) => m.match.map((f) => [f, m.id])).sort(
    (a, b) => b[0].length - a[0].length,
  );
  return rows.find(([f]) => n.includes(f))?.[1] ?? null;
}

/**
 * Normalise a MAC address to upper-case, colon-separated form.
 * @param {string} mac - Any of AA:BB:.., AA-BB-.., or AABB...
 * @returns {string | null} The normalised MAC, or null if malformed.
 */
export function normalizeMac(mac) {
  const hex = String(mac ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}
