/**
 * Local terms for Findings: what a code or a word means on the channels this server hears ("Code 4", "Q5",
 * "Section 12"). Admins set the known ones; the rest are collected from the traffic, and the model works out
 * what they likely mean from how they were used, as guesses an admin accepts or rejects. Both are given to the
 * model when a transmission says one; a guess is marked as one. See docs/findings.md#local-terms.
 */

import { STOP } from './insights.js';
import { numerals, phonetic } from './plates.js';
import { TYPES, distance } from './roads.js';

/** Known: set by an admin. Guess: the model's, from how it was used. Candidate: heard, not yet worked out. */
export const STATUSES = ['known', 'guess', 'candidate', 'rejected'];
// Said this often before the model is asked what it means, and asked again after this many more
const MIN_USES = 3;
const MORE_USES = 5;
const KEEP_SEEN = 12;      // transmissions kept per term, to show the model and the admin
const MAX_SAID = 12;       // terms given with one transmission
// Letters said as words before a number: "cue five" is Q5
const SOUNDS = {
  ay: 'a', bee: 'b', be: 'b', see: 'c', sea: 'c', dee: 'd', ee: 'e', ef: 'f', gee: 'g', aitch: 'h', eye: 'i', jay: 'j',
  kay: 'k', el: 'l', em: 'm', en: 'n', oh: 'o', pee: 'p', pea: 'p', cue: 'q', queue: 'q', are: 'r', es: 's', tea: 't',
  tee: 't', you: 'u', vee: 'v', ex: 'x', why: 'y', zee: 'z', zed: 'z',
};
// A code said as a word and a number ("Code 4", "Signal 23", "Unit 12"); "10-4" as written
const CODE_WORDS = new Set(['code', 'signal', 'unit']);
const TEN_CODE = /\b10-(\d{1,2})\b/g;

// Said plainly on the air: on their own, or with each other, never a local term
const PLAIN = new Set(`
  affirmative negative received receive copy copied roger clear cleared clearing available returning return responding
  respond route enroute scene arrival arriving quarters service standby break tone thanks thank please sir maam
  male female party caller person subject patient year years old fire alarm police ambulance medical vehicle car
`.trim().split(/\s+/));
const STOPPED = new Set([...STOP].map((w) => w.replace(/'/g, '')));

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const numeric = (w) => /^\d+$/.test(w);

// Said after a town's name when dispatch calls its department: "Holden Fire", "Paxton PD"
const DEPARTMENT = new Set(['fire', 'police', 'pd', 'fd', 'ems', 'dispatch', 'rescue', 'ambulance', 'department', 'clear']);

/**
 * Whether a term is a town's name misheard, alone or with its department: "hold and fire" is Holden Fire.
 * @param {string} term - As the model wrote it.
 * @param {string[]} towns - The towns near the channel, and its name.
 * @returns {boolean}
 */
export function soundsLikeTown(term, towns) {
  const w = numerals(term);
  const n = w.length;
  while (w.length > 1 && DEPARTMENT.has(w.at(-1))) w.pop();
  const said = w.join('');
  if (said.length < 5 || /\d/.test(said)) return false;
  // Closer on its own: "hazard" isn't Harvard, but "hold the fire" is Holden Fire
  const max = w.length === n ? 1 : said.length >= 7 ? 3 : 2;
  return towns.some((t) => distance(said, numerals(t).join(''), max) <= max);
}

/**
 * Whether a term the model didn't know is worth collecting: not a number on its own (a time, an amount, a house
 * number), a single letter, letters spelled out ("Sierra Alpha", a plate), a sentence, or only plain words
 * ("negative", "fire alarm clear", "73-year-old male").
 * @param {string} term - As the model wrote it.
 * @returns {boolean}
 */
export function worthCollecting(term) {
  const t = String(term ?? '').trim();
  if (/^\$?\d+(?:[.,:]\d+)*$/.test(t)) return false;
  const w = numerals(t);
  if (w.join('').length < 2 || w.length > 4) return false;
  // "10-13" and "7-3" are codes; "nineteen fifty one" is a time
  if (w.every(numeric)) return /\d\s*-\s*\d/.test(t);
  if (phonetic(t) === w.filter((x) => !numeric(x)).length) return false;
  return !w.every((x) => numeric(x) || PLAIN.has(x) || STOPPED.has(x));
}

/** A term as words: "Code four", "code 4" and "CODE-4" are all "code 4"; "10-4" is "10 4". */
export function termKey(term) {
  return numerals(term).join(' ');
}

/** The word sequences a term may be said as: itself, and its letters and digits run together ("q 5", "q5"). */
const compact = (t) => t.join('');

/** Whether two words are the same, or a mishearing apart (a long word, a letter or two). */
function near(a, b) {
  if (a === b) return true;
  if (numeric(a) || numeric(b) || a.length < 5 || b.length < 5) return false;
  const max = Math.min(a.length, b.length) >= 8 ? 2 : 1;
  return Math.abs(a.length - b.length) <= max && distance(a, b, max) <= max;
}

/**
 * Whether a term is said in some words, as they are or a mishearing away: word by word, or with its letters and
 * digits run together ("Q5" in "Q 5" or "cue five").
 * @param {string[]} words - numerals() of a transcript.
 * @param {string} key - termKey() of the term.
 * @returns {boolean}
 */
export function says(words, key) {
  const k = key.split(' ').filter(Boolean);
  if (!k.length) return false;
  for (let i = 0; i + k.length <= words.length; i++) if (k.every((w, j) => near(w, words[i + j]))) return true;
  const want = compact(k);
  if (want.length < 2) return false;
  const sounded = words.map((w, i) => (SOUNDS[w] && numeric(words[i + 1] ?? '') ? SOUNDS[w] : w));
  for (let i = 0; i < sounded.length; i++) {
    let s = '';
    for (let j = i; j < Math.min(i + 3, sounded.length) && s.length < want.length; j++) {
      s += sounded[j];
      if (s === want) return true;
    }
  }
  return false;
}

/** Whether a channel is one of those an entry is for: "" for all, else names with * for any characters. */
export function onChannel(channels, name) {
  const list = String(channels ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const n = String(name ?? '').toLowerCase();
  return list.some((p) => new RegExp(`^${p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n));
}

/**
 * The codes said in some text: "Code 4", "Signal 23", "Unit 12", "10-4".
 * @param {string} text - A transcript.
 * @returns {string[]} Each, as a term.
 */
export function codesIn(text) {
  const out = new Set();
  const t = numerals(text);
  t.forEach((w, i) => {
    // "631 Salisbury Street, Unit 506" is an apartment, not a unit
    const apartment = w === 'unit' && t.slice(Math.max(0, i - 6), i).some((x) => TYPES.has(x));
    if (CODE_WORDS.has(w) && !apartment && /^\d{1,3}$/.test(t[i + 1] ?? '')) out.add(`${w[0].toUpperCase()}${w.slice(1)} ${t[i + 1]}`);
  });
  for (const m of String(text ?? '').matchAll(TEN_CODE)) out.add(`10-${m[1]}`);
  return [...out];
}

export class Glossary {
  /**
   * @param {import('node:sqlite').DatabaseSync} db - The store's database.
   * @param {{now?: () => number}} [o] - The clock, for tests.
   */
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS glossary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL,                  -- as written: "Code 4"
        key TEXT NOT NULL,                   -- termKey(): "code 4"
        meaning TEXT NOT NULL DEFAULT '',
        channels TEXT NOT NULL DEFAULT '',   -- "" for all; else names, * for any characters
        status TEXT NOT NULL,                -- known, guess, candidate, rejected
        confidence TEXT,                     -- a guess's: low, medium, high
        uses INTEGER NOT NULL DEFAULT 0,
        asked_uses INTEGER,                  -- uses when the model was last asked
        first_seen INTEGER, last_seen INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (key, channels));
      -- Transmissions a term was said in, the last few: what the model works it out from
      CREATE TABLE IF NOT EXISTS glossary_seen (
        term_id INTEGER NOT NULL,
        transmission_id INTEGER NOT NULL,
        channel TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (term_id, transmission_id));
    `);
  }

  /** @returns {object[]} Every entry, for Admin: known first, then guesses, then the rest, most said first. */
  list() {
    return this.db.prepare(`SELECT id, term, meaning, channels, status, confidence, uses, first_seen, last_seen, updated_at
                              FROM glossary
                             ORDER BY CASE status WHEN 'known' THEN 0 WHEN 'guess' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
                                      uses DESC, term`).all();
  }

  /** @returns {object|undefined} One entry. */
  entry(id) {
    return this.db.prepare('SELECT * FROM glossary WHERE id = ?').get(id);
  }

  /** @returns {{channel: string|null, text: string, at: number}[]} Where an entry was said, newest first. */
  seen(id) {
    return this.db.prepare('SELECT channel, text, at FROM glossary_seen WHERE term_id = ? ORDER BY at DESC, transmission_id DESC').all(id);
  }

  /**
   * An admin's entry: known, on the channels given. One already there for the term and channels takes the meaning.
   * @param {{term: string, meaning: string, channels?: string}} o - The entry.
   * @returns {object} It.
   */
  add({ term, meaning, channels = '' }) {
    const t = String(term ?? '').trim().slice(0, 60);
    const m = String(meaning ?? '').trim().slice(0, 200);
    const c = tidyChannels(channels);
    const key = termKey(t);
    if (!key) throw fail('give the term');
    if (!m) throw fail('give what it means');
    const now = this.now();
    this.db.prepare(`INSERT INTO glossary (term, key, meaning, channels, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'known', ?, ?)
                     ON CONFLICT(key, channels) DO UPDATE SET term = excluded.term, meaning = excluded.meaning,
                       status = 'known', confidence = NULL, updated_at = excluded.updated_at`)
      .run(t, key, m, c, now, now);
    return this.db.prepare('SELECT * FROM glossary WHERE key = ? AND channels = ?').get(key, c);
  }

  /**
   * Change an entry: its meaning, channels or status. Accepting a guess makes it known.
   * @param {number} id - The entry.
   * @param {{term?: string, meaning?: string, channels?: string, status?: string}} o - What changes.
   * @returns {object} It.
   */
  update(id, { term, meaning, channels, status } = {}) {
    const e = this.entry(id);
    if (!e) throw fail('no such term', 404);
    if (status !== undefined && !STATUSES.includes(status)) throw fail(`status is one of ${STATUSES.join(', ')}`);
    const next = {
      term: term !== undefined ? String(term).trim().slice(0, 60) : e.term,
      meaning: meaning !== undefined ? String(meaning).trim().slice(0, 200) : e.meaning,
      channels: channels !== undefined ? tidyChannels(channels) : e.channels,
      status: status ?? e.status,
    };
    if (!termKey(next.term)) throw fail('give the term');
    if (next.status === 'known' && !next.meaning) throw fail('give what it means');
    // Asked about again: back to collected, to be worked out with what's been heard since
    const again = status === 'candidate';
    const clash = this.db.prepare('SELECT id FROM glossary WHERE key = ? AND channels = ? AND id != ?').get(termKey(next.term), next.channels, id);
    if (clash) throw fail(`${next.term} is already there for ${next.channels || 'all channels'}`, 409);
    this.db.prepare(`UPDATE glossary SET term = ?, key = ?, meaning = ?, channels = ?, status = ?,
                       confidence = CASE WHEN ? = 'known' THEN NULL ELSE confidence END,
                       asked_uses = CASE WHEN ? THEN NULL ELSE asked_uses END, updated_at = ? WHERE id = ?`)
      .run(next.term, termKey(next.term), again ? '' : next.meaning, next.channels, next.status, next.status,
        again ? 1 : 0, this.now(), id);
    return this.entry(id);
  }

  remove(id) {
    this.db.prepare('DELETE FROM glossary_seen WHERE term_id = ?').run(id);
    return { removed: this.db.prepare('DELETE FROM glossary WHERE id = ?').run(id).changes > 0 };
  }

  /**
   * The known terms and guesses a transmission says, for its channel.
   * @param {string[]} texts - Its readings.
   * @param {string|null} channel - Its channel.
   * @returns {{term: string, meaning: string, status: 'known'|'guess'}[]} Known first.
   */
  said(texts, channel) {
    const words = texts.map(numerals);
    const rows = this.db.prepare(`SELECT term, key, meaning, channels, status FROM glossary
                                   WHERE status IN ('known', 'guess') AND meaning != ''
                                   ORDER BY status = 'guess', length(key) DESC`).all();
    const out = [];
    const keys = new Set();
    for (const r of rows) {
      if (keys.has(r.key) || !onChannel(r.channels, channel) || !words.some((w) => says(w, r.key))) continue;
      keys.add(r.key);
      out.push({ term: r.term, meaning: r.meaning, status: r.status });
      if (out.length >= MAX_SAID) break;
    }
    return out;
  }

  /**
   * Note the codes a transmission said, and the terms the model didn't know, so their meanings can be worked
   * out: each is counted, with this transmission kept as an example. A term the model named that the
   * transmission doesn't say is left out.
   * @param {string[]} texts - Its readings, the one read first.
   * @param {{id: number, channel: string|null, unknown?: string[], towns?: string[]}} o - The transmission, the
   *   model's unknown terms, and the towns near the channel.
   * @returns {string[]} The terms noted.
   */
  collect(texts, { id, channel = null, unknown = [], towns = [] }) {
    const words = texts.map(numerals);
    const terms = new Map();
    // The channel's own name is a town's, often: "Holden Fir"
    const near = [...towns, ...String(channel ?? '').split(/\s+/).filter((w) => w.length >= 5)];
    const said = unknown.filter((t) => worthCollecting(t) && !soundsLikeTown(t, near));
    for (const t of [...texts.flatMap(codesIn), ...said]) {
      const key = termKey(t);
      if (key && key.length <= 40 && !terms.has(key) && words.some((w) => says(w, key))) terms.set(key, String(t).trim().slice(0, 60));
    }
    const now = this.now();
    const text = String(texts[0] ?? '').slice(0, 400);
    for (const [key, term] of terms) {
      // On this channel's entry if there's one for it, else the one for all, else a new one for all
      const rows = this.db.prepare('SELECT id, channels FROM glossary WHERE key = ?').all(key);
      let e = rows.find((r) => r.channels && onChannel(r.channels, channel)) ?? rows.find((r) => !r.channels);
      if (!e) {
        const r = this.db.prepare(`INSERT INTO glossary (term, key, status, created_at, updated_at, first_seen)
                                     VALUES (?, ?, 'candidate', ?, ?, ?)`).run(term, key, now, now, now);
        e = { id: Number(r.lastInsertRowid) };
      }
      const fresh = this.db.prepare(`INSERT OR IGNORE INTO glossary_seen (term_id, transmission_id, channel, text, at)
                                      VALUES (?, ?, ?, ?, ?)`).run(e.id, id, channel, text, now).changes > 0;
      if (!fresh) continue;
      this.db.prepare('UPDATE glossary SET uses = uses + 1, last_seen = ?, first_seen = coalesce(first_seen, ?) WHERE id = ?')
        .run(now, now, e.id);
      this.db.prepare(`DELETE FROM glossary_seen WHERE term_id = ? AND transmission_id NOT IN
                         (SELECT transmission_id FROM glossary_seen WHERE term_id = ? ORDER BY at DESC, transmission_id DESC LIMIT ?)`)
        .run(e.id, e.id, KEEP_SEEN);
    }
    return [...terms.values()];
  }

  /**
   * The terms ready for the model to work out: collected, said often enough, and not asked about since a few
   * more uses.
   * @param {number} [max] - How many.
   * @returns {object[]} Entries.
   */
  toWorkOut(max = 5) {
    return this.db.prepare(`SELECT * FROM glossary
                             WHERE status = 'candidate' AND uses >= ? AND (asked_uses IS NULL OR uses >= asked_uses + ?)
                             ORDER BY uses DESC LIMIT ?`).all(MIN_USES, MORE_USES, max);
  }

  /**
   * What the model made of a term: a guess, or still not known.
   * @param {number} id - The entry.
   * @param {{meaning: string, confidence: string}} answer - Its answer.
   * @returns {object} The entry.
   */
  workedOut(id, { meaning, confidence }) {
    const e = this.entry(id);
    if (!e || e.status !== 'candidate') return e;
    const m = String(meaning ?? '').trim().slice(0, 200);
    const c = ['low', 'medium', 'high'].includes(confidence) ? confidence : 'low';
    this.db.prepare(`UPDATE glossary SET asked_uses = uses, meaning = ?, confidence = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(m, m ? c : null, m ? 'guess' : 'candidate', this.now(), id);
    return this.entry(id);
  }

  /** @returns {{known: number, guess: number, candidate: number, rejected: number, ready: number}} For Admin. */
  counts() {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of this.db.prepare('SELECT status, count(*) AS n FROM glossary GROUP BY status').all()) out[r.status] = r.n;
    return { ...out, ready: this.toWorkOut(1000).length };
  }

  /**
   * Known entries from lines of text, one per line: "term = meaning", with "| channels" after it to keep it to
   * those. Lines that aren't one are skipped and counted.
   * @param {string} text - The lines.
   * @returns {{added: number, skipped: number}}
   */
  importText(text) {
    let added = 0;
    let skipped = 0;
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.match(/^(.+?)\s*=\s*(.+?)(?:\s*\|\s*(.+))?$/);
      try {
        if (!m) throw fail('not term = meaning');
        this.add({ term: m[1], meaning: m[2], channels: m[3] ?? '' });
        added++;
      } catch {
        skipped++;
      }
    }
    return { added, skipped };
  }

  /** @returns {string} The known entries as importText() reads them. */
  exportText() {
    return this.db.prepare("SELECT term, meaning, channels FROM glossary WHERE status = 'known' ORDER BY term").all()
      .map((r) => `${r.term} = ${r.meaning}${r.channels ? ` | ${r.channels}` : ''}`).join('\n');
  }
}

/** Channel names, comma-separated, tidied: "PD F*, Fire Ops*". */
function tidyChannels(s) {
  return String(s ?? '').split(',').map((c) => c.trim()).filter(Boolean).join(', ').slice(0, 300);
}
