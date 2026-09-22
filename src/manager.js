import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  constructor({ sidecar, store, engine, audio, dataDir }) {
    super();
    Object.assign(this, { sidecar, store, engine, audio, dataDir });
    this.state = new Map(); // mac -> {state, rx, tx, rssi}
    this.segmenters = new Map();
    this.queue = Promise.resolve();
    this.wanted = new Set(); // radios to re-connect after a sidecar restart
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
        // A radio that drops mid-transmission still owes us the clip so far.
        if (e.state !== 'connected') {
          this.segmenters.get(e.mac)?.flush();
          s.rx = false;
          s.tx = false;
        }
        this.emit('update', { type: 'status', mac: e.mac, ...s });
        break;
      }
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
    if (prev.rx === a.rx && prev.tx === a.tx) return;
    this.state.set(mac, { ...prev, ...a });
    this.emit('update', { type: 'activity', mac, ...a });
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

    this.queue = this.queue.then(async () => {
      try {
        const { text } = await this.engine.transcribe(engineWav);
        this.store.finishTransmission(id, { status: 'done', text, engine: this.engine.name });
      } catch (e) {
        this.store.finishTransmission(id, { status: 'error', error: e.message });
      }
      this.emit('update', { type: 'transmission', ...this.store.transmission(id) });
    });
  }

  /**
   * @param {string} mac - Radio to connect.
   * @returns {Promise<void>}
   */
  async connect(mac) {
    this.wanted.add(mac);
    await this.sidecar.call('connect', { mac });
  }

  /**
   * @param {string} mac - Radio to disconnect.
   * @returns {Promise<void>}
   */
  async disconnect(mac) {
    this.wanted.delete(mac);
    await this.sidecar.call('disconnect', { mac });
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
