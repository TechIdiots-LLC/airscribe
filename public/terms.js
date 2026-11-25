// Admin → Findings → Local terms (docs/findings.md#local-terms): what codes and words mean on these channels.
// Admins add known ones; the model's guesses, from the codes and words collected on the air, wait here to be
// accepted or rejected.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
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

const say = (text, error = false) => {
  $('gl-status').textContent = text;
  $('gl-status').className = error ? 'error' : 'meta';
};
const when = (t) => (t ? new Date(t).toLocaleDateString() : '');

/** Run an action, say what went wrong, and draw the list again. */
const act = (fn) => async () => {
  try {
    const msg = await fn();
    await load();
    if (typeof msg === 'string') say(msg);
  } catch (e) {
    say(e.message, true);
  }
};

/** Where an entry was said: fetched when opened. */
function seenBox(e) {
  const box = el('details', {}, el('summary', { className: 'meta' }, `said ${e.uses} time${e.uses === 1 ? '' : 's'}`));
  box.ontoggle = async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    try {
      const seen = await api(`/admin/findings/terms/${e.id}/seen`);
      box.append(el('ul', { className: 'gl-seen' }, ...(seen.length
        ? seen.map((s) => el('li', { className: 'meta' }, `[${s.channel ?? 'channel unknown'}, ${new Date(s.at).toLocaleString()}] ${s.text}`))
        : [el('li', { className: 'meta' }, 'None kept.')])));
    } catch (err) {
      box.append(el('p', { className: 'error' }, err.message));
    }
  };
  return box;
}

/** One entry, editable in place. */
function row(e) {
  const meaning = el('input', { value: e.meaning, size: 28, placeholder: 'what it means' });
  const channels = el('input', { value: e.channels, size: 16, placeholder: 'channels (all)', spellcheck: false });
  const save = (status) => act(async () => {
    await api(`/admin/findings/terms/${e.id}`, { method: 'PUT', body: { meaning: meaning.value, channels: channels.value, ...(status ? { status } : {}) } });
    return status === 'known' ? `${e.term} is known.` : `${e.term} saved.`;
  });
  const btn = (label, fn, title = '') => el('button', { onclick: fn, title }, label);
  const buttons = {
    known: [btn('Save', save())],
    guess: [btn('Accept', save('known'), 'Make it known, with the meaning as it is here'), btn('Reject', save('rejected'), 'Never give it to the model')],
    candidate: [btn('Add meaning', save('known'), 'Make it known with the meaning typed here'), btn('Ignore', save('rejected'))],
    rejected: [btn('Ask again', save('candidate'), 'Collect it again, and let the model work it out')],
  }[e.status];
  return el('li', {},
    el('div', { className: 'row wrap' },
      el('strong', {}, e.term),
      e.status === 'guess' ? el('span', { className: 'pill', title: 'How sure the model was' }, `guess · ${e.confidence ?? 'low'}`) : '',
      meaning, channels, ...buttons,
      el('button', { className: 'link', onclick: act(async () => { await api(`/admin/findings/terms/${e.id}`, { method: 'DELETE' }); return `${e.term} deleted.`; }) }, 'Delete')),
    el('div', { className: 'meta' }, [e.last_seen ? `last said ${when(e.last_seen)}` : '', e.status === 'guess' ? 'given to the model as unconfirmed' : ''].filter(Boolean).join(' · ')),
    e.uses ? seenBox(e) : '');
}

const GROUPS = [
  ['guess', 'The model’s guesses, to accept or reject'],
  ['known', 'Known'],
  ['candidate', 'Collected, not worked out yet'],
  ['rejected', 'Rejected'],
];

async function load() {
  let r;
  try {
    r = await api('/admin/findings/terms');
  } catch (e) {
    if (e.status !== 403) say(e.message, true);
    return;
  }
  const c = r.counts;
  say(`${c.known} known, ${c.guess} guessed, ${c.candidate} collected (${c.ready} said often enough to work out), ${c.rejected} rejected.`);
  $('gl-list').replaceChildren(...GROUPS.map(([status, title]) => {
    const list = r.terms.filter((e) => e.status === status);
    if (!list.length) return '';
    const body = el('ul', { className: 'user-list' }, ...list.map(row));
    // The long tails folded away
    return status === 'candidate' || status === 'rejected'
      ? el('details', {}, el('summary', {}, `${title} (${list.length})`), body)
      : el('div', {}, el('h5', {}, `${title} (${list.length})`), body);
  }));
}

$('gl-add').onclick = act(async () => {
  const e = await api('/admin/findings/terms', { method: 'POST', body: { term: $('gl-term').value, meaning: $('gl-meaning').value, channels: $('gl-channels').value } });
  $('gl-term').value = '';
  $('gl-meaning').value = '';
  return `${e.term} added.`;
});

$('gl-learn').onclick = act(async () => {
  say('Asking the model…');
  const r = await api('/admin/findings/terms/learn', { method: 'POST' });
  if (r.busy) return 'It’s already working them out.';
  return r.asked ? `Asked about ${r.asked}; ${r.guessed} came back with a meaning.` : 'Nothing collected has been said often enough yet.';
});

$('gl-import').onclick = act(async () => {
  const r = await api('/admin/findings/terms/import', { method: 'POST', body: { text: $('gl-text').value } });
  return `${r.added} added${r.skipped ? `, ${r.skipped} lines skipped (not term = meaning)` : ''}.`;
});

$('gl-export').onclick = (e) => { e.currentTarget.href = withToken('/api/admin/findings/terms/export'); };

document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'admin') load();
});
