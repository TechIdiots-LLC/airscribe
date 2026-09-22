import { readFileSync } from 'node:fs';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8100,
  dataDir: './data',
  auth: { tokens: [] },
  sidecar: { python: 'python3', backend: 'bluez' },
  audio: {
    sampleRate: 32000,
    preRollMs: 300,
    holdMs: 1200,
    minMs: 400,
    maxMs: 120000,
    overlapMs: 300,
    energyThreshold: 0.02,
  },
  stt: { engine: 'mock' },
};

/**
 * Merge plain objects recursively; arrays and scalars in `over` replace.
 * @param {object} base - Defaults.
 * @param {object} over - Overrides.
 * @returns {object} A new merged object.
 */
export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const plain = v && typeof v === 'object' && !Array.isArray(v);
    out[k] = plain && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

/**
 * Load the config file (if any) over the defaults.
 * @param {string | undefined} path - Path to a JSON config file.
 * @returns {object} The effective config.
 */
export function loadConfig(path) {
  if (!path) return structuredClone(DEFAULTS);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the operator's --config argument
  return merge(DEFAULTS, JSON.parse(readFileSync(path, 'utf8')));
}
