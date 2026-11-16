import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Segmenter } from './segmenter.js';
import { decodeWav, encodeWav, halveRate } from './wav.js';
import { quieting } from './quality.js';
import { decodePacket } from './aprs.js';

/** A transmission this short with a packet in it was only the packet: data, not speech. */
const DATA_MS = 2500;

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
   * @param {number} [o.packetWaitMs] - How long a short transmission waits for the radio's modem to say it was a
   *   packet before it's transcribed; 0 transcribes it at once.
   */
  constructor({ sidecar, store, engine, engines, primary, extra, audio, dataDir, reconnect, packetWaitMs = 0 }) {
    super();
    Object.assign(this, { sidecar, store, audio, dataDir, packetWaitMs });
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
    this.channels = new Map(); // mac -> Map(index -> {name, rx_hz})
    this.onAir = new Map();    // mac -> the channel a run started on
    this.signal = new Map();   // mac -> the strongest signal reading during the run on the air
    this.waiting = new Map();  // mac -> packets heard before the transmission they came in had ended
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
      // The radio's channel table, read once at connect.
      case 'channels':
        this.channels.set(e.mac, new Map((e.channels ?? []).map((c) => [c.id, c])));
        this.emit('update', { type: 'channels', mac: e.mac, channels: e.channels });
        break;
      case 'radio-status':
        // The strongest reading while a transmission is coming in: how far
        // away, or how weak, the station is (src/quality.js)
        if (this.signal.has(e.mac) && Number.isInteger(e.rssi)) {
          this.signal.set(e.mac, Math.max(this.signal.get(e.mac) ?? 0, e.rssi));
        }
        this.setActivity(e.mac, {
          rx: !!e.in_rx, tx: !!e.in_tx, rssi: e.rssi, channel: e.channel,
          ...(e.battery === undefined || e.battery === null ? {} : { battery: e.battery }),
          ...(e.region === undefined ? {} : { region: e.region }),
          ...(e.scanning === undefined ? {} : { scanning: !!e.scanning }),
        });
        break;
      // Where the radio's own GPS puts it, while it has a fix
      case 'radio-position':
        this.setActivity(e.mac, {
          position: { lat: e.lat, lon: e.lon, alt_m: e.alt_m, speed: e.speed, heading: e.heading, at: Date.now() },
        });
        break;
      case 'audio-start':
        this.segmenterFor(e.mac).begin({ transmit: !!e.transmit });
        // Captured when the run opens rather than when the clip is written:
        // a scanning radio may have moved on by the time it closes.
        this.onAir.set(e.mac, this.state.get(e.mac)?.channel);
        this.signal.set(e.mac, e.transmit ? null : this.state.get(e.mac)?.rssi ?? null);
        this.setActivity(e.mac, { rx: !e.transmit, tx: !!e.transmit });
        break;
      case 'audio-end':
        this.segmenterFor(e.mac).end();
        this.signal.delete(e.mac);
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
      // A packet the radio's own modem decoded: APRS, or the radios' BSS
      case 'packet':
        this.onPacket(e);
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
    if (prev.rx === next.rx && prev.tx === next.tx && prev.rssi === next.rssi
        && prev.battery === next.battery && prev.channel === next.channel
        && prev.region === next.region && prev.scanning === next.scanning
        && prev.position?.lat === next.position?.lat && prev.position?.lon === next.position?.lon) return;
    this.state.set(mac, next);
    // A radio going flat is the one failure nothing on this side can recover
    // from, so it is said out loud once per threshold crossed rather than
    // left to whoever is watching the page.
    for (const level of [20, 10, 5]) {
      if (next.battery !== undefined && next.battery <= level
          && (prev.battery === undefined || prev.battery > level)) {
        console.warn(`[radio] ${mac} battery at ${next.battery}% - it will stop when this runs out`);
        break;
      }
    }
    this.emit('update', {
      type: 'activity', mac, rx: next.rx, tx: next.tx,
      rssi: next.rssi, battery: next.battery, channel: next.channel,
      channelName: this.channels.get(mac)?.get(next.channel)?.name ?? null,
      region: next.region, scanning: next.scanning, position: next.position,
    });
  }

  /**
   * What a radio's controls show, read from the radio now.
   * @param {string} mac - A connected radio.
   * @returns {Promise<object>} Settings, volume, regions, the channel table, position.
   */
  radioControls(mac) {
    return this.sidecar.call('radio', { mac });
  }

  /**
   * Change one thing on a radio: volume, squelch, scan, dual, channel_a,
   * channel_b or region.
   * @param {string} mac - A connected radio.
   * @param {string} action - What to change.
   * @param {number|boolean} value - To what.
   * @returns {Promise<object>} The controls' new state.
   */
  control(mac, action, value) {
    return this.sidecar.call('control', { mac, action, value });
  }

  /**
   * Every slot of one region, programmed or not, read from the radio now. The
   * radio is moved to the region to read it and back.
   * @param {string} mac - The radio.
   * @param {number|null} region - Which region; null for the one it's on.
   * @returns {Promise<{region: number, name: string, count: number, channels: object[]}>} Each slot's channel.
   */
  readChannels(mac, region = null) {
    return this.sidecar.call('channels', { mac, region });
  }

  /**
   * Write channels into slots of one region, each read back from the radio.
   * @param {string} mac - The radio.
   * @param {number|null} region - Which region; null for the one it's on.
   * @param {object[]} channels - Records as read ({id, raw}) or checked fields (src/channels.js).
   * @returns {Promise<{region: number, name: string, results: object[]}>} What each slot holds now.
   */
  writeChannels(mac, region, channels) {
    return this.sidecar.call('write_channels', { mac, region, channels });
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

    const channel = this.onAir.get(mac) ?? this.state.get(mac)?.channel ?? null;
    const info = this.channels.get(mac)?.get(channel);
    // How it came through, for telling a station out of range (src/quality.js).
    // A radio's own transmission has neither.
    const rssi = clip.transmit ? null
      : this.signal.has(mac) ? this.signal.get(mac) : this.state.get(mac)?.rssi ?? null;
    const id = this.store.addTransmission({
      mac,
      startedAt,
      durationMs: clip.durationMs,
      audioFile,
      transmit: clip.transmit,
      channel: channel ?? null,
      channelName: info?.name ?? null,
      channelHz: info?.rx_hz ?? null,
      rssi: Number.isInteger(rssi) ? rssi : null,
      snrDb: clip.transmit ? null : quieting(clip.pcm, this.audio.sampleRate),
    });
    this.emit('update', { type: 'transmission', ...this.store.transmission(id) });

    // Packets the radio's modem decoded while this was coming in were in it
    const waiting = (this.waiting.get(mac) ?? []).filter((w) => w.at >= startedAt - 500);
    this.waiting.delete(mac);
    if (waiting.length && !clip.transmit) {
      this.attachPackets({ id, duration_ms: clip.durationMs }, waiting.map((w) => w.id));
      if (clip.durationMs <= DATA_MS) return;
    }

    const transcribe = () => {
      this.enqueue({ priority: 0, id, engineName: this.primary, wav: engineWav });
      for (const name of this.extra) {
        this.enqueue({ priority: 1, id, engineName: name, wav: engineWav });
      }
    };
    // A short one may be a packet whose modem's notice is still to come, within
    // the status poll's second: it's given a moment before a model is set on it
    if (this.packetWaitMs > 0 && !clip.transmit && clip.durationMs <= DATA_MS) {
      const t = setTimeout(() => {
        if (this.store.hasTransmission(id) && !this.store.transmission(id)?.data) transcribe();
      }, this.packetWaitMs);
      t.unref?.();
    } else {
      transcribe();
    }
  }

  /**
   * A packet the radio's own modem decoded: kept (once: a digipeater's copy of
   * one just heard isn't), shown, and tied to the transmission it came in when
   * the radio's audio carried it too. The modem's notice comes as the burst
   * ends, or within the second after, so a transmission on this radio that
   * ended in the last 3 seconds is the one; otherwise it waits, briefly, for
   * the transmission still coming in.
   * @param {{mac: string, channel?: number, data: string}} e - The sidecar's event: the packet's bytes in hex.
   * @returns {void}
   */
  onPacket(e) {
    const raw = Buffer.from(/^[0-9a-f]*$/i.test(e.data ?? '') ? e.data : '', 'hex');
    const p = raw.length ? decodePacket(raw) : null;
    if (!p) {
      console.log(`[packet] ${e.mac}: ${raw.length} bytes that aren't a packet AirScribe can read: ${raw.toString('hex').slice(0, 64)}`);
      return;
    }
    const at = Date.now();
    const channel = Number.isInteger(e.channel) ? e.channel : null;
    const info = this.channels.get(e.mac)?.get(channel);
    const id = this.store.addPacket({ mac: e.mac, receivedAt: at, channel, channelName: info?.name ?? null,
      channelHz: info?.rx_hz ?? null, raw: raw.toString('hex'), ...p });
    if (id === null) return;
    // While a transmission is still coming in, the packet is in that one
    const tx = this.segmenters.get(e.mac)?.open ? null : this.store.lastTransmission(e.mac);
    if (tx && !tx.transmit && at >= tx.started_at && at - (tx.started_at + tx.duration_ms) <= 3000) {
      this.attachPackets(tx, [id]);
    } else {
      const list = (this.waiting.get(e.mac) ?? []).filter((w) => at - w.at < 10000);
      list.push({ id, at });
      this.waiting.set(e.mac, list);
    }
    // Wrapped: a packet has a type of its own (position, message, ...)
    this.emit('update', { type: 'packet', packet: this.store.packet(id) });
  }

  /**
   * Packets came in a transmission: they're shown with it, and one short
   * enough to have been nothing but them isn't transcribed (a burst of data
   * gives a speech model nothing but noise). A longer one, voice with a packet
   * after it as these radios can send on letting go of the talk button, is.
   * @param {{id: number, duration_ms: number}} tx - The transmission.
   * @param {number[]} ids - The packets.
   * @returns {void}
   */
  attachPackets(tx, ids) {
    const dataOnly = tx.duration_ms <= DATA_MS;
    this.store.linkPackets(tx.id, ids, dataOnly);
    if (dataOnly) this.jobs = this.jobs.filter((j) => j.id !== tx.id);
    this.emit('update', { type: 'transmission', ...this.store.transmission(tx.id) });
  }

  /**
   * Measure the transmissions saved before they were measured as they came in,
   * from their audio, so older static is marked too. Newest first, a batch at
   * a time with a break between, so it doesn't hold up the server; a clip
   * whose audio has gone, or is too short to tell, is left unmeasured.
   * @param {{batch?: number}} [o] - Clips read between breaks.
   * @returns {Promise<number>} How many were measured.
   */
  async measureOlder({ batch = 25 } = {}) {
    let before;
    let measured = 0;
    for (;;) {
      const rows = this.store.needingQuality({ before, limit: batch });
      if (!rows.length) break;
      for (const { id, audio_file: file } of rows) {
        before = id;
        const path = join(this.dataDir, 'clips', file);
        if (!existsSync(path)) continue;
        try {
          const wav = decodeWav(readFileSync(path));
          const db = wav ? quieting(wav.pcm, wav.rate) : null;
          if (db !== null && this.store.hasTransmission(id)) {
            this.store.setQuality(id, db);
            measured++;
          }
        } catch {
          // An unreadable clip stays unmeasured; the rest go on
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (measured) console.log(`[quality] measured ${measured} older transmission${measured === 1 ? '' : 's'} for static`);
    return measured;
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
    if (!engine || !this.store.hasTransmission(id)) return;
    let result;
    try {
      const { text } = await engine.transcribe(wav);
      result = { status: 'done', text };
    } catch (e) {
      result = { status: 'error', error: e.message };
    }
    // Deleted while it was being read: there is nothing to attach the
    // transcript to, and nothing for the page to show
    if (!this.store.hasTransmission(id)) return;
    this.store.saveTranscript(id, engineName, result);
    this.emit('update', { type: 'transmission', ...this.store.transmission(id) });
  }

  /**
   * Delete transmissions: their rows, their transcripts and both audio files.
   *
   * Queued transcriptions of them are dropped first, and one being read right
   * now saves nothing when it finishes (runJob checks), so a deleted clip
   * can't return as an orphaned transcript. Open pages are told which rows to
   * take away, or, after a large cleanup, to load the feed again.
   * @param {number[]} ids - Transmissions to delete.
   * @returns {{deleted: number, bytes: number}} How many, and the disk space freed.
   */
  deleteTransmissions(ids) {
    const doomed = new Set(ids);
    this.jobs = this.jobs.filter((j) => !doomed.has(j.id));
    const gone = this.store.deleteTransmissions([...doomed]);
    const root = resolve(this.dataDir, 'clips');
    let bytes = 0;
    for (const { audio_file: clip } of gone) {
      for (const name of [clip, clip.replace('.wav', '.16k.wav')]) {
        // Written by this server, but resolved under clips/ anyway
        const file = resolve(root, name);
        if (!file.startsWith(root + sep)) continue;
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from our own row, checked above
          bytes += statSync(file).size;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
          unlinkSync(file);
        } catch {
          // already gone: deleting what's left is the point
        }
      }
    }
    if (gone.length) {
      const deletedIds = gone.map((g) => g.id);
      this.emit('update', deletedIds.length <= 500
        ? { type: 'deleted', ids: deletedIds }
        : { type: 'purged', count: deletedIds.length });
    }
    return { deleted: gone.length, bytes };
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
