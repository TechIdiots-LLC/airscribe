import { fileURLToPath } from 'node:url';
import { WorkerEngine } from './worker.js';

const SCRIPT = fileURLToPath(new URL('../../sidecar/sherpa_transcribe.py', import.meta.url));

/**
 * Models the worker can load, mirroring the catalogue HTCommander offers.
 * `family` is what `sherpa_transcribe.py` branches on; `url` is the archive to
 * unpack into `modelDir`. Streaming Zipformer is deliberately absent: it earns
 * its keep on live audio, and a finished clip is not that.
 */
export const SHERPA_MODELS = [
  // Time-aligned families first. These emit tokens against the audio rather
  // than generating a sentence, so they cannot stop early and hand back a
  // fragment for a long transmission — the failure that costs most on radio.
  // Point modelDir at any unpacked sherpa-onnx model of the matching shape;
  // `family` is what decides how its files are loaded.
  {
    id: 'moonshine-base.en',
    family: 'moonshine',
    name: 'Moonshine Base English (~250 MB) — built for short audio',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2',
  },
  {
    id: 'moonshine-tiny.en',
    family: 'moonshine',
    name: 'Moonshine Tiny English — smaller, faster',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2',
  },
  {
    id: 'parakeet-tdt',
    family: 'transducer',
    name: 'NVIDIA Parakeet TDT — transducer, fast and accurate',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models',
  },
  {
    id: 'zipformer-en',
    family: 'transducer',
    name: 'Zipformer English — transducer',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models',
  },
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
  {
    id: 'whisper-small.en',
    family: 'whisper',
    name: 'Whisper Small English (~600 MB)',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2',
  },
];

/** sherpa-onnx engine, backed by a long-lived Python worker. */
export class SherpaEngine extends WorkerEngine {
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
    super('sherpa', SCRIPT, { language: 'auto', threads: 2, python: 'python3', ...c });
    this.family = c.family ?? known?.family ?? 'sense-voice';
  }

  /** @returns {string[]} Arguments for sherpa_transcribe.py. */
  workerArgs() {
    return [
      '--family', this.family,
      '--model-dir', this.c.modelDir,
      '--language', String(this.c.language),
      '--threads', String(this.c.threads),
    ];
  }
}
