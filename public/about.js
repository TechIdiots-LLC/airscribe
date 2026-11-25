// The footer (the version, for the signed-in; who made AirScribe; the privacy policy and terms), and who runs this
// server on those two pages: from /api/about, which anyone may read. Admin → This server sets who runs it.

const $ = (id) => document.getElementById(id);

let got = null;

async function about() {
  try {
    const res = await fetch('/api/about', { credentials: 'same-origin' });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

/** Fill in the footer and the pages' operator and contact; again until the version comes, once signed in. */
async function fill() {
  if (got?.version) return got;
  const a = await about();
  got = a;
  if ($('ft-version')) $('ft-version').textContent = a.version ? ` ${a.version}` : '';
  const year = new Date().getFullYear();
  for (const e of document.querySelectorAll('.ft-year')) e.textContent = year > 2026 ? `2026–${year}` : '2026';
  for (const e of document.querySelectorAll('[data-operator]')) if (a.operator) e.textContent = a.operator;
  const contact = a.contact ?? '';
  for (const e of document.querySelectorAll('[data-contact]')) {
    if (!contact) continue;
    const href = /^https?:\/\//i.test(contact) ? contact : `mailto:${contact}`;
    e.replaceChildren(Object.assign(document.createElement('a'), { href, textContent: contact }));
  }
  for (const e of document.querySelectorAll('[data-if-contact]')) e.hidden = !contact;
  document.dispatchEvent(new CustomEvent('airscribe:about', { detail: a }));
  return a;
}

fill();
// Signed in after the page loaded: the version now
document.addEventListener('airscribe:view', () => { fill(); });

export { fill };

// ---- Admin → This server ------------------------------------------------------------

if ($('about-save')) {
  document.addEventListener('airscribe:about', (e) => {
    if (document.activeElement?.id?.startsWith('about-')) return;
    $('about-operator').value = e.detail.operator ?? '';
    $('about-contact').value = e.detail.contact ?? '';
  });
  $('about-save').onclick = async () => {
    const say = (t, bad = false) => { $('about-status').textContent = t; $('about-status').className = bad ? 'error' : 'meta'; };
    try {
      const res = await fetch('/api/admin/about', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator: $('about-operator').value, contact: $('about-contact').value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      got = null;
      await fill();
      say('Saved: the privacy policy and terms name them now.');
    } catch (err) {
      say(err.message, true);
    }
  };
}
