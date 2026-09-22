import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, guessModel, normalizeMac } from './models.js';
import { requireToken } from './auth.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Wrap an async handler so a rejection becomes a 502 instead of a hang.
 * @param {Function} fn - Async route handler.
 * @returns {import('express').RequestHandler} The wrapped handler.
 */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => res.status(502).json({ error: e.message }));

/**
 * Build the HTTP app: static UI, JSON API, and a server-sent event stream.
 * @param {object} o - Dependencies.
 * @param {import('./manager.js').Manager} o.manager - Radio orchestration.
 * @param {import('./store.js').Store} o.store - Persistence.
 * @param {import('./sidecar.js').Sidecar} o.sidecar - Bluetooth helper.
 * @param {{tokens: string[]}} o.auth - Auth config.
 * @param {string} o.dataDir - Data directory (clips live under it).
 * @returns {import('express').Express} The app.
 */
export function createApp({ manager, store, sidecar, auth, dataDir }) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.static(PUBLIC));

  const api = express.Router();
  api.use(requireToken(auth));

  api.get('/models', (req, res) => res.json(MODELS));
  api.get('/radios', (req, res) => res.json(manager.radios()));

  // Radios the host can see. Each is annotated with a model guess and whether
  // it is already saved, so the UI can offer a one-click add.
  api.get(
    '/scan',
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

  api.post('/radios', (req, res) => {
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

  api.delete(
    '/radios/:mac',
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
  api.post('/transcribe-missing', (req, res) => {
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    try {
      const queued = manager.retranscribe(engine, Number(req.query.limit) || 500);
      res.status(202).json({ queued, engine: engine ?? manager.primary });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  api.post('/transmissions/:id/transcribe', (req, res) => {
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

  api.get('/transmissions/:id/audio', (req, res) => {
    const t = store.transmission(Number(req.params.id));
    // audio_file is written by this server, but resolve it under clips/ anyway.
    const root = resolve(dataDir, 'clips');
    const file = t && resolve(root, t.audio_file);
    if (!t || !file.startsWith(root + sep) || !existsSync(file)) {
      return res.status(404).json({ error: 'not found' });
    }
    const headers = { 'Content-Type': 'audio/wav' };
    // Only the download link says attachment. An <audio> element playing the
    // clip inline wants it served as a media file.
    if (req.query.download !== undefined) {
      headers['Content-Disposition'] =
        `attachment; filename="${t.mac.replaceAll(':', '')}-${t.started_at}.wav"`;
    }
    // sendFile sets Content-Length and honours Range requests; piping a read
    // stream did neither, so players could not show a duration or seek.
    res.sendFile(file, { headers, acceptRanges: true }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  api.get('/transmissions/:id/text', (req, res) => {
    const t = store.transmission(Number(req.params.id));
    if (!t?.text) return res.status(404).json({ error: 'no transcript' });
    res.type('text/plain').attachment(`${t.mac.replaceAll(':', '')}-${t.started_at}.txt`).send(t.text + '\n');
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
