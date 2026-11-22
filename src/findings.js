/**
 * Findings: what a language model reads in the transcripts. Off until an admin
 * turns it on, and only ever shown to admins (docs/findings.md).
 *
 * Each finished transcript from the default engine is sent, with the last few
 * minutes of its channel as context, to a model on an Ollama or OpenAI-style
 * server (llm-lxc's, say), which answers with a fixed shape: addresses, roads,
 * plates, vehicles, people, units, the kind of call and a one-line summary.
 * Those, and the transcript itself, are checked against the admins' watch list;
 * a match is kept, and can be posted to a webhook (Home Assistant, ntfy).
 *
 * What it keeps is about third parties heard on the radio, so it stays out of
 * everything a viewer or the public view can reach, and is deleted after
 * `keepDays`.
 */

import { addressRoads, words } from './roads.js';

const KEYS = {
  enabled: 'findings.enabled', api: 'findings.api', url: 'findings.url', model: 'findings.model',
  apiKey: 'findings.apiKey', webhook: 'findings.webhook', keepDays: 'findings.keepDays',
};
const DEFAULTS = { api: 'ollama', model: 'qwen3:8b', keepDays: 30 };
const CONTEXT_MS = 5 * 60 * 1000;    // the channel's earlier traffic given as context
const CONTEXT_COUNT = 3;
const TIMEOUT_MS = 120_000;          // a model loading onto the card for the first call takes a while
const QUEUE_MAX = 5000;
const SWEEP_MS = 60 * 60 * 1000;
const LISTS = ['addresses', 'roads', 'plates', 'vehicles', 'people', 'units'];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** What the model is asked to answer with: a JSON schema, for the servers that can hold it to one. */
export const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    incident: { type: 'string' },
    ...Object.fromEntries(LISTS.map((k) => [k, { type: 'array', items: { type: 'string' } }])),
  },
  required: ['summary', 'incident', ...LISTS],
};

const SYSTEM = `You read transcripts of radio traffic (police, fire, EMS, public works, amateur radio), made by speech
recognition, which mishears words. Report only what the NEW transmission says; earlier transmissions on the same
channel are given only so you can follow the conversation. Answer with JSON:
- summary: one short sentence on what the new transmission says, or "" if it says nothing of substance
- incident: the kind of call in a few words ("motor vehicle crash", "structure fire"), or ""
- addresses: street addresses, intersections and named places, written as an address is ("412 Elm St",
  "Main St and Route 9", "Walmart on Route 20")
- roads: the names of the roads those mention, each once ("Elm Street", "Route 9")
- plates: vehicle registration plates, letters and digits only; a spelled-out phonetic alphabet becomes letters
  ("Adam Boy Charlie 1 2 3" is "ABC123")
- vehicles: vehicles described ("red Honda Civic")
- people: people named or described; not unit or badge numbers
- units: unit, car or apparatus names ("Engine 2", "Medic 4", "Car 12")
Use [] or "" for anything not said. Never guess: leave out what the text doesn't say.
When roads near the channel are listed and the transmission means one of them (speech recognition often mishears a
road's name), write it as listed. Don't report a listed road the transmission doesn't mention.`;

// ---- Matching -------------------------------------------------------------

export { words };

/** Letters and digits only: "ABC-123", "abc 123" and "A B C 1 2 3" are all abc123. */
export const compact = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether a term looks like a plate: 2 to 10 letters and digits, both, maybe spaced ("ABC 123", "ABC-123"). */
const plateLike = (term) => /^[a-z0-9]+([ -][a-z0-9]+){0,2}$/i.test(term.trim()) &&
  /^[a-z0-9]{2,10}$/.test(compact(term)) && /\d/.test(term) && /[a-z]/i.test(term);

/**
 * Where a watched term turns up: in the transcript, or in what was found.
 * @param {string} term - The watch's term.
 * @param {string} text - The transcript.
 * @param {object|null} found - The model's answer.
 * @returns {{field: string, value: string} | null} The first place it was found, or null.
 */
export function matchTerm(term, text, found) {
  const t = words(term);
  if (!t) return null;
  const has = (s) => ` ${words(s)} `.includes(` ${t} `);
  if (plateLike(term)) {
    const c = compact(term);
    for (const p of found?.plates ?? []) if (compact(p) === c) return { field: 'plates', value: p };
    if (compact(text).includes(c)) return { field: 'transcript', value: text };
  }
  for (const field of LISTS) for (const v of found?.[field] ?? []) if (has(v)) return { field, value: v };
  for (const field of ['summary', 'incident']) if (found?.[field] && has(found[field])) return { field, value: found[field] };
  if (has(text)) return { field: 'transcript', value: text };
  return null;
}

/**
 * The model's answer, held to the shape whatever it sent: lists of short strings, plates as letters and digits.
 * @param {unknown} raw - What it sent, parsed.
 * @returns {object} The answer.
 */
export function tidy(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = { summary: str(o.summary), incident: str(o.incident, 80) };
  for (const k of LISTS) {
    const seen = new Set();
    out[k] = (Array.isArray(o[k]) ? o[k] : [])
      .map((v) => (k === 'plates' ? compact(v).toUpperCase() : str(v, 120)))
      .filter((v) => v && (k !== 'plates' || (v.length >= 2 && v.length <= 10)))
      .filter((v) => !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
      .slice(0, 20);
  }
  return out;
}

/**
 * The JSON in a model's reply: its own thinking and code fences taken off.
 * @param {string} content - The reply.
 * @returns {unknown} Parsed.
 */
export function parseReply(content) {
  const s = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('the model didn’t answer with JSON');
  return JSON.parse(s.slice(a, b + 1));
}

/** A transcript with the model's annotations ("(static)", "[BLANK_AUDIO]") taken out. */
const spoken = (text) => String(text ?? '').replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();

export class Findings {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./store.js').Store} o.store - Transmissions, transcripts and settings.
   * @param {import('node:events').EventEmitter} [o.manager] - Says when a transcript is done ('transcribed').
   * @param {string} [o.primary] - The default engine, whose transcripts are read.
   * @param {typeof fetch} [o.fetch] - For tests.
   * @param {() => number} [o.now] - The clock, for tests.
   */
  constructor({ store, manager, primary, roads = null, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.db = store.db;
    this.manager = manager;
    this.roads = roads;
    this.primary = primary ?? null;
    this.fetch = fetch;
    this.now = now;
    this.queue = [];
    this.running = null;
    this.lastError = null;
    this.db.exec(`
      -- What the model found in one transmission (docs/findings.md)
      CREATE TABLE IF NOT EXISTS findings (
        transmission_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL, model TEXT, result TEXT, error TEXT,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS findings_time ON findings(created_at);
      -- What the admins watch for, and where it turned up
      CREATE TABLE IF NOT EXISTS finding_watches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS finding_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id INTEGER NOT NULL, transmission_id INTEGER NOT NULL,
        term TEXT NOT NULL, field TEXT NOT NULL, value TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(watch_id, transmission_id));
      CREATE INDEX IF NOT EXISTS finding_hits_tx ON finding_hits(transmission_id);`);
    this.onTranscribed = ({ id, engine, status }) => {
      if (status === 'done' && (!this.primary || engine === this.primary)) this.add(id);
    };
  }

  /** Listen for transcripts, and delete what's past keeping now and then. */
  start() {
    this.manager?.on('transcribed', this.onTranscribed);
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop() {
    this.manager?.off('transcribed', this.onTranscribed);
    clearInterval(this.timer);
    this.queue = [];
  }

  // ---- Settings -------------------------------------------------------------

  get(name) {
    return this.store.setting(KEYS[name]) ?? DEFAULTS[name] ?? '';
  }

  /** @returns {boolean} Whether it's on and has somewhere to send. */
  enabled() {
    return this.get('enabled') === '1' && Boolean(this.get('url') && this.get('model'));
  }

  /** What the Admin page shows: never the API key itself. */
  settings() {
    return {
      enabled: this.get('enabled') === '1',
      api: this.get('api'),
      url: this.get('url'),
      model: this.get('model'),
      apiKey: Boolean(this.store.setting(KEYS.apiKey)),
      webhook: this.get('webhook'),
      keepDays: Number(this.get('keepDays')),
      ready: this.enabled(),
      queued: this.queue.length,
      lastError: this.lastError,
      roads: this.roads?.stats() ?? null,
      counts: {
        findings: this.db.prepare('SELECT count(*) AS n FROM findings').get().n,
        hits: this.db.prepare('SELECT count(*) AS n FROM finding_hits').get().n,
      },
    };
  }

  /**
   * Save the Admin page's form. An API key left blank keeps the saved one.
   * @param {object} body - enabled, api, url, model, apiKey, webhook, keepDays; or forgetKey.
   * @returns {object} settings().
   */
  save({ enabled, api, url, model, apiKey, webhook, keepDays, forgetKey } = {}) {
    const http = (v, what) => {
      const s = String(v ?? '').trim();
      if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw fail(`the ${what} is an http:// or https:// address`);
      if (s.length > 500) throw fail(`that ${what} is too long`);
      return s.replace(/\/+$/, '');
    };
    if (api !== undefined && !['ollama', 'openai'].includes(api)) throw fail('the server is ollama or openai');
    const u = url === undefined ? undefined : http(url, 'server address');
    const w = webhook === undefined ? undefined : http(webhook, 'webhook');
    const m = model === undefined ? undefined : String(model).trim();
    if (m !== undefined && (m.length > 200 || /\s/.test(m))) throw fail('that isn’t a model name');
    let days;
    if (keepDays !== undefined) {
      days = Number(keepDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw fail('keep findings for 1 to 3650 days');
    }
    const on = enabled === undefined ? undefined : Boolean(enabled);
    if (on && !(u ?? this.get('url'))) throw fail('give the server’s address before turning it on');
    if (api !== undefined) this.store.setSetting(KEYS.api, api);
    if (u !== undefined) this.store.setSetting(KEYS.url, u || null);
    if (m !== undefined) this.store.setSetting(KEYS.model, m || null);
    if (w !== undefined) this.store.setSetting(KEYS.webhook, w || null);
    if (days !== undefined) this.store.setSetting(KEYS.keepDays, days);
    if (apiKey) this.store.setSetting(KEYS.apiKey, String(apiKey).slice(0, 500));
    if (forgetKey === true) this.store.setSetting(KEYS.apiKey, null);
    if (on !== undefined) this.store.setSetting(KEYS.enabled, on ? '1' : null);
    if (!this.enabled()) this.queue = [];
    return this.settings();
  }

  // ---- The model ------------------------------------------------------------

  /**
   * Ask the model about one transmission.
   * @param {string} text - The new transmission's transcript.
   * @param {string[]} [context] - The channel's transcripts just before it, oldest first.
   * @param {{channel?: string|null, roads?: string[]}} [about] - The channel's name, and roads near it that sound
   *   like something said.
   * @returns {Promise<object>} tidy() of its answer.
   */
  async ask(text, context = [], { channel = null, roads = [] } = {}) {
    const url = this.get('url');
    const model = this.get('model');
    if (!url || !model) throw fail('Findings has no server or model: set them in Admin → Findings.');
    const user = [
      channel ? `Channel: ${channel}\n` : '',
      roads.length ? `Roads near this channel with names like words said:\n${roads.join('; ')}\n` : '',
      context.length ? `Earlier on this channel:\n${context.map((c) => `- ${c}`).join('\n')}\n` : '',
      `New transmission:\n${text}`,
    ].filter(Boolean).join('\n');
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
    const key = this.store.setting(KEYS.apiKey);
    const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
    const ollama = this.get('api') === 'ollama';
    // Ollama's own API holds the answer to the schema and can turn a model's thinking off; an OpenAI-style
    // server is asked for the schema the way OpenAI's API asks
    const [path, body] = ollama
      ? ['/api/chat', { model, messages, stream: false, think: false, format: SCHEMA, options: { temperature: 0 } }]
      : ['/v1/chat/completions', {
          model, messages, temperature: 0,
          response_format: { type: 'json_schema', json_schema: { name: 'findings', schema: SCHEMA } },
        }];
    let res;
    try {
      res = await this.fetch(`${url}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`can’t reach ${url}: ${e.cause?.message ?? e.message}`);
    }
    const reply = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${reply?.error?.message ?? reply?.error ?? res.statusText}`);
    const content = ollama ? reply?.message?.content : reply?.choices?.[0]?.message?.content;
    return tidy(parseReply(content));
  }

  /**
   * The Admin page's Test: a made-up transmission through the model.
   * @param {string} [text] - What to send; a sample otherwise.
   * @returns {Promise<{model: string, ms: number, text: string, found: object}>} The answer and how long it took.
   */
  async test(text) {
    const sample = String(text ?? '').trim().slice(0, 2000) ||
      'Car 12 respond to 412 Elm Street for a two car MVA, plate on the Honda is Adam Boy Charlie 1 2 3.';
    const t0 = this.now();
    const found = await this.ask(sample);
    return { model: this.get('model'), ms: this.now() - t0, text: sample, found };
  }

  // ---- The queue ------------------------------------------------------------

  /** Queue a transmission whose default transcript is done. */
  add(id) {
    if (!this.enabled() || this.queue.length >= QUEUE_MAX || this.queue.includes(id)) return;
    this.queue.push(id);
    this.drain();
  }

  /**
   * Queue the transmissions of the last `hours` that have a transcript and no findings yet.
   * @param {number} hours - How far back.
   * @returns {{queued: number}} How many.
   */
  backfill(hours) {
    if (!this.enabled()) throw fail('turn Findings on first');
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) throw fail('give a number of hours');
    const rows = this.db.prepare(`
      SELECT t.id FROM transmissions t
        JOIN transcripts x ON x.transmission_id = t.id AND x.status = 'done' AND (? IS NULL OR x.engine = ?)
       WHERE t.started_at >= ? AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.transmission_id = t.id)
       ORDER BY t.started_at LIMIT ?`).all(this.primary, this.primary, this.now() - h * 3600_000, QUEUE_MAX);
    let queued = 0;
    for (const { id } of rows) {
      if (this.queue.length >= QUEUE_MAX) break;
      if (!this.queue.includes(id)) (this.queue.push(id), queued++);
    }
    this.drain();
    return { queued };
  }

  /** Work through the queue, one at a time, while it's on. */
  drain() {
    // Cleared once settled (a finally inside would run before the assignment when there's nothing to do), and
    // started again for anything queued in between
    this.running ??= this.work().finally(() => {
      this.running = null;
      if (this.queue.length && this.enabled()) this.drain();
    });
    return this.running;
  }

  async work() {
    while (this.queue.length && this.enabled()) await this.read(this.queue.shift());
  }

  /**
   * One transmission: its transcript and context to the model, then the watches.
   * @param {number} id - The transmission.
   * @returns {Promise<void>}
   */
  async read(id) {
    const t = this.db.prepare(`
      SELECT t.id, t.started_at, t.channel_name, x.text FROM transmissions t
        JOIN transcripts x ON x.transmission_id = t.id AND x.status = 'done' AND (? IS NULL OR x.engine = ?)
       WHERE t.id = ?`).get(this.primary, this.primary, id);
    const text = spoken(t?.text);
    // Nothing said (a beep, static): nothing to read
    if (!t || text.split(' ').filter(Boolean).length < 2) return;
    const context = this.db.prepare(`
      SELECT x.text FROM transmissions t
        JOIN transcripts x ON x.transmission_id = t.id AND x.status = 'done' AND (? IS NULL OR x.engine = ?)
       WHERE t.channel_name IS ? AND t.started_at < ? AND t.started_at >= ?
       ORDER BY t.started_at DESC LIMIT ?`)
      .all(this.primary, this.primary, t.channel_name, t.started_at, t.started_at - CONTEXT_MS, CONTEXT_COUNT)
      .map((r) => spoken(r.text)).filter(Boolean).reverse();
    let found = null;
    let error = null;
    try {
      const roads = this.roads?.hint([...context, text].join(' '), this.roads.where(t.channel_name)) ?? [];
      found = await this.ask(text, context, { channel: t.channel_name, roads });
      this.lastError = null;
    } catch (e) {
      error = e.message;
      this.lastError = { at: this.now(), error };
      console.error(`[findings] transmission ${id}: ${error}`);
    }
    // Deleted while the model read it
    if (!this.store.hasTransmission(id)) return;
    this.db.prepare(`INSERT INTO findings (transmission_id, status, model, result, error, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(transmission_id) DO UPDATE SET status = excluded.status, model = excluded.model,
                       result = excluded.result, error = excluded.error, created_at = excluded.created_at`)
      .run(id, found ? 'done' : 'error', this.get('model'), found ? JSON.stringify(found) : null, error, this.now());
    // Watches see the transcript even when the model failed
    await this.watch(t, text, found);
  }

  // ---- Watches --------------------------------------------------------------

  watches() {
    return this.db.prepare(`SELECT w.id, w.term, w.note, w.created_at,
                                   (SELECT count(*) FROM finding_hits h WHERE h.watch_id = w.id) AS hits
                              FROM finding_watches w ORDER BY w.term COLLATE NOCASE`).all();
  }

  addWatch({ term, note } = {}) {
    const t = String(term ?? '').trim();
    if (!words(t)) throw fail('give something to watch for');
    if (t.length > 100) throw fail('that’s too long to watch for');
    const n = String(note ?? '').trim().slice(0, 200) || null;
    const { lastInsertRowid } = this.db.prepare('INSERT INTO finding_watches (term, note, created_at) VALUES (?, ?, ?)')
      .run(t, n, this.now());
    return this.db.prepare('SELECT id, term, note, created_at, 0 AS hits FROM finding_watches WHERE id = ?').get(lastInsertRowid);
  }

  removeWatch(id) {
    this.db.prepare('DELETE FROM finding_hits WHERE watch_id = ?').run(id);
    if (!this.db.prepare('DELETE FROM finding_watches WHERE id = ?').run(id).changes) throw fail('no such watch', 404);
    return { ok: true };
  }

  /**
   * Check one transmission against every watch; keep each match, and post it to the webhook.
   * @param {{id: number, started_at: number, channel_name: string|null}} t - The transmission.
   * @param {string} text - Its transcript.
   * @param {object|null} found - What the model found, if it answered.
   * @returns {Promise<object[]>} The new matches.
   */
  async watch(t, text, found) {
    const hits = [];
    for (const w of this.db.prepare('SELECT id, term, note FROM finding_watches').all()) {
      const m = matchTerm(w.term, text, found);
      if (!m) continue;
      const r = this.db.prepare(`INSERT OR IGNORE INTO finding_hits (watch_id, transmission_id, term, field, value, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?)`).run(w.id, t.id, w.term, m.field, m.value, this.now());
      if (r.changes) hits.push({ watch: w, ...m });
    }
    const hook = this.get('webhook');
    for (const h of hook ? hits : []) {
      try {
        await this.fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            event: 'airscribe.findings.watch',
            term: h.watch.term, note: h.watch.note, field: h.field, value: h.value,
            transmission: {
              id: t.id, startedAt: new Date(t.started_at).toISOString(), channel: t.channel_name,
              text, summary: found?.summary ?? '', incident: found?.incident ?? '',
            },
          }),
        });
      } catch (e) {
        console.error(`[findings] webhook: ${e.message}`);
      }
    }
    return hits;
  }

  // ---- Reading them back ----------------------------------------------------

  /**
   * Recent findings, newest first, with their transmission and matches.
   * @param {{q?: string, hits?: boolean, before?: number, limit?: number}} o - A search, only matches, paging.
   * @returns {object[]} Rows.
   */
  results({ q, hits, before, limit } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where = ['f.status = \'done\''];
    const args = [];
    if (before) (where.push('t.started_at < ?'), args.push(Number(before)));
    if (hits) where.push('EXISTS (SELECT 1 FROM finding_hits h WHERE h.transmission_id = t.id)');
    const search = String(q ?? '').trim();
    if (search) {
      // In what was found or in the transcript; a plate however it was spaced
      where.push('(f.result LIKE ? OR t.id IN (SELECT transmission_id FROM transcripts WHERE text LIKE ?) OR f.result LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${compact(search).toUpperCase() || search}%`);
    }
    const rows = this.db.prepare(`
      SELECT t.id, t.started_at, t.channel_name, t.duration_ms, f.model, f.result, f.created_at
        FROM findings f JOIN transmissions t ON t.id = f.transmission_id
       WHERE ${where.join(' AND ')} ORDER BY t.started_at DESC LIMIT ?`).all(...args, n);
    const text = this.db.prepare(`SELECT text FROM transcripts WHERE transmission_id = ? AND status = 'done'
                                   ORDER BY (engine = ?) DESC LIMIT 1`);
    const hitsOf = this.db.prepare('SELECT term, field, value FROM finding_hits WHERE transmission_id = ?');
    return rows.map((r) => ({
      id: r.id, startedAt: r.started_at, channel: r.channel_name, durationMs: r.duration_ms, model: r.model,
      text: text.get(r.id, this.primary ?? '')?.text ?? '',
      found: JSON.parse(r.result), hits: hitsOf.all(r.id),
    }));
  }

  /**
   * The roads the findings of the last `hours` mention, for the Map: each road once, with the transmissions that
   * mention it, near their channel; and a corner where an address names two roads that meet.
   * @param {{hours?: number, also?: number}} o - How far back, and one transmission to include however old.
   * @returns {object} {ways, features (GeoJSON), places: {key: about}, transmissions: {id: about}}.
   */
  map({ hours = 24, also } = {}) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 3650) throw fail('give a number of hours');
    const out = { ways: this.roads?.stats().ways ?? 0, features: { type: 'FeatureCollection', features: [] }, places: {}, transmissions: {} };
    if (!out.ways) return out;
    const rows = this.db.prepare(`
      SELECT t.id, t.started_at, t.channel_name, f.result FROM findings f JOIN transmissions t ON t.id = f.transmission_id
       WHERE f.status = 'done' AND (t.started_at >= ? OR t.id = ?) ORDER BY t.started_at DESC LIMIT 500`)
      .all(this.now() - h * 3600_000, Number(also) || -1);
    const text = this.db.prepare(`SELECT text FROM transcripts WHERE transmission_id = ? AND status = 'done'
                                   ORDER BY (engine = ?) DESC LIMIT 1`);
    const RANK = { exact: 0, base: 1, fuzzy: 2 };
    const places = new Map();
    const note = (key, about, r, said) => {
      const p = places.get(key) ?? { ...about, said: new Set(), ids: [], last: 0 };
      if (RANK[about.level] < RANK[p.level]) p.level = about.level;
      p.said.add(said);
      if (!p.ids.includes(r.id)) p.ids.push(r.id);
      p.last = Math.max(p.last, r.started_at);
      places.set(key, p);
    };
    for (const r of rows) {
      const found = JSON.parse(r.result);
      const at = this.roads.where(r.channel_name);
      const located = new Map();
      const find = (s) => {
        const k = words(s);
        if (!located.has(k)) located.set(k, this.roads.locate(s, at));
        return located.get(k);
      };
      let any = false;
      const road = (m) => {
        if (!m) return;
        any = true;
        note(`road:${m.ids[0]}`, { kind: 'road', name: m.name, level: m.level, lines: m.lines, anywhere: Boolean(m.all) }, r, m.said);
      };
      for (const s of found.roads ?? []) road(find(s));
      for (const a of found.addresses ?? []) {
        const parts = addressRoads(a).map(find);
        parts.forEach(road);
        const [p, q] = parts;
        const corner = p && q && p.ids[0] !== q.ids[0] ? this.roads.corner(p, q) : null;
        if (corner) note(`corner:${corner.join(',')}`, { kind: 'corner', name: `${p.name} and ${q.name}`, level: 'exact', point: corner }, r, a);
      }
      if (!any) continue;
      out.transmissions[r.id] = {
        startedAt: r.started_at, channel: r.channel_name, summary: found.summary, incident: found.incident,
        text: text.get(r.id, this.primary ?? '')?.text ?? '',
      };
    }
    for (const [key, p] of places) {
      out.features.features.push({
        type: 'Feature',
        geometry: p.kind === 'road' ? { type: 'MultiLineString', coordinates: p.lines } : { type: 'Point', coordinates: p.point },
        properties: { key, kind: p.kind, level: p.level, count: p.ids.length, last: p.last },
      });
      out.places[key] = { kind: p.kind, name: p.name, level: p.level, said: [...p.said], ids: p.ids, last: p.last, anywhere: p.anywhere ?? false };
    }
    return out;
  }

  /** Delete every finding and match (the watch list stays). */
  forget() {
    this.queue = [];
    this.db.exec('DELETE FROM finding_hits; DELETE FROM findings;');
    return this.settings();
  }

  /** Delete findings past keepDays, and those whose transmission is gone. */
  sweep() {
    const cutoff = this.now() - Number(this.get('keepDays')) * 86_400_000;
    this.db.prepare(`DELETE FROM finding_hits WHERE created_at < ?
                       OR transmission_id NOT IN (SELECT id FROM transmissions)`).run(cutoff);
    this.db.prepare(`DELETE FROM findings WHERE created_at < ?
                       OR transmission_id NOT IN (SELECT id FROM transmissions)`).run(cutoff);
  }
}
