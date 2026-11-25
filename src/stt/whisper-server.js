import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

/** Lines of the server's own output kept, to explain a failure. */
const TAIL_LINES = 30;

/**
 * Lines whisper.cpp prints that say where the model really runs. A Vulkan or
 * SYCL build that cannot reach the card carries on on the CPU, so without
 * these a missing render node looks like nothing worse than slowness.
 */
const DEVICE_LINES = [
  /^ggml_vulkan: \d+ = /,
  /^ggml_sycl: /,
  /^whisper_backend_init_gpu: /,
  /^whisper_init_with_params_no_state: use gpu\b/,
];

/**
 * whisper.cpp's text as a transcript: one line, and without its
 * `[BLANK_AUDIO]` marker, which is whisper.cpp saying it heard nothing. Left
 * in, it read as text: two of LXC 113's clips were stored as "[BLANK_AUDIO]"
 * rather than shown as having no speech.
 * @param {string} text - What whisper.cpp printed or returned.
 * @returns {string} The transcript, '' when there was no speech.
 */
export function cleanWhisperText(text) {
  return String(text ?? '').replace(/\[BLANK_AUDIO\]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** @returns {Promise<number>} A free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * @param {number} ms - How long.
 * @returns {Promise<void>} Resolves after it.
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} base - The server's URL.
 * @returns {Promise<boolean>} Whether it answers /health as ready.
 */
async function healthy(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * whisper.cpp's whisper-server, which loads the model once and keeps it.
 *
 * The `whisper-cpp` engine starts whisper-cli for every clip, which pays the
 * model load each time; on a GPU that also means moving the model onto the
 * card and setting the backend up again, which can cost more than the clip.
 * This starts the server on the first clip, on a loopback port, and posts each
 * clip to it. If it dies, that clip fails and the next one starts it again —
 * the same contract as the Python workers (src/stt/worker.js).
 *
 * With `url` instead of `model`, it uses a server that is already running and
 * starts nothing.
 */
export class WhisperServerEngine {
  name = 'whisper-server';
  /** Takes a prompt: words to expect, which Findings gives a clip it has heard again. */
  prompts = true;

  /**
   * @param {object} c - The `stt.whisper-server` config section.
   * @param {string} [c.model] - A ggml model file; the server is started with it.
   * @param {string} [c.url] - A running whisper-server to use instead.
   * @param {string} [c.binary] - The server program.
   * @param {string[]} [c.binaryArgs] - Arguments before the server's own, for
   *   a wrapper such as `nice`.
   * @param {string[]} [c.args] - Arguments after them: threads, VAD, thresholds.
   * @param {number} [c.port] - Loopback port; a free one by default.
   * @param {string} [c.language] - Sent with each clip; `auto` for a
   *   multilingual model to detect it. The server's own default is `en`.
   * @param {number} [c.startSeconds] - How long the server may take to load.
   * @param {number} [c.timeoutSeconds] - How long one clip may take.
   */
  constructor(c = {}) {
    if (!c.model && !c.url) {
      throw new Error('stt.whisper-server needs model (to start whisper-server) or url (to use one already running)');
    }
    this.c = { binary: 'whisper-server', startSeconds: 300, timeoutSeconds: 120, ...c };
    if (c.model && !c.url && !existsSync(c.model)) {
      // Started on the first clip, so a wrong path would otherwise stay hidden
      // until a radio transmitted. Warn, don't refuse to boot (as WorkerEngine).
      console.warn(
        `[stt] whisper-server model does not exist: ${c.model}\n` +
          '      Transcription will fail until it does. See docs/transcription.md.',
      );
    }
    this.child = null;
    this.ready = null;
    this.base = c.url ? String(c.url).replace(/\/+$/, '') : null;
    this.tail = [];
  }

  /**
   * @param {number} port - The port it will listen on.
   * @returns {string[]} The server's arguments.
   */
  serverArgs(port) {
    return [
      ...(this.c.binaryArgs ?? []),
      '-m', this.c.model,
      '--host', '127.0.0.1',
      '--port', String(port),
      ...(this.c.args ?? []),
    ];
  }

  /** @returns {Promise<void>} Resolves once the server answers. */
  start() {
    if (this.c.url) return Promise.resolve();
    if (!this.ready) {
      this.ready = this.#launch();
      // A failed start is retried by the next clip
      this.ready.catch(() => (this.ready = null));
    }
    return this.ready;
  }

  /** @returns {string} The last lines the server printed, for an error message. */
  #tailText() {
    return this.tail.length ? `:\n${this.tail.slice(-10).join('\n')}` : '';
  }

  /** @returns {Promise<void>} Starts the server and waits for it to answer. */
  async #launch() {
    const port = this.c.port ?? (await freePort());
    const base = `http://127.0.0.1:${port}`;
    // eslint-disable-next-line security/detect-child-process -- configured binary, argv array, no shell
    const child = spawn(this.c.binary, this.serverArgs(port), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.tail = [];
    const onLine = (line) => {
      this.tail.push(line);
      if (this.tail.length > TAIL_LINES) this.tail.shift();
      if (DEVICE_LINES.some((re) => re.test(line))) console.log(`[stt] whisper-server: ${line.trim()}`);
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', onLine);

    const gone = new Promise((_, reject) => {
      child.on('error', (e) => reject(new Error(`whisper-server could not start (${this.c.binary}): ${e.message}`)));
      child.on('close', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this.ready = null; // the next clip starts a fresh server
          this.base = null;
        }
        reject(new Error(`whisper-server exited (${signal ?? `code ${code}`})${this.#tailText()}`));
      });
    });
    gone.catch(() => {}); // seen through the races below, or not at all once it's up

    const deadline = Date.now() + this.c.startSeconds * 1000;
    while (!(await Promise.race([healthy(base), gone]))) {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`whisper-server did not answer within ${this.c.startSeconds}s${this.#tailText()}`);
      }
      await Promise.race([delay(250), gone]);
    }
    this.base = base;
    console.log(`[stt] whisper-server ready on ${base}`);
  }

  /**
   * @param {string} wavPath - A 16 kHz mono WAV.
   * @param {{prompt?: string}} [o] - Text taken as said just before the clip: whisper leans to its words and style.
   * @returns {Promise<{text: string}>} The transcript.
   */
  async transcribe(wavPath, { prompt } = {}) {
    await this.start();
    const base = this.base;
    if (!base) throw new Error('whisper-server not running');
    const form = new FormData();
    form.append('file', new Blob([await readFile(wavPath)], { type: 'audio/wav' }), basename(wavPath));
    form.append('response_format', 'json');
    form.append('no_timestamps', 'true');
    if (this.c.language) form.append('language', String(this.c.language));
    if (prompt) form.append('prompt', prompt);

    let res;
    try {
      res = await fetch(`${base}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.c.timeoutSeconds * 1000),
      });
    } catch (e) {
      throw new Error(`whisper-server at ${base}: ${e.cause?.message ?? e.message}`);
    }
    const body = await res.text();
    let msg = null;
    try {
      msg = JSON.parse(body);
    } catch {
      // reported below
    }
    if (!res.ok || msg?.error) {
      throw new Error(`whisper-server answered ${res.status}: ${(msg?.error ?? body).slice(0, 300)}`);
    }
    if (!msg || typeof msg.text !== 'string') {
      throw new Error(`whisper-server answered without a transcript: ${body.slice(0, 300)}`);
    }
    // One line per segment; a clip's transcript is one line
    return { text: cleanWhisperText(msg.text) };
  }

  /** @returns {void} */
  stop() {
    this.child?.kill();
  }
}
