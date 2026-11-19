// An SDS150 over Bluetooth: its screen as it changes, its keys, and its waterfall, as Uniden's U/AWARE app has
// them. Opened from the scanner's Screen button (app.js). Admins only; the server checks again. The screen and
// waterfall come on the event stream; keys are posted. docs/scanners.md has the protocol.
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== ''));
  return e;
};

/** The same credential app.js uses: a session cookie, or a stored token. */
function withToken(path) {
  let token = '';
  try { token = localStorage.getItem('airscribe.token') ?? ''; } catch { /* storage blocked */ }
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
}

async function api(path, opts = {}) {
  const res = await fetch(withToken(`/api${path}`), {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  return body;
}

const mhz = (hz) => (hz / 1e6).toFixed(4);
const UNTRIED = 'Uniden\'s code for this key on its other scanners; not yet tried on an SDS150';
// [label, key code, tried]: as the scanner's keys lie, the knob's turn and push at the bottom
const KEYPAD = [
  ['Menu', 'M', true], ['Func', 'F', true], ['Avoid', 'L', false],
  ['1', '1', true], ['2', '2', true], ['3', '3', true],
  ['4', '4', true], ['5', '5', true], ['6', '6', true],
  ['7', '7', true], ['8', '8', true], ['9', '9', true],
  ['. No', '.', true], ['0', '0', true], ['E Yes', 'E', true],
  ['◀', '<', true], ['Push', '^', false], ['▶', '>', true],
  ['Vol', 'V', false], ['Sql', 'Q', false], ['Replay', 'Y', false],
  ['ZIP', 'Z', true], ['Service', 'T', false],
];

let dlg = null;
let radio = null;
let parts = {};
let waterfallOn = false;
let waterfallTimer = null;
let span = null;        // the waterfall's scale, from the screen
let lo = null;          // the levels' running range, for the colours
let hi = null;
let pressedAt = 0;

function build() {
  parts = {
    title: el('h3', {}),
    screen: el('div', { className: 'sds-screen', title: 'Scroll here to turn the knob' }),
    soft: el('div', { className: 'sds-soft' }),
    keys: el('div', { className: 'sds-keys' }),
    status: el('p', { className: 'meta sds-status' }),
    wfButton: el('button', { onclick: () => setWaterfall(!waterfallOn) }, 'Waterfall'),
    wfScale: el('div', { className: 'meta sds-scale' }),
    canvas: el('canvas', { className: 'sds-waterfall', width: 240, height: 160, hidden: true }),
  };
  for (const [label, key, tried] of KEYPAD) {
    parts.keys.append(keyButton(label, key, tried));
  }
  parts.screen.addEventListener('wheel', onWheel, { passive: false });
  dlg = el('dialog', { id: 'scanner-dlg', className: 'scanner-dlg', onclose: closed },
    el('div', { className: 'row' }, parts.title, el('span', { className: 'spacer' }),
      el('button', { onclick: () => dlg.close() }, 'Close')),
    parts.screen, parts.soft, parts.keys,
    el('div', { className: 'row sds-wf-row' }, parts.wfButton, parts.wfScale),
    parts.canvas, parts.status);
  document.body.append(dlg);
}

function keyButton(label, key, tried) {
  return el('button', {
    type: 'button', className: tried ? '' : 'untried', title: tried ? `Key ${key}` : `Key ${key}: ${UNTRIED}`,
    onpointerdown: () => { pressedAt = performance.now(); },
    // Held as long as it was held here, as the scanner tells a press from a long press
    onclick: () => {
      const held = pressedAt ? performance.now() - pressedAt : 100;
      pressedAt = 0;
      press(key, Math.min(3000, Math.max(100, Math.round(held))));
    },
  }, label);
}

async function press(key, holdMs = 100) {
  if (!radio) return;
  try {
    await api(`/radios/${radio.mac}/key`, { method: 'POST', body: { key, hold_ms: holdMs } });
    parts.status.textContent = '';
  } catch (e) {
    parts.status.textContent = e.message;
  }
}

let wheelAt = 0;
function onWheel(e) {
  e.preventDefault();
  const now = performance.now();
  if (now - wheelAt < 120 || !e.deltaY) return;
  wheelAt = now;
  press(e.deltaY > 0 ? '>' : '<');
}

/** One line of the screen: highlighted where its mode string says ('*' reversed, '_' underlined). */
function line(l) {
  const div = el('div', { className: `sds-line${l.large ? ' large' : ''}` });
  const text = l.text ?? '';
  let run = '';
  let kind = null;
  const flush = () => {
    if (!run) return;
    div.append(kind ? el('span', { className: kind }, run) : document.createTextNode(run));
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // The scanner's own font: icons and large digits, two codes each. Shown as a mark, not guessed at
    const glyph = code < 0x20 || code > 0x7e;
    const m = l.mode?.[i];
    const k = glyph ? 'glyph' : m === '*' ? 'inv' : m === '_' ? 'ul' : null;
    if (k !== kind) { flush(); kind = k; }
    run += glyph ? '▪' : text[i];
  }
  flush();
  if (!text.trim()) div.append(' ');
  return div;
}

/** The soft keys' labels: the screen's last line with highlighted stretches, one per key. */
function softKeys(screen) {
  const last = [...(screen?.lines ?? [])].reverse().find((l) => (l.mode ?? '').includes('*'));
  const labels = [];
  if (last) {
    for (const m of last.mode.matchAll(/\*+/g)) labels.push(last.text.slice(m.index, m.index + m[0].length).trim());
  }
  parts.soft.replaceChildren(...['A', 'B', 'C'].map((key, i) =>
    keyButton(labels[i] || `Soft ${i + 1}`, key, false)));
}

function draw(screen) {
  if (!screen) {
    parts.screen.replaceChildren(el('div', { className: 'sds-line' }, 'Waiting for the scanner\'s screen…'));
    return;
  }
  parts.screen.replaceChildren(...screen.lines.map(line));
  parts.screen.classList.toggle('muted', !!screen.muted);
  softKeys(screen);
  span = screen.waterfall ?? null;
  parts.wfScale.textContent = span?.lower_hz
    ? `${mhz(span.lower_hz)} – ${mhz(span.upper_hz)} MHz · ${span.mod ?? ''}${span.hz ? ` · marker ${mhz(span.hz)}` : ''}`
    : waterfallOn ? 'Put the scanner in its waterfall mode to see a span' : '';
}

/** A waterfall row: the newest at the top, coloured by level within the range seen so far. */
function drawRow(levels) {
  const c = parts.canvas;
  const g = c.getContext('2d');
  g.drawImage(c, 0, 0, c.width, c.height - 1, 0, 1, c.width, c.height - 1);
  const row = g.createImageData(c.width, 1);
  const bytes = Uint8Array.from(atob(levels), (ch) => ch.charCodeAt(0));
  for (const v of bytes) {
    lo = lo === null ? v : Math.min(v, lo + 0.02);
    hi = hi === null ? v : Math.max(v, hi - 0.02);
  }
  for (let x = 0; x < c.width; x++) {
    const t = Math.max(0, Math.min(1, (bytes[x] - lo) / Math.max(8, hi - lo)));
    // Dark blue, to cyan, to yellow, to white
    const [r, gr, b] = t < 0.33 ? [0, t * 3 * 160, 60 + t * 3 * 160]
      : t < 0.66 ? [(t - 0.33) * 3 * 255, 160 + (t - 0.33) * 3 * 95, 220 - (t - 0.33) * 3 * 220]
        : [255, 255, (t - 0.66) * 3 * 255];
    row.data.set([r, gr, b, 255], x * 4);
  }
  g.putImageData(row, 0, 0);
  if (span?.marker !== null && span?.marker !== undefined) {
    g.fillStyle = 'rgba(255, 80, 80, 0.9)';
    g.fillRect(span.marker, 0, 1, 1);
  }
}

async function askForWaterfall(seconds) {
  if (!radio) return;
  try {
    await api(`/radios/${radio.mac}/waterfall`, { method: 'POST', body: { seconds } });
  } catch (e) {
    parts.status.textContent = e.message;
  }
}

function setWaterfall(on) {
  waterfallOn = on;
  parts.wfButton.classList.toggle('on', on);
  parts.canvas.hidden = !on;
  clearInterval(waterfallTimer);
  waterfallTimer = null;
  if (on) {
    // Asked for 15 s at a time, again every 10 s while it's showing, so it stops on its own if the page goes
    askForWaterfall(15);
    waterfallTimer = setInterval(() => askForWaterfall(15), 10000);
  } else if (radio) {
    askForWaterfall(0);
  }
}

function closed() {
  if (waterfallOn) setWaterfall(false);
  radio = null;
}

async function open(r) {
  if (!dlg) build();
  radio = r;
  lo = hi = null;
  parts.title.textContent = r.name;
  parts.status.textContent = '';
  draw(null);
  dlg.showModal();
  try {
    const { screen } = await api(`/radios/${r.mac}/screen`);
    if (radio === r && screen) draw(screen);
  } catch (e) {
    parts.status.textContent = e.message;
  }
}

document.addEventListener('airscribe:open-scanner', (e) => open(e.detail));
document.addEventListener('airscribe:scanner-screen', (e) => {
  if (radio && e.detail.mac === radio.mac) draw(e.detail.screen);
});
document.addEventListener('airscribe:scanner-waterfall', (e) => {
  if (radio && waterfallOn && e.detail.mac === radio.mac) drawRow(e.detail.levels);
});
