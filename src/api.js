import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, guessModel, normalizeMac } from './models.js';
import { createAuth } from './auth.js';
import { PUBLISH_DEFAULTS, publicCutoff, publishable, publicView } from './publish.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Wrap an async handler so a rejection becomes a 502 instead of a hang.
 * @param {Function} fn - Async route handler.
 * @returns {import('express').RequestHandler} The wrapped handler.
 */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => res.status(502).json({ error: e.message }));

/**
 * One transmission as readable text: its context, then each engine's version.
 * @param {object} t - A transmission row.
 * @param {object[]} scripts - Its transcripts.
 * @returns {string} The file's contents.
 */
function describe(t, scripts) {
  const where = t.channel_name || (t.channel === null || t.channel === undefined ? null : `channel ${t.channel}`);
  const hz = t.channel_hz ? `${(t.channel_hz / 1e6).toFixed(4)} MHz` : null;
  const width = Math.max(1, ...scripts.map((s) => s.engine.length));
  return [
    `${new Date(t.started_at).toISOString()}  ${t.mac}`,
    [where, hz].filter(Boolean).join(' · ') || 'channel unknown',
    `${(t.duration_ms / 1000).toFixed(1)}s · ${t.transmit ? 'sent' : 'heard'}`,
    '',
    ...scripts.map((s) => {
      const body = s.status === 'done' ? (s.text || '').trim() : `<${s.status}: ${s.error ?? ''}>`;
      return `${s.engine.padEnd(width)}  ${body}`;
    }),
    '',
  ].join('\n');
}

/**
 * Escape one CSV cell.
 * @param {unknown} v - The value.
 * @returns {string} A quoted cell where the content needs it.
 */
function csvCell(v) {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

/**
 * Serve one clip's WAV.
 *
 * Shared by the operator's route and the public one so both resolve the path
 * the same way. `sendFile` sets Content-Length and honours Range, which a
 * piped read stream did not, so a player can show a duration and seek.
 * @param {import('express').Response} res - The response.
 * @param {object} t - The transmission row.
 * @param {string} dataDir - Where clips live.
 * @param {boolean} download - Whether to offer it as a file rather than media.
 * @param {Function} [onError] - Called if the file cannot be sent.
 * @returns {void}
 */
function sendClip(res, t, dataDir, download, onError) {
  // audio_file is written by this server, but resolve it under clips/ anyway.
  const root = resolve(dataDir, 'clips');
  const file = resolve(root, t.audio_file);
  if (!file.startsWith(root + sep) || !existsSync(file)) {
    return res.status(404).json({ error: 'not found' });
  }
  const headers = { 'Content-Type': 'audio/wav' };
  // Only a download link says attachment; an <audio> element playing it
  // inline wants it served as media.
  if (download) {
    headers['Content-Disposition'] =
      `attachment; filename="${t.mac.replaceAll(':', '')}-${t.started_at}.wav"`;
  }
  res.sendFile(file, { headers, acceptRanges: true }, onError ?? (() => {}));
}

/** Paths a public listener may serve. Everything else is 404 there. */
const PUBLIC_API = new Set([
  '/session', '/login', '/logout',
  '/public/transmissions', '/public/filters',
]);

/** Whether a path is a public per-clip route, which carry an id. */
const PUBLIC_CLIP = /^\/public\/transmissions\/\d+\/(audio|text)$/;

/**
 * Build the HTTP app: static UI, JSON API, and a server-sent event stream.
 *
 * One app, and where `adminPort` is set, two listeners in front of it. The
 * public one serves only what `PUBLIC_API` allows and answers **404** for the
 * rest: a refusal confirms there is something behind it, an absence does not.
 * The gate is keyed on the port the request arrived on rather than a header,
 * because a header is something the caller controls.
 * @param {object} o - Dependencies.
 * @param {import('./manager.js').Manager} o.manager - Radio orchestration.
 * @param {import('./store.js').Store} o.store - Persistence.
 * @param {import('./sidecar.js').Sidecar} o.sidecar - Bluetooth helper.
 * @param {object} o.config - The whole config, for auth and the port split.
 * @param {string} o.dataDir - Data directory (clips live under it).
 * @returns {import('express').Express} The app.
 */
export function createApp({ manager, store, sidecar, config, dataDir }) {
  const app = express();
  const auth = createAuth(config);
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const onAdminPort = (req) =>
    !config.adminPort || req.socket?.localPort === Number(config.adminPort);

  if (config.adminPort) {
    app.use('/api', (req, res, next) => {
      if (onAdminPort(req) || PUBLIC_API.has(req.path) || PUBLIC_CLIP.test(req.path)) {
        return next();
      }
      res.status(404).json({ error: 'not found' });
    });
  }
  // On the public listener, / is the public page rather than the console.
  // Ahead of the static mount, which would otherwise hand out index.html on
  // both ports — the console is harmless without a credential, but serving
  // it publicly invites people to try one.
  if (config.adminPort) {
    app.get('/', (req, res, next) => {
      if (onAdminPort(req)) return next();
      res.sendFile(join(PUBLIC, 'live.html'));
    });
  }
  app.use(express.static(PUBLIC));

  const publish = { ...PUBLISH_DEFAULTS, ...(config.publish ?? {}) };

  /**
   * The one publishable row, or null.
   *
   * Every public per-clip route goes through this, so the delay cannot be
   * enforced on the listing and forgotten on a download.
   * @param {string|number} id - Transmission id.
   * @returns {object | null} The row, if a visitor may see it.
   */
  const publicRow = (id) => {
    const row = store.transmission(Number(id));
    if (!row) return null;
    return publishable(row, store.radio(row.mac), publish) ? row : null;
  };

  const api = express.Router();
  // Signing in has to be reachable before one is signed in.
  api.post('/login', (req, res) => auth.login(req, res));
  api.post('/logout', (req, res) => auth.logout(req, res));
  api.get('/session', (req, res) => auth.session(req, res));
  // ---- the public surface -------------------------------------------
  // No credential: this is what the node has chosen to publish. Everything
  // here is filtered by the same predicate, never by the caller's request.

  api.get('/public/filters', (req, res) => {
    if (!publish.enabled) return res.json({ enabled: false, groups: [], radios: [] });
    const radios = store.radios().filter((r) => r.public);
    res.json({
      enabled: true,
      delayMinutes: publish.delayMinutes,
      audio: Boolean(publish.audio),
      groups: [...new Set(radios.map((r) => r.group).filter(Boolean))],
      radios: radios.map((r) => ({ name: r.name, group: r.group ?? null })),
    });
  });

  api.get('/public/transmissions', (req, res) => {
    if (!publish.enabled) return res.json([]);
    const rows = store.transmissions({
      publicOnly: true,
      notAfter: publicCutoff(publish),
      group: req.query.group ? String(req.query.group) : undefined,
      channel: req.query.channel ? String(req.query.channel) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      limit: Math.min(Number(req.query.limit) || 100, 200),
    });
    res.json(rows.map((r) => publicView(r, publish, manager.primary)));
  });

  api.get('/public/transmissions/:id/text', (req, res) => {
    const row = publish.transcripts === false ? null : publicRow(req.params.id);
    const view = row && publicView(row, publish, manager.primary);
    if (!view?.text) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(`${view.text}
`);
  });

  api.get('/public/transmissions/:id/audio', (req, res) => {
    // Two gates, not one: clips may be withheld even where transcripts are
    // published, because a clip is somebody's voice.
    const row = publish.audio ? publicRow(req.params.id) : null;
    if (!row) return res.status(404).json({ error: 'not found' });
    sendClip(res, row, dataDir, false);
  });


  // Everything past here needs at least a viewer.
  api.use(auth.requireRole('viewer'));

  // ---- everything past here is the operator's -------------------------

  api.get('/models', (req, res) => res.json(MODELS));
  api.get('/radios', (req, res) => res.json(manager.radios()));

  // Radios the host can see. Each is annotated with a model guess and whether
  // it is already saved, so the UI can offer a one-click add.
  api.get(
    '/scan',
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const found = await sidecar.call('scan');
      res.json(
        found.map((d) => ({
          ...d,
          mac: normalizeMac(d.mac),
          model: guessModel(d.name),
          saved: !!store.radio(normalizeMac(d.mac)),
        })),
      );
    }),
  );

  api.post('/radios', auth.requireRole('admin'), (req, res) => {
    const mac = normalizeMac(req.body?.mac);
    if (!mac) return res.status(400).json({ error: 'mac must be 12 hex digits' });
    const model = req.body.model ?? null;
    if (model && !MODELS.some((m) => m.id === model)) {
      return res.status(400).json({ error: `unknown model ${model}` });
    }
    const name = String(req.body.name || model || mac).slice(0, 60);
    store.saveRadio({ mac, name, model });
    res.status(201).json(store.radio(mac));
  });

  // Publishing is a deliberate act, separate from adding a radio.
  api.patch('/radios/:mac', auth.requireRole('admin'), (req, res) => {
    const mac = normalizeMac(req.params.mac);
    if (!mac || !store.radio(mac)) return res.status(404).json({ error: 'unknown radio' });
    res.json(store.updateRadio(mac, {
      name: req.body?.name,
      public: req.body?.public,
      group: req.body?.group,
    }));
  });

  api.get('/groups', (req, res) => res.json(store.groups()));

  api.delete(
    '/radios/:mac',
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const mac = normalizeMac(req.params.mac);
      if (!mac) return res.status(400).json({ error: 'bad mac' });
      await manager.disconnect(mac).catch(() => {});
      store.deleteRadio(mac);
      res.status(204).end();
    }),
  );

  for (const action of ['connect', 'disconnect']) {
    api.post(
      `/radios/:mac/${action}`,
      auth.requireRole('admin'),
      wrap(async (req, res) => {
        const mac = normalizeMac(req.params.mac);
        if (!mac || !store.radio(mac)) return res.status(404).json({ error: 'unknown radio' });
        await manager[action](mac);
        res.status(202).json({ ok: true });
      }),
    );
  }

  api.get('/transmissions', (req, res) => {
    const mac = req.query.mac ? normalizeMac(String(req.query.mac)) : undefined;
    res.json(store.transmissions({ mac, q: req.query.q && String(req.query.q), limit: req.query.limit }));
  });

  // What engines exist, and which is the default. The UI labels transcripts
  // with these.
  api.get('/engines', (req, res) =>
    res.json({ engines: [...manager.engines.keys()], primary: manager.primary, extra: manager.extra }),
  );

  // Catch up clips an engine has not managed. The audio outlives a failed
  // transcription, so a backlog from a missing module is recoverable.
  api.post('/transcribe-missing', auth.requireRole('admin'), (req, res) => {
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    try {
      const queued = manager.retranscribe(engine, Number(req.query.limit) || 500);
      res.status(202).json({ queued, engine: engine ?? manager.primary });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  api.post('/transmissions/:id/transcribe', auth.requireRole('admin'), (req, res) => {
    const t = store.transmission(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'unknown transmission' });
    const engineName = req.query.engine ? String(req.query.engine) : manager.primary;
    if (!manager.engines.has(engineName)) {
      return res.status(400).json({ error: `unknown engine ${engineName}` });
    }
    const wav = manager.engineWavFor(t);
    if (!wav) return res.status(409).json({ error: 'the audio for this clip is gone' });
    manager.enqueue({ priority: 1, id: t.id, engineName, wav });
    res.status(202).json({ ok: true, engine: engineName });
  });

  // The whole feed at once. Comparing models over hundreds of clips is the
  // reason to run several, and that is not a per-clip download.
  api.get('/transmissions/export', (req, res) => {
    const mac = req.query.mac ? normalizeMac(String(req.query.mac)) : undefined;
    const rows = store.transmissions({
      mac,
      q: req.query.q && String(req.query.q),
      limit: req.query.limit ?? 500,
    });
    const stamp = new Date().toISOString().slice(0, 10);

    if (req.query.format === 'csv') {
      // A row per transcript rather than per transmission: engines differ
      // between clips, so a column each would be mostly empty.
      const head = ['id', 'started_at', 'iso', 'mac', 'channel', 'channel_name',
        'channel_hz', 'duration_ms', 'transmit', 'engine', 'status', 'text'];
      const lines = [head.join(',')];
      for (const t of rows) {
        for (const s of t.transcripts ?? []) {
          lines.push([t.id, t.started_at, new Date(t.started_at).toISOString(), t.mac,
            t.channel, t.channel_name, t.channel_hz, t.duration_ms, t.transmit,
            s.engine, s.status, s.text].map(csvCell).join(','));
        }
      }
      return res.type('text/csv').attachment(`airscribe-${stamp}.csv`).send(`${lines.join('\n')}\n`);
    }

    if (req.query.format === 'txt') {
      return res
        .type('text/plain')
        .attachment(`airscribe-${stamp}.txt`)
        .send(rows.map((t) => describe(t, t.transcripts ?? [])).join('\n'));
    }

    res.attachment(`airscribe-${stamp}.json`).json(rows);
  });

  api.get('/transmissions/:id/audio', (req, res) => {
    const t = store.transmission(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'not found' });
    sendClip(res, t, dataDir, req.query.download !== undefined, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  api.get('/transmissions/:id/text', (req, res) => {
    const t = store.transmission(Number(req.params.id));
    const scripts = t?.transcripts ?? [];
    if (!t || !scripts.length) return res.status(404).json({ error: 'no transcript' });
    const stem = `${t.mac.replaceAll(':', '')}-${t.started_at}`;
    if (req.query.format === 'json') return res.attachment(`${stem}.json`).json(t);
    // Every engine, not just the default: where they disagree the
    // disagreement is the useful part, and a download that quietly picks one
    // hides it.
    res.type('text/plain').attachment(`${stem}.txt`).send(describe(t, scripts));
  });

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (u) => res.write(`data: ${JSON.stringify(u)}\n\n`);
    manager.on('update', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      manager.off('update', send);
    });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}
