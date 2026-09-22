import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../sidecar/sherpa_transcribe.py', import.meta.url));

/**
 * Models the worker can load, mirroring the catalogue HTCommander offers.
 * `family` is what `sherpa_transcribe.py` branches on; `url` is the archive to
 * unpack into `modelDir`. Streaming Zipformer is deliberately absent: it earns
 * its keep on live audio, and a finished clip is not that.
 */
export const SHERPA_MODELS = [
  {
    id: 'sense-voice',
    family: 'sense-voice',
    name: 'SenseVoice (multilingual, ~1 GB)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2',
  },
  {
    id: 'whisper-tiny.en',
    family: 'whisper',
    name: 'Whisper Tiny English (~110 MB)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2',
  },
  {
    id: 'whisper-base.en',
    family: 'whisper',
    name: 'Whisper Base English (~210 MB)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2',
  },
];

/**
 * sherpa-onnx engine, backed by a long-lived Python worker.
 *
 * Loading a model takes seconds and a clip takes a fraction of one, so the
 * worker is started once and kept. It is started lazily on the first clip, so
 * a misconfigured model does not stop the server from coming up, and it is
 * restarted if it dies — a crash mid-clip fails that clip, not the queue.
 */
export class SherpaEngine {
  name = 'sherpa-onnx';

  /**
   * @param {object} c - The `stt["sherpa-onnx"]` config section.
   * @param {string} c.modelDir - Directory holding the unpacked model.
   * @param {string} [c.model] - A `SHERPA_MODELS` id, to infer the family.
   * @param {string} [c.family] - Overrides the family directly.
   * @param {string} [c.language] - Language hint, or 'auto'.
   * @param {number} [c.threads] - ONNX threads.
   * @param {string} [c.python] - Python interpreter.
   * @param {string} [c.script] - Worker script path; overridden only by tests.
   */
  constructor(c = {}) {
    if (!c.modelDir) throw new Error('stt["sherpa-onnx"].modelDir is required');
    const known = SHERPA_MODELS.find((m) => m.id === c.model);
    if (c.model && !known && !c.family) {
      throw new Error(
        `unknown stt["sherpa-onnx"].model "${c.model}" (have: ${SHERPA_MODELS.map((m) => m.id).join(', ')}), or set family`,
      );
    }
    this.c = { language: 'auto', threads: 2, python: 'python3', ...c };
    this.family = c.family ?? known?.family ?? 'sense-voice';
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.ready = null;
  }

  /** @returns {Promise<void>} Resolves once the worker has loaded its model. */
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const args = [
        this.c.script ?? SCRIPT,
        '--family', this.family,
        '--model-dir', this.c.modelDir,
        '--language', String(this.c.language),
        '--threads', String(this.c.threads),
      ];
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
        if (msg.event === 'ready') return resolve();
        if (msg.event === 'error') return reject(new Error(msg.error));
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) msg.ok ? p.resolve(msg.text) : p.reject(new Error(msg.error));
      });
      child.on('error', reject);
      child.on('close', () => {
        const err = new Error('sherpa worker exited');
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
      if (!this.child?.stdin.writable) return reject(new Error('sherpa worker not running'));
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
