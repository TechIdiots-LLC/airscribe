import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * A speech engine backed by a long-lived Python worker.
 *
 * Loading a model takes seconds and a clip takes a fraction of one, so the
 * worker is started once and kept. It is started lazily on the first clip, so
 * a misconfigured model does not stop the server from coming up, and it is
 * restarted if it dies — a crash mid-clip fails that clip, not the queue.
 *
 * Subclasses say which script to run and with what arguments. The script reads
 * JSON lines {"id", "wav"} on stdin and writes {"id", "ok", "text"|"error"} on
 * stdout, after one {"event":"ready"} or {"event":"error"} once loaded.
 */
export class WorkerEngine {
  /**
   * @param {string} label - Short name used in error messages.
   * @param {string} script - The worker script.
   * @param {object} c - Engine config; needs `modelDir` and `python`, and
   *   `script` overrides the worker for tests.
   */
  constructor(label, script, c) {
    this.label = label;
    this.script = c.script ?? script;
    this.c = c;
    // The worker starts on the first clip, so a wrong path would otherwise
    // stay hidden until a radio transmitted — and then fail once per
    // transmission. Say so at startup instead, without refusing to boot: the
    // rest of the server is still useful, and the model may yet appear.
    if (!existsSync(this.c.modelDir)) {
      console.warn(
        `[stt] model directory does not exist: ${this.c.modelDir}\n` +
          '      Transcription will fail until it does. See docs/transcription.md.',
      );
    }
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.ready = null;
  }

  /** @returns {string[]} Arguments for the worker script. */
  workerArgs() {
    throw new Error('workerArgs() is not implemented');
  }

  /** @returns {Promise<void>} Resolves once the worker has loaded its model. */
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const args = [this.script, ...this.workerArgs()];
      // eslint-disable-next-line security/detect-child-process -- fixed script, argv array, no shell
      const child = spawn(this.c.python, args, { stdio: ['pipe', 'pipe', 'inherit'] });
      this.child = child;
      createInterface({ input: child.stdout }).on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.event === 'ready') {
          if (msg.device) console.log(`[stt] ${this.label} worker running on ${msg.device}`);
          return resolve();
        }
        if (msg.event === 'error') return reject(new Error(msg.error));
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) msg.ok ? p.resolve(msg.text) : p.reject(new Error(msg.error));
      });
      child.on('error', reject);
      child.on('close', () => {
        const err = new Error(`${this.label} worker exited`);
        for (const { reject: r } of this.pending.values()) r(err);
        this.pending.clear();
        this.child = null;
        this.ready = null; // the next clip starts a fresh worker
        reject(err); // a no-op once this promise has settled
      });
    });
    return this.ready;
  }

  /**
   * @param {string} wavPath - A 16 kHz mono WAV.
   * @returns {Promise<{text: string}>} The transcript.
   */
  async transcribe(wavPath) {
    await this.start();
    const text = await new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error(`${this.label} worker not running`));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, wav: wavPath }) + '\n');
    });
    return { text };
  }

  /** @returns {void} */
  stop() {
    this.child?.kill();
  }
}
