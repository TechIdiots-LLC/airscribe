/**
 * The day so far, summed up: each hour's findings, once the hour is over and read, are given to the model a chunk
 * at a time, and it picks out what happened, each item naming the findings it came from. After each hour, the
 * day's overview is written again from all of its items: once for every radio, and once for each. A day's numbers
 * are Insights'; this is what happened. See docs/findings.md#the-day-so-far.
 */

const HOUR = 3_600_000;
const CHUNK = 60;              // findings in one question
const LOOK_BACK_H = 36;        // hours looked at for ones still to sum up
const PER_RUN = 6;             // hours summed up in one go, the latest first
const RETRY_MS = 30 * 60_000;  // an hour that failed waits this long before it's tried again
const OVERVIEW_CHARS = 40_000; // about 10k tokens of items for an overview
const RUN_MS = 5 * 60_000;

const HOUR_SYSTEM = `You sum up an hour of radio traffic (police, fire, EMS, public works, amateur radio), from what a
model found in each transmission. Each line is one finding: its number, channel, time, and what was found, with a
person's note on it when there is one (trust the note). Answer with JSON:
- items: what happened this hour, each {"text": one plain, specific sentence (the units, the place, what happened
  and how it ended, if said), "findings": [the numbers of the findings it comes from]}. One item for each call or
  conversation, however many transmissions it took. Leave out routine traffic (acknowledgments, radio checks, units
  clearing or going in and out of service) unless it's part of a call. For amateur radio, say what was talked about
  (equipment, antennas, bands, nets, events). Never add what the findings don't say. [] if nothing happened.`;
const HOUR_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, findings: { type: 'array', items: { type: 'integer' } } },
        required: ['text', 'findings'],
      },
    },
  },
  required: ['items'],
};

const DAY_SYSTEM = `You write the overview of a day of radio traffic so far, from what happened each hour. Each line
is one thing that happened: its time, channel and a sentence. Answer with JSON:
- overview: 3 to 6 plain sentences on the day's main events, the most serious first (fires, crashes, injuries,
  searches, arrests), with their times and places; then, briefly, what else kept them busy, and what the hams talked
  about if they were on the air. Only what's listed: never add or guess.`;
const DAY_SCHEMA = { type: 'object', properties: { overview: { type: 'string' } }, required: ['overview'] };

/** The local hour a time is in, as the time it began. */
export function hourOf(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** The local day a time is in: "2026-11-25". */
export function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A local day's first and last moments. */
function dayBounds(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  return [from, new Date(y, m - 1, d + 1).getTime()];
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export class Digest {
  /**
   * @param {import('./findings.js').Findings} findings - Its database, clock and model.
   */
  constructor(findings) {
    this.findings = findings;
    this.db = findings.db;
    this.running = null;
    this.lastError = null;
    this.failed = new Map();   // hour → when it last failed
    this.db.exec(`
      -- Each hour summed up: how many findings it had then, so one read late is summed up again
      CREATE TABLE IF NOT EXISTS digest_hours (
        hour INTEGER PRIMARY KEY, count INTEGER NOT NULL, made_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS digest_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour INTEGER NOT NULL, at INTEGER NOT NULL,
        channel TEXT, mac TEXT, service TEXT,
        text TEXT NOT NULL, findings TEXT NOT NULL);   -- JSON: the findings' transmission ids
      CREATE INDEX IF NOT EXISTS digest_items_hour ON digest_items(hour);
      -- A day's overview: for every radio (scope ''), and for each (its address)
      CREATE TABLE IF NOT EXISTS digest_overviews (
        day TEXT NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL, items INTEGER NOT NULL, made_at INTEGER NOT NULL,
        PRIMARY KEY (day, scope));
    `);
  }

  now() {
    return this.findings.now();
  }

  /** Whether it sums up hours by itself: on with Findings, unless turned off. */
  on() {
    return this.findings.enabled() && this.findings.store.setting('findings.digest') !== '0';
  }

  start() {
    this.timer = setInterval(() => {
      if (this.on() && !this.findings.queue.length && !this.findings.running) {
        this.run().catch((e) => console.error(`[findings] the day so far: ${e.message}`));
      }
    }, RUN_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Findings with something said, from one time to another, oldest first. */
  rows(from, to) {
    return this.db.prepare(`
      SELECT t.id, t.started_at, t.channel_name, t.mac, f.result, n.note
        FROM findings f JOIN transmissions t ON t.id = f.transmission_id
        LEFT JOIN finding_notes n ON n.transmission_id = t.id
       WHERE f.status = 'done' AND t.started_at >= ? AND t.started_at < ?
       ORDER BY t.started_at`).all(from, to)
      .map((r) => ({ ...r, found: JSON.parse(r.result) }))
      .filter((r) => r.found.summary);
  }

  /**
   * The hours to sum up: over, with what was heard in them read (Findings waits for the other engines), and not
   * summed up yet, or summed up before more of them was read.
   * @returns {number[]} Their starts, the latest first: today's fill in first after a while away.
   */
  due() {
    const now = this.now();
    const grace = (this.findings.number('waitMinutes') + 5) * 60_000;
    const until = hourOf(now - grace);
    const from = hourOf(now - LOOK_BACK_H * HOUR);
    const counts = new Map();
    for (const r of this.rows(from, until)) counts.set(hourOf(r.started_at), (counts.get(hourOf(r.started_at)) ?? 0) + 1);
    const done = new Map(this.db.prepare('SELECT hour, count FROM digest_hours WHERE hour >= ?').all(from).map((r) => [r.hour, r.count]));
    return [...counts].filter(([h, n]) => !done.has(h) || n > done.get(h)).map(([h]) => h).sort((a, b) => b - a);
  }

  /**
   * Sum up one hour: its findings, a chunk at a time, to the model; what it picked out kept, each item with the
   * channel and radio of the findings it names. An item naming none of its chunk's findings is dropped.
   * @param {number} hour - The hour's start.
   * @returns {Promise<number>} How many items.
   */
  async sumHour(hour) {
    const rows = this.rows(hour, hour + HOUR);
    // A channel's findings together, so a call is in one chunk
    rows.sort((a, b) => String(a.channel_name).localeCompare(String(b.channel_name)) || a.started_at - b.started_at);
    const items = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const byId = new Map(chunk.map((r) => [r.id, r]));
      const line = (r) => {
        const f = r.found;
        const more = [f.incident, f.addresses?.length ? `at ${f.addresses.join('; ')}` : '', f.units?.length ? `units ${f.units.join(', ')}` : '',
          f.plates?.length ? `plates ${f.plates.join(', ')}` : '', r.note ? `a person's note: ${r.note}` : ''].filter(Boolean).join('; ');
        return `#${r.id} [${r.channel_name ?? 'channel unknown'}, ${clock(r.started_at)}] ${f.summary}${more ? ` (${more})` : ''}`;
      };
      const user = `The hour from ${clock(hour)} to ${clock(hour + HOUR)} on ${dayOf(hour)}.\n\nFindings:\n${chunk.map(line).join('\n')}`;
      const { reply } = await this.findings.ask(user, { system: HOUR_SYSTEM, schema: HOUR_SCHEMA, name: 'hour', most: 8192 });
      for (const it of Array.isArray(reply?.items) ? reply.items : []) {
        const text = String(it?.text ?? '').trim().slice(0, 400);
        const ids = [...new Set((Array.isArray(it?.findings) ? it.findings : []).map(Number).filter((n) => byId.has(n)))];
        if (!text || !ids.length) continue;
        const cited = ids.map((n) => byId.get(n));
        // Where it was: the channel most of its findings were on
        const most = (k) => [...cited.reduce((m, r) => m.set(r[k], (m.get(r[k]) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0];
        const services = cited.map((r) => r.found.service).filter((s) => s && s !== 'other');
        items.push({
          at: Math.min(...cited.map((r) => r.started_at)), channel: most('channel_name'), mac: most('mac'),
          service: services[0] ?? cited[0].found.service ?? 'other', text, findings: ids,
        });
      }
    }
    const put = this.db.prepare(`INSERT INTO digest_items (hour, at, channel, mac, service, text, findings)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM digest_items WHERE hour = ?').run(hour);
      for (const it of items) put.run(hour, it.at, it.channel, it.mac, it.service, it.text, JSON.stringify(it.findings));
      this.db.prepare(`INSERT INTO digest_hours (hour, count, made_at) VALUES (?, ?, ?)
                       ON CONFLICT(hour) DO UPDATE SET count = excluded.count, made_at = excluded.made_at`)
        .run(hour, rows.length, this.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return items.length;
  }

  /** A day's items, for one radio or every one, oldest first. */
  items(day, { radio, channel } = {}) {
    const [from, to] = dayBounds(day);
    return this.db.prepare(`SELECT id, hour, at, channel, mac, service, text, findings FROM digest_items
                             WHERE at >= ? AND at < ? AND (? IS NULL OR mac = ?) AND (? IS NULL OR channel = ?)
                             ORDER BY at, id`)
      .all(from, to, radio || null, radio || null, channel || null, channel || null)
      .map((r) => ({ ...r, findings: JSON.parse(r.findings) }));
  }

  /**
   * Write a day's overview again from its items, for every radio or one. Too many to read at once, those from the
   * most transmissions are kept.
   * @param {string} day - "2026-11-25".
   * @param {string} [scope] - A radio's address; '' for every radio.
   * @returns {Promise<string|null>} The overview.
   */
  async overview(day, scope = '') {
    let items = this.items(day, { radio: scope || null });
    if (!items.length) {
      this.db.prepare('DELETE FROM digest_overviews WHERE day = ? AND scope = ?').run(day, scope);
      return null;
    }
    const line = (it) => `${clock(it.at)} [${it.channel ?? 'channel unknown'}] ${it.text}`;
    if (items.reduce((n, it) => n + line(it).length + 1, 0) > OVERVIEW_CHARS) {
      const kept = new Set();
      let n = 0;
      for (const it of [...items].sort((a, b) => b.findings.length - a.findings.length)) {
        if (n + line(it).length > OVERVIEW_CHARS) continue;
        kept.add(it.id);
        n += line(it).length + 1;
      }
      items = items.filter((it) => kept.has(it.id));
    }
    const user = `${day}, so far:\n${items.map(line).join('\n')}`;
    const { reply } = await this.findings.ask(user, { system: DAY_SYSTEM, schema: DAY_SCHEMA, name: 'day' });
    const text = String(reply?.overview ?? '').trim().slice(0, 3000);
    this.db.prepare(`INSERT INTO digest_overviews (day, scope, text, items, made_at) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(day, scope) DO UPDATE SET text = excluded.text, items = excluded.items, made_at = excluded.made_at`)
      .run(day, scope, text, items.length, this.now());
    return text;
  }

  /**
   * Sum up the hours that are due, then write their days' overviews again: for every radio, and each that was
   * heard that day. One at a time. An hour that fails stops the run and waits a while, so it can't hold up the rest.
   * @returns {Promise<{hours: number, items: number, days: string[]}>}
   */
  run() {
    this.running ??= (async () => {
      const hours = this.due().filter((h) => !(this.failed.get(h) > this.now() - RETRY_MS)).slice(0, PER_RUN);
      let items = 0;
      let summed = 0;
      const days = new Set();
      let failure = null;
      try {
        for (const h of hours) {
          try {
            items += await this.sumHour(h);
          } catch (e) {
            this.failed.set(h, this.now());
            failure = e;
            break;
          }
          this.failed.delete(h);
          summed++;
          days.add(dayOf(h));
        }
        for (const day of days) {
          const radios = [...new Set(this.items(day).map((it) => it.mac).filter(Boolean))];
          for (const scope of ['', ...radios]) await this.overview(day, scope);
        }
        if (failure) throw failure;
        this.lastError = null;
      } catch (e) {
        this.lastError = { at: this.now(), error: e.message };
        throw e;
      }
      return { hours: summed, items, days: [...days] };
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /**
   * What the Findings tab shows: a day's overview (every radio's, or one radio's) and its items by hour, with the
   * days there are.
   * @param {{day?: string, radio?: string, channel?: string}} [o] - The day (today by default), and one radio or channel.
   * @returns {object} The day.
   */
  day({ day, radio, channel } = {}) {
    const d = day || dayOf(this.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw fail('a day is written 2026-11-25');
    const ov = channel ? null : this.db.prepare('SELECT text, items, made_at FROM digest_overviews WHERE day = ? AND scope = ?').get(d, radio || '');
    const items = this.items(d, { radio, channel });
    const hours = [];
    for (const it of items) {
      if (hours.at(-1)?.hour !== it.hour) hours.push({ hour: it.hour, items: [] });
      hours.at(-1).items.push({ id: it.id, at: it.at, channel: it.channel, radio: it.mac, service: it.service, text: it.text, findings: it.findings });
    }
    const [from, to] = dayBounds(d);
    const last = this.db.prepare('SELECT max(hour) AS h FROM digest_hours WHERE hour >= ? AND hour < ?').get(from, to).h;
    const days = this.db.prepare('SELECT DISTINCT day FROM digest_overviews ORDER BY day DESC').all().map((r) => r.day);
    return {
      day: d, today: dayOf(this.now()), days: [...new Set([dayOf(this.now()), d, ...days])].sort().reverse(),
      overview: ov ? { text: ov.text, items: ov.items, madeAt: ov.made_at } : null,
      throughHour: last ?? null, hours: hours.reverse(), on: this.on(), lastError: this.lastError,
    };
  }

  /** Delete what's older than Findings keeps, or everything. */
  sweep(cutoff = Infinity) {
    const day = cutoff === Infinity ? '9999-99-99' : dayOf(cutoff);
    this.db.prepare('DELETE FROM digest_items WHERE hour < ?').run(cutoff === Infinity ? Number.MAX_SAFE_INTEGER : cutoff);
    this.db.prepare('DELETE FROM digest_hours WHERE hour < ?').run(cutoff === Infinity ? Number.MAX_SAFE_INTEGER : cutoff);
    this.db.prepare('DELETE FROM digest_overviews WHERE day < ?').run(day);
  }
}
