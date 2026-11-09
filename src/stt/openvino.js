import { fileURLToPath } from 'node:url';
import { WorkerEngine } from './worker.js';

const SCRIPT = fileURLToPath(new URL('../../sidecar/openvino_transcribe.py', import.meta.url));

/**
 * OpenVINO GenAI engine, for Intel GPUs. Runs the same kind of warm worker as
 * sherpa-onnx; see docs/transcription.md.
 */
export class OpenVinoEngine extends WorkerEngine {
  name = 'openvino';

  /**
   * @param {object} c - The `stt.openvino` config section.
   * @param {string} c.modelDir - Directory holding an OpenVINO IR model.
   * @param {string} [c.device] - OpenVINO device: GPU, GPU.0, GPU.1 or CPU.
   * @param {?string} [c.fallbackDevice] - Tried if `device` will not load the
   *   model. null fails instead.
   * @param {string} [c.cacheDir] - Keeps compiled models, for a faster start.
   * @param {string} [c.language] - Language hint, or 'auto'.
   * @param {string} [c.python] - Python interpreter.
   * @param {string} [c.script] - Worker script path; overridden only by tests.
   */
  constructor(c = {}) {
    if (!c.modelDir) throw new Error('stt.openvino.modelDir is required');
    super('openvino', SCRIPT, {
      device: 'GPU', fallbackDevice: 'CPU', language: 'auto', python: 'python3', ...c,
    });
  }

  /** @returns {string[]} Arguments for openvino_transcribe.py. */
  workerArgs() {
    const { modelDir, device, fallbackDevice, cacheDir, language } = this.c;
    return [
      '--model-dir', modelDir,
      '--device', String(device),
      '--language', String(language),
      ...(fallbackDevice ? ['--fallback-device', String(fallbackDevice)] : []),
      ...(cacheDir ? ['--cache-dir', String(cacheDir)] : []),
    ];
  }
}
