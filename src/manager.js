import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Segmenter } from './segmenter.js';
import { encodeWav, halveRate } from './wav.js';

/**
 * Ties the sidecar, the segmenter, the transcriber and the store together.
 *
 * One Segmenter per connected radio, driven by the radio's own audio-run
 * markers. Finished clips are written to disk, recorded as `pending`, and
 * transcribed one at a time: a speech model saturates a CPU on a single clip,
 * so running clips in parallel would only make each slower.
 *
 * Emits 'update' with {type, ...} for the web UI's event stream.
 */
export class Manager extends EventEmitter {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./sidecar.js').Sidecar} o.sidecar - Bluetooth helper.
   * @param {import('./store.js').Store} o.store - Persistence.
   * @param {import('./stt/index.js').SttEngine} o.engine - Transcriber.
   * @param {object} o.audio - The `audio` config section.
   * @param {string} o.dataDir - Where clips are written.
   */
  constructor({ sidecar, store, engine, engines, primary, extra, audio, dataDir, reconnect }) {
    super();
    Object.assign(this, { sidecar, store, audio, dataDir });
    // One engine or several. A lone engine becomes a set of one, so there is
    // a single path through the rest of this class.
    this.engines = engines ?? new Map([[engine.name, engine]]);
    this.primary = primary ?? engine.name;
    this.extra = extra ?? [];
    this.jobs = [];       // {priority, id, engineName, wav}
    this.working = null;  // the in-flight pump, or null
    this.reconnect = { baseMs: 5000, maxMs: 300000, ...reconnect };
    this.state = new Map(); // mac -> {state, rx, tx, rssi}
    this.segmenters = new Map();
    this.wanted = new Set(); // radios that should be connected
    this.retries = new Map(); // mac -> {timer, delay}
    sidecar.on('event', (e) => this.onEvent(e));
    sidecar.on('restart', () => this.reconnectAll());
  }

  /**
   * @param {object} e - A sidecar event.
   * @returns {void}
   */
  onEvent(e) {
    switch (e.event) {
      case 'status': {
        const s = { ...this.state.get(e.mac), state: e.state, rssi: e.rssi, detail: e.detail };
        this.state.set(e.mac, s);
        if (e.state === 'connected') {
          this.clearRetry(e.mac);
        } else {
          // A radio that drops mid-transmission still owes us the clip so far.
          this.segmenters.get(e.mac)?.flush();
          s.rx = false;
          s.tx = false;
          // Dropping is normal — a radio goes out of range, its battery dies,
          // someone turns it off. Only an explicit disconnect takes it out of
          // `wanted`, so anything else is worth waiting for.
          if (this.wanted.has(e.mac)) this.scheduleRetry(e.mac);
        }
        this.emit('update', { type: 'status', mac: e.mac, ...s });
        break;
      }
      // The BlueZ backend polls the radio and reports what it says. Squelch
      // and RSSI drive the indicator; the run markers still own segmentation.
      case 'radio-status':
        this.setActivity(e.mac, { rx: !!e.in_rx, tx: !!e.in_tx, rssi: e.rssi });
        break;
      case 'audio-start':
        this.segmenterFor(e.mac).begin({ transmit: !!e.transmit });
        this.setActivity(e.mac, { rx: !e.transmit, tx: !!e.transmit });
        break;
      case 'audio-end':
        this.segmenterFor(e.mac).end();
        this.setActivity(e.mac, { rx: false, tx: false });
        break;
      case 'audio':
        this.segmenterFor(e.mac).push(Buffer.from(e.pcm, 'base64'), {
          rx: !!e.rx,
          transmit: !!e.transmit,
        });
        // A backend that sends no run markers still drives the indicator.
        this.setActivity(e.mac, { rx: !!e.rx, tx: !!e.transmit });
        break;
      // What one transmission's audio actually amounted to. Logged rather
      // than shown, because it answers a question about the capture, not
      // about the traffic: a clip shorter than the transmission it came from
      // shows up here as PCM falling short of what the SBC should yield.
      case 'run-stats':
        console.log(
          `[audio] ${e.mac} ${e.frames} SBC frames -> ${e.seconds}s` +
            (e.pcm_bytes === e.expected_pcm_bytes
              ? ''
              : ` (expected ${e.expected_pcm_bytes} bytes of PCM, got ${e.pcm_bytes})`),
        );
        break;
      // Something the sidecar could not do — a missing SBC decoder, a radio
      // that stopped answering. Logged as well as forwarded, because these
      // explain an otherwise silent absence of transcripts.
      case 'sidecar-error':
        console.error(`[sidecar] ${e.mac ? `${e.mac}: ` : ''}${e.error}`);
        this.emit('update', { type: 'error', mac: e.mac, error: e.error });
        break;
      default:
        break;
    }
  }

  /**
   * Update the receive/transmit indicator, emitting only on a real change so
   * the event stream does not carry one message per 100 ms of audio.
   * @param {string} mac - Radio MAC.
   * @param {{rx: boolean, tx: boolean}} a - The new activity.
   * @returns {void}
   */
  setActivity(mac, a) {
    const prev = this.state.get(mac) ?? {};
    const next = { ...prev, ...a };
    // Emitted on change only, so a radio polled once a second does not put a
    // message per second on the event stream. RSSI counts as a change: it is
    // how anyone watching can tell the radio is being polled at all, and
    // whether it is hearing anything.
    if (prev.rx === next.rx && prev.tx === next.tx && prev.rssi === next.rssi) return;
    this.state.set(mac, next);
    this.emit('update', { type: 'activity', mac, rx: next.rx, tx: next.tx, rssi: next.rssi });
  }

  /**
   * @param {string} mac - Radio MAC.
   * @returns {Segmenter} That radio's segmenter, created on first use.
   */
  segmenterFor(mac) {
    let seg = this.segmenters.get(mac);
    if (!seg) {
      seg = new Segmenter({ ...this.audio, onClip: (clip) => this.onClip(mac, clip) });
      this.segmenters.set(mac, seg);
    }
    return seg;
  }

  /**
   * @param {string} mac - Radio that produced the clip.
   * @param {{startMs: number, durationMs: number, pcm: Buffer, transmit: boolean}} clip - The audio.
   * @returns {void}
   */
  onClip(mac, clip) {
    const startedAt = Date.now() - Math.round(clip.durationMs);
    const dir = join(this.dataDir, 'clips', mac.replaceAll(':', ''));
    mkdirSync(dir, { recursive: true });
    const name = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.wav`;
    const audioFile = join(mac.replaceAll(':', ''), name);
    writeFileSync(join(this.dataDir, 'clips', audioFile), encodeWav(clip.pcm, this.audio.sampleRate));
    // Whisper wants 16 kHz; a second file at that rate is what the engine reads.
    const engineWav = join(dir, name.replace('.wav', '.16k.wav'));
    writeFileSync(engineWav, encodeWav(halveRate(clip.pcm), this.audio.sampleRate / 2));

    const id = this.store.addTransmission({
      mac,
      startedAt,
      durationMs: clip.durationMs,
      audioFile,
      transmit: clip.transmit,
    });
    this.emit('update', { type: 'transmission', ...this.store.transmission(id) });

    this.enqueue({ priority: 0, id, engineName: this.primary, wav: engineWav });
    for (const name of this.extra) {
      this.enqueue({ priority: 1, id, engineName: name, wav: engineWav });
    }
  }

  /**
   * Queue one transcription.
   *
   * Priority 0 is the default engine on a clip that just arrived; 1 is
   * everything else — comparison engines and the recovery sweep. Work is
   * strictly serial because a speech model saturates a CPU, so two at once
   * only makes both slower.
   *
   * A running job is not interrupted, so a new clip waits for at most one
   * comparison run rather than for the whole backlog. That is the bound
   * worth having: recovering hundreds of old clips cannot stall what is on
   * the air now.
   * @param {{priority: number, id: number, engineName: string, wav: string}} job - The work.
   * @returns {void}
   */
  enqueue(job) {
    this.jobs.push(job);
    this.pump();
  }

  /**
   * Work the queue until it is empty.
   *
   * Returns the run already in progress when there is one, rather than
   * nothing, so callers can wait for the queue to drain — which shutdown
   * wants, and which is the only way to test the ordering.
   * @returns {Promise<void>} Resolves when no work is left.
   */
  pump() {
    if (this.working) return this.working;
    this.working = (async () => {
      try {
        while (this.jobs.length) {
          // Re-sorted each time rather than once: a clip arriving mid-backlog
          // must not wait behind a queue of comparison runs.
          this.jobs.sort((a, b) => a.priority - b.priority);
          await this.runJob(this.jobs.shift());
        }
      } finally {
        this.working = null;
      }
    })();
    return this.working;
  }

  /**
   * @param {{id: number, engineName: string, wav: string}} job - The work.
   * @returns {Promise<void>}
   */
  async runJob({ id, engineName, wav }) {
    const engine = this.engines.get(engineName);
    if (!engine) return;
    try {
      const { text } = await engine.transcribe(wav);
      this.store.saveTranscript(id, engineName, { status: 'done', text });
    } catch (e) {
      this.store.saveTranscript(id, engineName, { status: 'error', error: e.message });
    }
    this.emit('update', { type: 'transmission', ...this.store.transmission(id) });
  }

  /**
   * Transcribe clips an engine has not managed yet.
   *
   * The audio outlives a failed transcription, so a missing module or a wrong
   * model path costs nothing permanent once the cause is fixed. Queued behind
   * live traffic, so recovering a backlog never delays what is on the air now.
   * @param {string} [engineName] - Engine to catch up; the default one if omitted.
   * @param {number} [limit] - Most clips to queue.
   * @returns {number} How many were queued.
   */
  retranscribe(engineName = this.primary, limit = 500) {
    if (!this.engines.has(engineName)) throw new Error(`unknown engine ${engineName}`);
    const rows = this.store.needingTranscript(engineName, limit);
    for (const row of rows) {
      const wav = this.engineWavFor(row);
      if (wav) this.enqueue({ priority: 1, id: row.id, engineName, wav });
    }
    return rows.length;
  }

  /**
   * @param {object} row - A transmission row.
   * @returns {string | null} Path to its 16 kHz copy, if it still exists.
   */
  engineWavFor(row) {
    const wav = join(this.dataDir, 'clips', row.audio_file).replace('.wav', '.16k.wav');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from our own row
    return existsSync(wav) ? wav : null;
  }

  /**
   * @param {string} mac - Radio to connect.
   * @returns {Promise<void>}
   */
  async connect(mac) {
    this.wanted.add(mac);
    this.clearRetry(mac);
    await this.sidecar.call('connect', { mac });
  }

  /**
   * @param {string} mac - Radio to disconnect.
   * @returns {Promise<void>}
   */
  async disconnect(mac) {
    // Out of `wanted` first, so the disconnect this causes is not mistaken
    // for a drop and retried.
    this.wanted.delete(mac);
    this.clearRetry(mac);
    await this.sidecar.call('disconnect', { mac });
  }

  /** @returns {void} Stop every pending retry, for shutdown. */
  stopRetrying() {
    for (const mac of [...this.retries.keys()]) this.clearRetry(mac);
  }

  /**
   * Try a radio again later, with the wait doubling each time.
   *
   * These radios refuse a reconnect until they have settled, and sometimes
   * until they are power-cycled, so retrying hard achieves nothing and costs
   * the radio sessions it is slow to free. The delay doubles to `maxMs` and
   * stays there, so a radio switched off overnight is picked up within a few
   * minutes of coming back without being hammered meanwhile.
   * @param {string} mac - Radio to retry.
   * @returns {void}
   */
  scheduleRetry(mac) {
    const prev = this.retries.get(mac);
    if (prev?.timer) return; // one in flight already
    const delay = Math.min(prev ? prev.delay * 2 : this.reconnect.baseMs, this.reconnect.maxMs);
    const timer = setTimeout(() => {
      this.retries.set(mac, { delay });
      if (!this.wanted.has(mac)) return;
      this.emit('update', { type: 'status', mac, state: 'connecting', detail: 'retrying' });
      this.sidecar.call('connect', { mac }).catch((err) => {
        // Still unreachable. Say so once, and wait longer next time.
        this.emit('update', { type: 'status', mac, state: 'disconnected', detail: err.message });
        if (this.wanted.has(mac)) this.scheduleRetry(mac);
      });
    }, delay);
    // Never hold the process open: a pending retry must not stop a shutdown.
    timer.unref?.();
    this.retries.set(mac, { timer, delay });
  }

  /**
   * @param {string} mac - Radio that is connected, or no longer wanted.
   * @returns {void}
   */
  clearRetry(mac) {
    const r = this.retries.get(mac);
    if (r?.timer) clearTimeout(r.timer);
    this.retries.delete(mac);
  }

  /** @returns {void} */
  reconnectAll() {
    for (const mac of this.wanted) this.sidecar.call('connect', { mac }).catch(() => {});
  }

  /** @returns {object[]} Radios with their live state merged in. */
  radios() {
    return this.store.radios().map((r) => ({
      ...r,
      ...(this.state.get(r.mac) ?? { state: 'disconnected' }),
    }));
  }
}
