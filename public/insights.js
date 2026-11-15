// Insights: what was said and when. Loaded when the view is opened, and every
// minute while it stays open.
import { currentView, showView } from './views.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const svg = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** The same credential app.js uses: a session cookie, or a stored token. */
function withToken(path) {
  let token = '';
  try { token = localStorage.getItem('airscribe.token') ?? ''; } catch { /* storage blocked */ }
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
}

async function api(path) {
  const res = await fetch(withToken(`/api${path}`));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const HOUR = 60 * 60 * 1000;
const plural = (n, one) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

/** @param {number} ms - A duration. @returns {string} It, readably. */
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const hourLabel = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });
const dayLabel = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/**
 * Show the feed, filtered as Insights is, and optionally searched.
 * @param {{word?: string, channel?: string}} f - What to find.
 * @returns {void}
 */
function openFeed({ word = '', channel = $('ins-channel').value }) {
  $('filter-radio').value = $('ins-radio').value;
  $('filter-channel').value = channel;
  $('search').value = word;
  // The feed reloads on its search box's input, reading every filter
  $('search').dispatchEvent(new Event('input'));
  showView('main');
}

function renderWords(words) {
  if (!words.length) {
    return $('ins-words').replaceChildren(el('p', { className: 'meta' }, 'No transcripts in this range.'));
  }
  // Sized by how often, on a log scale so a few very common words don't
  // shrink the rest to nothing; in alphabetical order, so a word can be found
  const hi = Math.log(words[0].count + 1);
  const lo = Math.log(words.at(-1).count + 1);
  $('ins-words').replaceChildren(...[...words].sort((a, b) => a.word.localeCompare(b.word)).map((w) => {
    const f = hi === lo ? 1 : (Math.log(w.count + 1) - lo) / (hi - lo);
    const b = el('button', {
      className: `word w${Math.min(3, Math.floor(f * 4))}`,
      title: `${plural(w.count, 'time')}: find it in the feed`,
      onclick: () => openFeed({ word: w.word }),
    }, w.word);
    b.style.fontSize = `${Math.round(12 + f * 26)}px`;
    return b;
  }));
}

/** Transmissions per hour for a day, per local day for longer. */
function renderActivity(r, days) {
  const perHour = new Map(r.hourly.map((h) => [h.hour, h.count]));
  const buckets = [];
  if (days === 1) {
    const last = Math.floor(Date.now() / HOUR) * HOUR;
    for (let t = last - 23 * HOUR; t <= last; t += HOUR) {
      buckets.push({ label: hourLabel(t), title: `${dayLabel(t)} ${hourLabel(t)}`, count: perHour.get(t) ?? 0 });
    }
  } else {
    const perDay = new Map();
    for (const h of r.hourly) perDay.set(dayKey(h.hour), (perDay.get(dayKey(h.hour)) ?? 0) + h.count);
    const d = new Date(days > 0 ? Date.now() - (days - 1) * 24 * HOUR : (r.hourly[0]?.hour ?? Date.now()));
    d.setHours(0, 0, 0, 0);
    for (; d.getTime() <= Date.now(); d.setDate(d.getDate() + 1)) {
      const t = d.getTime();
      buckets.push({ label: dayLabel(t), title: new Date(t).toLocaleDateString(), count: perDay.get(dayKey(t)) ?? 0 });
    }
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const w = 10;
  const chart = svg('svg', { class: 'bars', viewBox: `0 0 ${buckets.length * w} 100`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': `Transmissions per ${days === 1 ? 'hour' : 'day'}` },
  ...buckets.map((b, i) => {
    const h = (b.count / max) * 96;
    return svg('rect', { x: i * w + 1, y: 100 - h, width: w - 2, height: Math.max(h, b.count ? 1 : 0) },
      svg('title', {}, `${b.title}: ${plural(b.count, 'transmission')}`));
  }));
  const mid = buckets[Math.floor(buckets.length / 2)];
  $('ins-activity').replaceChildren(
    el('div', { className: 'meta' }, `Most in one ${days === 1 ? 'hour' : 'day'}: ${max === 1 && !buckets.some((b) => b.count) ? 0 : max}`),
    chart,
    el('div', { className: 'axis' }, el('span', {}, buckets[0]?.label ?? ''), el('span', {}, mid?.label ?? ''),
      el('span', {}, buckets.at(-1)?.label ?? '')));
}

/** Which weekdays and hours are busy, over a week or more. */
function renderHeat(r) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const h of r.hourly) {
    const d = new Date(h.hour);
    grid[(d.getDay() + 6) % 7][d.getHours()] += h.count;
  }
  const max = Math.max(1, ...grid.flat());
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const at = (hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return hourLabel(d.getTime()); };
  const cells = [el('span', {}),
    ...Array.from({ length: 24 }, (_, hr) => el('span', { className: 'hr' }, hr % 3 === 0 ? at(hr) : ''))];
  grid.forEach((row, day) => {
    cells.push(el('span', { className: 'day' }, names[day]));
    row.forEach((n, hr) => {
      const cell = el('span', { className: 'cell', title: `${names[day]} ${at(hr)}: ${plural(n, 'transmission')}` });
      if (n) {
        const fill = el('span', {});
        fill.style.opacity = String(0.15 + 0.85 * (n / max));
        cell.append(fill);
      }
      cells.push(cell);
    });
  });
  $('ins-heat').replaceChildren(el('div', { className: 'heat' }, ...cells));
}

function renderChannels(r) {
  if (!r.channels.length) return $('ins-channels').replaceChildren(el('p', { className: 'meta' }, 'Nothing in this range.'));
  const most = Math.max(...r.channels.map((c) => c.count));
  $('ins-channels').replaceChildren(el('table', { className: 'channels' },
    el('tr', {}, ...['Channel', 'MHz', 'Transmissions', '', 'Airtime', 'Last heard'].map((h) => el('th', {}, h))),
    ...r.channels.map((c) => {
      const share = el('div', { className: 'share' });
      share.style.width = `${Math.max(2, (c.count / most) * 100)}%`;
      return el('tr', {},
        el('td', {}, c.name
          ? el('button', { className: 'link', onclick: () => openFeed({ channel: c.name }) }, c.name)
          : el('span', { className: 'meta' }, '(no channel)')),
        el('td', { className: 'num' }, c.hz ? (c.hz / 1e6).toFixed(4) : ''),
        el('td', { className: 'num' }, c.count.toLocaleString()),
        el('td', { className: 'bar' }, share),
        el('td', { className: 'num' }, duration(c.ms ?? 0)),
        el('td', {}, new Date(c.last).toLocaleString()));
    })));
}

function render(r, days) {
  const range = days === 1 ? 'in the last 24 hours' : days ? `in the last ${days} days` : 'in all';
  $('ins-summary').textContent = r.total
    ? `${plural(r.total, 'transmission')}, ${duration(r.airtimeMs)} of airtime, ${range}.`
    : `No transmissions ${range}.`;
  renderWords(r.words);
  renderActivity(r, days);
  // A busy-hours chart of one day says nothing a day's bars don't
  $('ins-heat-panel').hidden = days === 1;
  if (days !== 1) renderHeat(r);
  renderChannels(r);
}

async function load() {
  const days = Number($('ins-range').value);
  const p = new URLSearchParams({ days: String(days) });
  if ($('ins-radio').value) p.set('mac', $('ins-radio').value);
  if ($('ins-channel').value) p.set('channel', $('ins-channel').value);
  try {
    render(await api(`/insights?${p}`), days);
  } catch (e) {
    $('ins-summary').textContent = e.message;
  }
}

/** The radio and channel choices, keeping what's chosen. */
async function loadChoices() {
  const [radios, channels] = await Promise.all([api('/radios'), api('/channels')]);
  for (const [id, first, items] of [
    ['ins-radio', 'All radios', radios.map((r) => [r.mac, r.name])],
    ['ins-channel', 'All channels', channels.map((c) => [c.name, c.name])],
  ]) {
    const sel = $(id);
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '' }, first), ...items.map(([v, t]) => el('option', { value: v }, t)));
    sel.value = cur;
  }
}

let timer = null;
document.addEventListener('airscribe:view', (e) => {
  clearInterval(timer);
  if (e.detail !== 'insights') return;
  loadChoices().catch(() => {}).then(load);
  timer = setInterval(() => { if (currentView() === 'insights') load(); }, 60 * 1000);
});
for (const id of ['ins-range', 'ins-radio', 'ins-channel']) $(id).onchange = load;
