import { spawn } from 'node:child_process';
import { SherpaEngine } from './sherpa.js';

/**
 * A speech-to-text engine turns a WAV file (16 kHz mono) into text.
 * @typedef {object} SttEngine
 * @property {string} name - Engine id, stored with each transcript.
 * @property {(wavPath: string) => Promise<{ text: string }>} transcribe - Run one clip.
 */

/**
 * Run a command and collect stdout. Arguments are passed as an array, never
 * through a shell, so a path with spaces or metacharacters is inert.
 * @param {string} bin - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string>} Trimmed stdout.
 */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line security/detect-child-process -- argv array, no shell
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`${bin} exited ${code}: ${err.trim().slice(-300)}`)),
    );
  });
}

/** Factories by engine id. Add an engine here and it is selectable in config. */
const ENGINES = {
  /** Placeholder that proves the pipeline without a model. */
  mock: () => ({
    name: 'mock',
    transcribe: async (wav) => ({ text: `[mock transcript of ${wav.split(/[\\/]/).pop()}]` }),
  }),

  /**
   * sherpa-onnx, the engine HTCommander moved to. Keeps a Python worker warm;
   * see src/stt/sherpa.js and docs/transcription.md.
   */
  'sherpa-onnx': (c) => new SherpaEngine(c),

  /** whisper.cpp's CLI. -nt drops timestamps, -np drops progress chatter. */
  'whisper-cpp': (c = {}) => ({
    name: 'whisper-cpp',
    transcribe: async (wav) => {
      const args = ['-m', c.model, '-f', wav, '-nt', '-np'];
      if (c.language) args.push('-l', c.language);
      return { text: await run(c.binary ?? 'whisper-cli', args) };
    },
  }),

  /**
   * Any program that prints the transcript on stdout. `{wav}` in the template
   * is replaced by the clip path. This is the hook for faster-whisper, a cloud
   * client, or anything else, without changing this code.
   */
  command: (c = {}) => ({
    name: 'command',
    transcribe: async (wav) => {
      const [bin, ...args] = (c.template ?? []).map((a) => a.replaceAll('{wav}', wav));
      if (!bin) throw new Error('stt.command.template is empty');
      return { text: await run(bin, args) };
    },
  }),
};

/**
 * Build the configured engine.
 * @param {object} stt - The `stt` section of the config.
 * @returns {SttEngine} The engine.
 */
export function createEngine(stt) {
  const make = ENGINES[stt.engine];
  if (!make) {
    throw new Error(`unknown stt.engine "${stt.engine}" (have: ${Object.keys(ENGINES).join(', ')})`);
  }
  return make(stt[stt.engine]);
}
