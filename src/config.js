import { readFileSync } from 'node:fs';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8100,
  // Unset means one listener serving everything. Set it and the public
  // surface moves to `port` while everything else stays on `adminPort`.
  adminPort: null,
  adminHost: null,
  dataDir: './data',
  auth: { username: null, password: null, passwordHash: null, apiKey: null, tokens: [] },
  sidecar: { python: 'python3', backend: 'bluez', controlChannel: null, audioChannel: null },
  audio: {
    sampleRate: 32000,
    preRollMs: 300,
    holdMs: 1200,
    minMs: 400,
    maxMs: 120000,
    overlapMs: 300,
    energyThreshold: 0.02,
  },
  // A dropped radio is retried, the wait doubling to this ceiling.
  reconnect: { baseMs: 5000, maxMs: 300000 },
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
 * Read a flag's value out of argv.
 * @param {string[]} argv - The arguments, without the node and script entries.
 * @param {string} name - The flag, e.g. '--config'.
 * @returns {string | undefined} Its value, or undefined when the flag is absent.
 */
export function flagValue(argv, name) {
  const i = argv.indexOf(name);
  // indexOf gives -1 when the flag is missing, and argv[-1 + 1] is argv[0] —
  // so the naive form silently takes the first argument as this flag's value.
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Load the config file (if any) over the defaults.
 * @param {string | undefined} path - Path to a JSON config file.
 * @returns {object} The effective config.
 */
export function loadConfig(path) {
  if (!path) return structuredClone(DEFAULTS);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the operator's --config argument
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const config = merge(DEFAULTS, file);
  // The default is a single mock engine, and merging leaves `stt.engine`
  // beside the operator's `stt.engines`. Nothing reads it in that case, but
  // leaving it there means deleting `engines` later silently falls back to
  // mock transcription instead of complaining.
  if (file.stt?.engines && !file.stt.engine) delete config.stt.engine;
  return config;
}
