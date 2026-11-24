/**
 * Findings: what a language model reads in the transcripts. Off until an admin
 * turns it on; signed-in users see it, the public never does (docs/findings.md).
 *
 * Each finished transcript from the default engine is sent, with the last few
 * minutes of its channel as context, to a model on an Ollama or OpenAI-style
 * server (llm-lxc's, say), which answers with a fixed shape: addresses, roads,
 * plates, vehicles, people, units, the kind of call and a one-line summary.
 * Those, and the transcript itself, are checked against the admins' watch list;
 * a match is kept, and can be posted to a webhook (Home Assistant, ntfy).
 *
 * What it keeps is about third parties heard on the radio, so it stays out of
 * the event stream, exports and the public view, and is deleted after
 * `keepDays`. Only admins change it or its watch list.
 */

import { isStatic } from './quality.js';
import { addressRoads, words } from './roads.js';

const KEYS = {
  enabled: 'findings.enabled', api: 'findings.api', url: 'findings.url', model: 'findings.model',
  apiKey: 'findings.apiKey', webhook: 'findings.webhook', keepDays: 'findings.keepDays',
};
const DEFAULTS = { api: 'ollama', model: 'qwen3:8b', keepDays: 30 };
/** What the model is given with each transmission, set on the Admin page: whole numbers, capped so the prompt stays small. */
export const CONTEXT = {
  contextMinutes: { def: 5, min: 1, max: 30, what: 'look back 1 to 30 minutes' },
  contextCount: { def: 5, min: 0, max: 20, what: 'give 0 to 20 of the channel’s earlier transmissions' },
  othersCount: { def: 5, min: 0, max: 20, what: 'give 0 to 20 of the other channels’ transmissions' },
  sameCallSeconds: { def: 5, min: 0, max: 30, what: 'count another radio as the same call within 0 to 30 seconds' },
  waitMinutes: { def: 3, min: 0, max: 30, what: 'wait 0 to 30 minutes for the other speech engines' },
  findingsMinutes: { def: 15, min: 1, max: 60, what: 'give earlier findings from the last 1 to 60 minutes' },
  findingsCount: { def: 5, min: 0, max: 20, what: 'give 0 to 20 earlier findings' },
};
const TIMEOUT_MS = 120_000;          // a model loading onto the card for the first call takes a while
const QUEUE_MAX = 5000;
const SWEEP_MS = 60 * 60 * 1000;
const LISTS = ['addresses', 'roads', 'plates', 'vehicles', 'people', 'units'];
/** Who is talking, as the model tells it: the Map colours roads by it. */
export const SERVICES = ['police', 'fire', 'ems', 'works', 'amateur', 'other'];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** What the model is asked to answer with: a JSON schema, for the servers that can hold it to one. */
export const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    incident: { type: 'string' },
    service: { type: 'string', enum: SERVICES },
    ...Object.fromEntries(LISTS.map((k) => [k, { type: 'array', items: { type: 'string' } }])),
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'integer' }, field: { type: 'string', enum: LISTS }, was: { type: 'string' }, now: { type: 'string' },
        },
        required: ['finding', 'field', 'was', 'now'],
      },
    },
  },
  required: ['summary', 'incident', 'service', ...LISTS, 'corrections'],
};

const SYSTEM = `You read transcripts of radio traffic (police, fire, EMS, public works, amateur radio), made by speech
recognition, which mishears words. Report only what the NEW transmission says; earlier transmissions on the same
channel, and on other channels in the same minutes, are given only so you can follow what's going on (a unit sent on
one channel and talking on another, a call that moves from dispatch to a fireground). Never report what only those
say. Other readings of the new transmission may follow it: another speech engine's, or another radio's that heard the
same frequency at the same moment. Those are the same words heard differently: use them together to work out what was
said. Answer with JSON:
- summary: one short sentence on what the new transmission says, or "" if it says nothing of substance
- incident: the kind of call in a few words ("motor vehicle crash", "structure fire"), or ""
- service: who is talking: "police", "fire", "ems", "works" (public works, highway, utilities, transit), "amateur"
  (ham radio), or "other". The channel's name helps: "Holden PD" is police, "Paxton FD" fire, and a channel named
  by a callsign ("W1BIM", "N1LHP") is an amateur repeater
- addresses: street addresses, intersections and named places, written as an address is ("412 Elm St",
  "Main St and Route 9", "Walmart on Route 20")
- roads: the names of the roads those mention, each once ("Elm Street", "Route 9")
- plates: vehicle registration plates, letters and digits only; a spelled-out phonetic alphabet becomes letters
  ("Adam Boy Charlie 1 2 3" is "ABC123")
- vehicles: vehicles described ("red Honda Civic")
- people: people named or described; not unit or badge numbers
- units: unit, car or apparatus names ("Engine 2", "Medic 4", "Car 12")
- corrections: when the new transmission clearly corrects a detail of an earlier finding listed, or repeats it more
  clearly (another house number, plate or street for the same thing), one entry per detail: finding (its number),
  field (addresses, roads, plates, vehicles, people or units), was (the earlier value, exactly as listed) and now
  (the right value). Never for a detail of another call
Use [] or "" for anything not said. Never guess: leave out what the text doesn't say.
Earlier findings, when listed, are what was worked out from earlier transmissions on any channel, each with its
number. They're context too: report their details again only when the new transmission says them.
When roads near the channel are listed and the transmission means one of them (speech recognition often mishears a
road's name), write it as listed. Don't report a listed road the transmission doesn't mention.
A transmission marked as heard through static came in weak: its transcript is more likely to be wrong, or words made
up from noise. Report from it only what reads clearly, and nothing that seems invented.`;

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
/** A service as the model wrote it, held to SERVICES: "Law" is police, "public works" works, "ham" amateur. */
export function serviceOf(v) {
  const s = String(v ?? '').toLowerCase();
  if (SERVICES.includes(s)) return s;
  if (/police|law|sheriff|\bpd\b|trooper/.test(s)) return 'police';
  if (/fire|\bfd\b/.test(s)) return 'fire';
  if (/ems|medic|ambulance|rescue/.test(s)) return 'ems';
  if (/works|highway|dpw|utilit|transit|water|road/.test(s)) return 'works';
  if (/amateur|\bham\b|repeater/.test(s)) return 'amateur';
  return 'other';
}

export function tidy(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = { summary: str(o.summary), incident: str(o.incident, 80), service: serviceOf(o.service) };
  for (const k of LISTS) {
    const seen = new Set();
    out[k] = (Array.isArray(o[k]) ? o[k] : [])
      .map((v) => (k === 'plates' ? compact(v).toUpperCase() : str(v, 120)))
      .filter((v) => v && (k !== 'plates' || (v.length >= 2 && v.length <= 10)))
      .filter((v) => !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
      .slice(0, 20);
  }
  const value = (field, v) => (field === 'plates' ? compact(v).toUpperCase() : str(v, 120));
  out.corrections = (Array.isArray(o.corrections) ? o.corrections : [])
    .filter((c) => c && Number.isInteger(Number(c.finding)) && LISTS.includes(c.field))
    .map((c) => ({ finding: Number(c.finding), field: c.field, was: value(c.field, c.was), now: value(c.field, c.now) }))
    // A change, not the same words written another way
    .filter((c) => c.was && c.now && words(c.was) !== words(c.now))
    .slice(0, 5);
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

/** Words said: runs of letters or digits, so "24-7-9-5" is four. */
const count = (text) => (String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? []).length;
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
  constructor({ store, manager, primary, engines = [], roads = null, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    // Every engine that transcribes each clip: a transmission is read once they all have
    this.engines = [...new Set([primary, ...engines].filter(Boolean))];
    this.late = new Map();   // id → the timer that reads it should the other engines lag
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
    // What was sent to the model with each
    const cols = new Set(this.db.prepare('PRAGMA table_info(findings)').all().map((c) => c.name));
    if (!cols.has('sent')) this.db.exec('ALTER TABLE findings ADD COLUMN sent TEXT');
    // The tokens and time it took; and what was found before a later transmission corrected it
    if (!cols.has('usage')) this.db.exec('ALTER TABLE findings ADD COLUMN usage TEXT');
    if (!cols.has('original')) this.db.exec('ALTER TABLE findings ADD COLUMN original TEXT');
    // Another radio's copy of a transmission read once: status 'copy', and the one read
    if (!cols.has('copy_of')) this.db.exec('ALTER TABLE findings ADD COLUMN copy_of INTEGER');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS finding_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transmission_id INTEGER NOT NULL, by_id INTEGER NOT NULL,
        field TEXT NOT NULL, was TEXT NOT NULL, now TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS finding_corrections_tx ON finding_corrections(transmission_id);
      CREATE INDEX IF NOT EXISTS finding_corrections_by ON finding_corrections(by_id);`);
    this.onTranscribed = ({ id, engine }) => {
      if (!this.engines.length) return this.add(id);
      if (!this.engines.includes(engine)) return;
      const wait = this.number('waitMinutes') * 60_000;
      // Not waiting: the default engine's transcript alone
      if (!wait) return engine === this.primary ? this.add(id) : undefined;
      const marks = this.engines.map(() => '?').join(',');
      const { n } = this.db.prepare(`SELECT count(DISTINCT engine) AS n FROM transcripts
                                       WHERE transmission_id = ? AND engine IN (${marks}) AND status IN ('done', 'error')`)
        .get(id, ...this.engines);
      if (n >= this.engines.length) {
        clearTimeout(this.late.get(id));
        this.late.delete(id);
        this.add(id);
      } else if (engine === this.primary && !this.late.has(id)) {
        // The others are queued behind live transcription: don't wait on them for ever
        const t = setTimeout(() => {
          this.late.delete(id);
          if (!this.db.prepare('SELECT 1 FROM findings WHERE transmission_id = ?').get(id)) this.add(id);
        }, wait);
        t.unref?.();
        this.late.set(id, t);
      }
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
    for (const t of this.late.values()) clearTimeout(t);
    this.late.clear();
    this.queue = [];
  }

  // ---- Settings -------------------------------------------------------------

  get(name) {
    return this.store.setting(KEYS[name]) ?? DEFAULTS[name] ?? '';
  }

  /** One of CONTEXT's numbers, as saved or its default. */
  number(name) {
    const v = this.store.setting(`findings.${name}`);
    return v == null || !Number.isFinite(Number(v)) ? CONTEXT[name].def : Number(v);
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
      ...Object.fromEntries(Object.keys(CONTEXT).map((k) => [k, this.number(k)])),
      ready: this.enabled(),
      queued: this.queue.length,
      lastError: this.lastError,
      roads: this.roads?.stats() ?? null,
      counts: {
        findings: this.db.prepare("SELECT count(*) AS n FROM findings WHERE status != 'copy'").get().n,
        hits: this.db.prepare('SELECT count(*) AS n FROM finding_hits').get().n,
      },
      // The biggest prompt of the last day, as the server counted it: how near the model's context window it comes
      biggestPrompt: this.db.prepare(`SELECT max(json_extract(usage, '$.prompt')) AS n FROM findings
                                        WHERE usage IS NOT NULL AND created_at >= ?`).get(this.now() - 86_400_000).n ?? null,
    };
  }

  /**
   * What any signed-in user sees of it: whether it's on and how much is kept; not where it sends, or its errors,
   * which name the server.
   * @returns {object} The status, and the instructions the model is given.
   */
  status() {
    return {
      enabled: this.get('enabled') === '1',
      ready: this.enabled(),
      queued: this.queue.length,
      roads: Boolean(this.roads?.stats().ways),
      counts: {
        findings: this.db.prepare("SELECT count(*) AS n FROM findings WHERE status != 'copy'").get().n,
        hits: this.db.prepare('SELECT count(*) AS n FROM finding_hits').get().n,
      },
      // When the last was made: where speaking new ones starts from
      latestAt: this.db.prepare("SELECT max(created_at) AS n FROM findings WHERE status = 'done'").get().n ?? 0,
      instructions: SYSTEM,
    };
  }

  /**
   * Save the Admin page's form. An API key left blank keeps the saved one.
   * @param {object} body - enabled, api, url, model, apiKey, webhook, keepDays, CONTEXT's numbers; or forgetKey.
   * @returns {object} settings().
   */
  save({ enabled, api, url, model, apiKey, webhook, keepDays, forgetKey, ...rest } = {}) {
    const numbers = {};
    for (const [k, c] of Object.entries(CONTEXT)) {
      if (rest[k] === undefined || rest[k] === '') continue;
      const n = Number(rest[k]);
      if (!Number.isInteger(n) || n < c.min || n > c.max) throw fail(c.what);
      numbers[k] = n;
    }
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
    for (const [k, n] of Object.entries(numbers)) this.store.setSetting(`findings.${k}`, n);
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
  async ask(text, context = [], about = {}) {
    return (await this.send(this.message(text, context, about))).found;
  }

  /**
   * What the model is told about one transmission, besides the instructions (SYSTEM).
   * @param {string} text - The new transmission's transcript.
   * @param {(string|{text: string, static?: boolean})[]} [context] - The channel's transcripts just before it.
   * @param {{channel?: string|null, roads?: string[], static?: boolean, others?: object[]}} [about] - The channel's
   *   name, roads near it that sound like something said, whether the new one came through static, and other
   *   channels' transmissions just before ({channel, ago, text, static}), and other readings of the new one: another
   *   engine's ({text}) or another radio's ({channel, text}).
   * @returns {string} The user message.
   */
  message(text, context = [], { channel = null, roads = [], static: noisy = false, others = [], readings = [], findings = [] } = {}) {
    const said = (c) => (typeof c === 'string' ? c : `${c.static ? '(heard through static) ' : ''}${c.text}`);
    const where = (c) => `[${c.channel ?? 'channel unknown'}, ${c.ago < 60_000 ? 'under a minute' : `${Math.round(c.ago / 60_000)} min`} before] `;
    const found = (f) => [f.found.summary, ...LISTS.filter((k) => f.found[k]?.length).map((k) => `${k}: ${f.found[k].join(', ')}`)]
      .filter(Boolean).join('; ');
    return [
      channel ? `Channel: ${channel}\n` : '',
      roads.length ? `Roads near this channel with names like words said:\n${roads.join('; ')}\n` : '',
      findings.length ? `Earlier findings:\n${findings.map((f) => `- finding ${f.id} ${where(f)}${found(f)}`).join('\n')}\n` : '',
      others.length ? `Meanwhile on other channels:\n${others.map((c) => `- ${where(c)}${said(c)}`).join('\n')}\n` : '',
      context.length ? `Earlier on this channel:\n${context.map((c) => `- ${said(c)}`).join('\n')}\n` : '',
      `New transmission${noisy ? ', heard through static (weak signal: the transcript may be wrong)' : ''}:\n${text}`,
      readings.length ? `\nOther readings of the new transmission:\n${readings.map((r) => `- ${r.channel
        ? `another radio on the same frequency (${r.channel})` : 'another speech engine'}: ${r.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Send one user message, with the instructions, and tidy the answer.
   * @param {string} user - message().
   * @returns {Promise<{found: object, usage: {prompt?: number, answer?: number, ms: number}}>} tidy() of its
   *   answer, and the tokens the server counted for the prompt and the answer.
   */
  async send(user) {
    const t0 = this.now();
    const url = this.get('url');
    const model = this.get('model');
    if (!url || !model) throw fail('Findings has no server or model: set them in Admin → Findings.');
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
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
    const usage = ollama
      ? { prompt: n(reply?.prompt_eval_count), answer: n(reply?.eval_count) }
      : { prompt: n(reply?.usage?.prompt_tokens), answer: n(reply?.usage?.completion_tokens) };
    return { found: tidy(parseReply(content)), usage: { ...usage, ms: this.now() - t0 } };
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
    const sent = this.message(sample);
    const { found, usage } = await this.send(sent);
    return { model: this.get('model'), ms: this.now() - t0, text: sample, sent, found, usage };
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
  /**
   * A transmission's transcripts, the default engine's first, each with what was said.
   * @param {number} id - The transmission.
   * @returns {{engine: string, text: string}[]} Those with two words or more, the best first: the default engine's,
   *   else the one that heard most.
   */
  readings(id) {
    const all = this.db.prepare("SELECT engine, text FROM transcripts WHERE transmission_id = ? AND status = 'done'").all(id)
      .map((r) => ({ engine: r.engine, text: spoken(r.text) })).filter((r) => count(r.text) >= 2);
    return all.sort((a, b) => (b.engine === this.primary) - (a.engine === this.primary) || count(b.text) - count(a.text));
  }

  async read(id) {
    const t = this.db.prepare('SELECT id, mac, started_at, channel_name, channel_hz, snr_db FROM transmissions WHERE id = ?').get(id);
    const heard = t ? this.readings(id) : [];
    // Nothing said by any engine (a beep, static): nothing to read
    if (!heard.length) return;
    const text = heard[0].text;
    const same = (a, b) => words(a) === words(b);
    // The same transmission from another radio on the frequency: another reading, not other traffic
    const sameCall = this.number('sameCallSeconds') * 1000;
    const copies = t.channel_hz && sameCall ? this.db.prepare(`
      SELECT id, channel_name FROM transmissions
       WHERE channel_hz = ? AND mac IS NOT ? AND id != ? AND abs(started_at - ?) <= ?`)
      .all(t.channel_hz, t.mac, id, t.started_at, sameCall) : [];
    // A copy already read is the finding for both: this one is attached to it
    const first = copies.map((c) => this.db.prepare(`SELECT transmission_id AS id, status, sent FROM findings
                                                      WHERE transmission_id = ? AND status IN ('done', 'error')`).get(c.id))
      .find(Boolean);
    if (first) return this.attach(t, text, first);
    const readings = [
      ...heard.slice(1).map((r) => ({ text: r.text })),
      ...copies.flatMap((c) => this.readings(c.id).slice(0, 1).map((r) => ({ channel: c.channel_name, text: r.text }))),
    ].filter((r, i, all) => !same(r.text, text) && all.findIndex((o) => same(o.text, r.text)) === i);
    const before = (where, args, n) => this.db.prepare(`
      SELECT id, channel_name, started_at, snr_db FROM transmissions
       WHERE ${where} AND data = 0 AND started_at < ? AND started_at >= ? ORDER BY started_at DESC LIMIT ?`)
      .all(...args, t.started_at, t.started_at - this.number('contextMinutes') * 60_000, n)
      .map((r) => ({ ...r, text: this.readings(r.id)[0]?.text ?? '' })).filter((r) => r.text);
    const othersCount = this.number('othersCount');
    const context = before('channel_name IS ?', [t.channel_name], this.number('contextCount'))
      .map((r) => ({ text: r.text, static: isStatic(r.snr_db) })).reverse();
    // Other channels in the same minutes, with something said, the copies of this one aside
    const skip = new Set(copies.map((c) => c.id));
    const others = before('channel_name IS NOT ?', [t.channel_name], othersCount * 3)
      .filter((r) => !skip.has(r.id)).slice(0, othersCount)
      .map((r) => ({ channel: r.channel_name, ago: t.started_at - r.started_at, text: r.text, static: isStatic(r.snr_db) }))
      .reverse();
    const findings = this.earlier(t, skip);
    let found = null;
    let error = null;
    let sent = null;
    let usage = null;
    try {
      const said = [...context.map((c) => c.text), text].join(' ');
      const roads = this.roads?.hint(said, this.roads.where(t.channel_name)) ?? [];
      // Static is said, not skipped: the model is told to trust it less
      sent = this.message(text, context, { channel: t.channel_name, roads, static: isStatic(t.snr_db), others, readings, findings });
      ({ found, usage } = await this.send(sent));
      this.lastError = null;
    } catch (e) {
      error = e.message;
      this.lastError = { at: this.now(), error };
      console.error(`[findings] transmission ${id}: ${error}`);
    }
    // Deleted while the model read it
    if (!this.store.hasTransmission(id)) return;
    // Read again: corrections made to what it found before don't apply to the new answer
    this.db.prepare('DELETE FROM finding_corrections WHERE transmission_id = ?').run(id);
    this.db.prepare(`INSERT INTO findings (transmission_id, status, model, result, error, sent, usage, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(transmission_id) DO UPDATE SET status = excluded.status, model = excluded.model,
                       result = excluded.result, error = excluded.error, sent = excluded.sent, usage = excluded.usage,
                       original = NULL, created_at = excluded.created_at`)
      .run(id, found ? 'done' : 'error', this.get('model'), found ? JSON.stringify(found) : null, error, sent,
        usage ? JSON.stringify(usage) : null, this.now());
    // Watches see the transcript even when the model failed
    await this.watch(t, text, found);
    if (found?.corrections.length) await this.correct(id, found.corrections, new Set(findings.map((f) => f.id)));
  }

  /**
   * Another radio's copy of a transmission already read: kept as a copy of that finding, not read again. Should it
   * have heard words the first was read without, the first is read again, with this as another radio's reading.
   * @param {{id: number, started_at: number, channel_name: string|null}} t - The copy.
   * @param {string} text - What it heard.
   * @param {{id: number, status: string, sent: string|null}} first - The finding it's a copy of.
   * @returns {Promise<void>}
   */
  async attach(t, text, first) {
    this.db.prepare(`INSERT INTO findings (transmission_id, status, copy_of, created_at) VALUES (?, 'copy', ?, ?)
                     ON CONFLICT(transmission_id) DO UPDATE SET status = 'copy', copy_of = excluded.copy_of, model = NULL,
                       result = NULL, error = NULL, sent = NULL, usage = NULL, original = NULL, created_at = excluded.created_at`)
      .run(t.id, first.id, this.now());
    this.db.prepare('DELETE FROM finding_corrections WHERE transmission_id = ? OR by_id = ?').run(t.id, t.id);
    if (first.status !== 'done' || !` ${words(first.sent ?? '')} `.includes(` ${words(text)} `)) return this.add(first.id);
    // Its words were in the first's prompt: the watches see them, against what was found there
    const f = this.db.prepare('SELECT result FROM findings WHERE transmission_id = ?').get(first.id);
    const ft = this.db.prepare('SELECT id, started_at, channel_name FROM transmissions WHERE id = ?').get(first.id);
    if (ft) await this.watch(ft, text, f?.result ? JSON.parse(f.result) : null);
  }

  /**
   * The findings just before a transmission, on any channel, with something found: what's been worked out so far.
   * @param {{id: number, started_at: number}} t - The transmission.
   * @param {Set<number>} skip - Its copies from other radios.
   * @returns {{id: number, channel: string|null, ago: number, found: object}[]} Oldest first.
   */
  earlier(t, skip = new Set()) {
    const n = this.number('findingsCount');
    if (!n) return [];
    return this.db.prepare(`
      SELECT t.id, t.channel_name, t.started_at, f.result FROM findings f JOIN transmissions t ON t.id = f.transmission_id
       WHERE f.status = 'done' AND t.id != ? AND t.started_at < ? AND t.started_at >= ?
       ORDER BY t.started_at DESC LIMIT ?`)
      .all(t.id, t.started_at, t.started_at - this.number('findingsMinutes') * 60_000, n * 3)
      .map((r) => ({ id: r.id, channel: r.channel_name, ago: t.started_at - r.started_at, found: JSON.parse(r.result) }))
      .filter((f) => !skip.has(f.id) && (f.found.summary || LISTS.some((k) => f.found[k]?.length)))
      .slice(0, n)
      .reverse();
  }

  /**
   * Put right what a later transmission corrects in earlier findings: only those the model was shown, and only a
   * value that finding has. What was first found is kept, and the watches look again.
   * @param {number} by - The transmission that corrects them.
   * @param {{finding: number, field: string, was: string, now: string}[]} corrections - From its answer.
   * @param {Set<number>} shown - The earlier findings it was given.
   * @returns {Promise<object[]>} Those made.
   */
  async correct(by, corrections, shown) {
    const made = [];
    for (const c of corrections) {
      if (!shown.has(c.finding)) continue;
      const row = this.db.prepare("SELECT result, original FROM findings WHERE transmission_id = ? AND status = 'done'").get(c.finding);
      if (!row) continue;
      const found = JSON.parse(row.result);
      const same = (v) => (c.field === 'plates' ? compact(v) === compact(c.was) : words(v) === words(c.was));
      const list = found[c.field] ?? [];
      const at = list.findIndex(same);
      if (at < 0) continue;
      const was = list[at];
      list.splice(at, 1, c.now);
      found[c.field] = list.filter((v, i) => list.findIndex((o) => words(o) === words(v)) === i);
      this.db.prepare('UPDATE findings SET result = ?, original = coalesce(original, ?) WHERE transmission_id = ?')
        .run(JSON.stringify(found), row.result, c.finding);
      this.db.prepare(`INSERT INTO finding_corrections (transmission_id, by_id, field, was, now, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)`).run(c.finding, by, c.field, was, c.now, this.now());
      made.push({ ...c, was });
      // A corrected plate may be one watched for
      const t = this.db.prepare('SELECT id, started_at, channel_name FROM transmissions WHERE id = ?').get(c.finding);
      if (t) await this.watch(t, this.readings(t.id)[0]?.text ?? '', found);
    }
    return made;
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
   * @param {{q?: string, hits?: boolean, before?: number, since?: number, after?: number, limit?: number}} o - A
   *   search, only matches, paging, how far back; or those made at or after `after` (ms), oldest made first.
   * @returns {object[]} Rows.
   */
  results({ q, hits, before, since, after, limit } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where = ['f.status = \'done\''];
    const args = [];
    const made = after !== undefined && after !== '' && Number.isFinite(Number(after));
    if (made) (where.push('f.created_at >= ?'), args.push(Number(after)));
    if (before) (where.push('t.started_at < ?'), args.push(Number(before)));
    if (since) (where.push('t.started_at >= ?'), args.push(Number(since)));
    if (hits) where.push('EXISTS (SELECT 1 FROM finding_hits h WHERE h.transmission_id = t.id)');
    const search = String(q ?? '').trim();
    if (search) {
      // In what was found or in the transcript, or another radio's copy of it; a plate however it was spaced
      where.push(`(f.result LIKE ? OR t.id IN (SELECT transmission_id FROM transcripts WHERE text LIKE ?) OR f.result LIKE ?
                   OR t.id IN (SELECT c.copy_of FROM findings c JOIN transcripts x ON x.transmission_id = c.transmission_id
                                WHERE c.status = 'copy' AND x.text LIKE ?))`);
      args.push(`%${search}%`, `%${search}%`, `%${compact(search).toUpperCase() || search}%`, `%${search}%`);
    }
    const rows = this.db.prepare(`
      SELECT t.id, t.started_at, t.channel_name, t.duration_ms, t.snr_db, f.model, f.result, f.sent, f.usage, f.created_at
        FROM findings f JOIN transmissions t ON t.id = f.transmission_id
       WHERE ${where.join(' AND ')} ORDER BY ${made ? 'f.created_at' : 't.started_at DESC'} LIMIT ?`).all(...args, n);
    const text = this.db.prepare(`SELECT text FROM transcripts WHERE transmission_id = ? AND status = 'done'
                                   ORDER BY (engine = ?) DESC LIMIT 1`);
    const hitsOf = this.db.prepare('SELECT term, field, value FROM finding_hits WHERE transmission_id = ?');
    // Corrected by later transmissions, and correcting earlier ones
    const by = this.db.prepare(`SELECT c.by_id AS id, c.field, c.was, c.now, t.channel_name AS channel, t.started_at AS startedAt
                                  FROM finding_corrections c LEFT JOIN transmissions t ON t.id = c.by_id
                                 WHERE c.transmission_id = ? ORDER BY c.id`);
    const of = this.db.prepare(`SELECT c.transmission_id AS id, c.field, c.was, c.now, t.channel_name AS channel, t.started_at AS startedAt
                                  FROM finding_corrections c LEFT JOIN transmissions t ON t.id = c.transmission_id
                                 WHERE c.by_id = ? ORDER BY c.id`);
    // Other radios' copies of the same transmission, read with it
    const copies = this.db.prepare(`SELECT t.id, t.channel_name AS channel, t.started_at AS startedAt
                                      FROM findings f JOIN transmissions t ON t.id = f.transmission_id
                                     WHERE f.copy_of = ? AND f.status = 'copy' ORDER BY t.started_at`);
    return rows.map((r) => ({
      id: r.id, startedAt: r.started_at, channel: r.channel_name, durationMs: r.duration_ms, model: r.model,
      text: text.get(r.id, this.primary ?? '')?.text ?? '',
      found: JSON.parse(r.result), hits: hitsOf.all(r.id), sent: r.sent ?? null, static: isStatic(r.snr_db),
      usage: r.usage ? JSON.parse(r.usage) : null, correctedBy: by.all(r.id), corrects: of.all(r.id), madeAt: r.created_at,
      copies: copies.all(r.id).map((c) => ({ ...c, text: text.get(c.id, this.primary ?? '')?.text ?? '' })),
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
      // Newest first, so a place takes the service of its latest mention; findings from before there was one: other
      const service = serviceOf(found.service);
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
        note(`road:${m.ids[0]}`, { kind: 'road', name: m.name, level: m.level, lines: m.lines, anywhere: Boolean(m.all), service }, r, m.said);
      };
      for (const s of found.roads ?? []) road(find(s));
      for (const a of found.addresses ?? []) {
        const parts = addressRoads(a).map(find);
        parts.forEach(road);
        const [p, q] = parts;
        const corner = p && q && p.ids[0] !== q.ids[0] ? this.roads.corner(p, q) : null;
        if (corner) note(`corner:${corner.join(',')}`, { kind: 'corner', name: `${p.name} and ${q.name}`, level: 'exact', point: corner, service }, r, a);
      }
      if (!any) continue;
      out.transmissions[r.id] = {
        startedAt: r.started_at, channel: r.channel_name, summary: found.summary, incident: found.incident, service,
        text: text.get(r.id, this.primary ?? '')?.text ?? '',
      };
    }
    for (const [key, p] of places) {
      out.features.features.push({
        type: 'Feature',
        geometry: p.kind === 'road' ? { type: 'MultiLineString', coordinates: p.lines } : { type: 'Point', coordinates: p.point },
        properties: { key, kind: p.kind, level: p.level, count: p.ids.length, last: p.last, service: p.service },
      });
      out.places[key] = { kind: p.kind, name: p.name, level: p.level, said: [...p.said], ids: p.ids, last: p.last, anywhere: p.anywhere ?? false, service: p.service };
    }
    return out;
  }

  /** Delete every finding and match (the watch list stays). */
  forget() {
    this.queue = [];
    this.db.exec('DELETE FROM finding_hits; DELETE FROM finding_corrections; DELETE FROM findings;');
    return this.settings();
  }

  /** Delete findings past keepDays, and those whose transmission is gone. */
  sweep() {
    const cutoff = this.now() - Number(this.get('keepDays')) * 86_400_000;
    this.db.prepare(`DELETE FROM finding_hits WHERE created_at < ?
                       OR transmission_id NOT IN (SELECT id FROM transmissions)`).run(cutoff);
    this.db.prepare(`DELETE FROM finding_corrections WHERE created_at < ?
                       OR transmission_id NOT IN (SELECT id FROM transmissions)
                       OR by_id NOT IN (SELECT id FROM transmissions)`).run(cutoff);
    this.db.prepare(`DELETE FROM findings WHERE created_at < ?
                       OR transmission_id NOT IN (SELECT id FROM transmissions)`).run(cutoff);
  }
}
