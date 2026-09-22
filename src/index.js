#!/usr/bin/env node
import { join } from 'node:path';
import { flagValue, loadConfig } from './config.js';
import { assertSafeToListen } from './auth.js';
import { Store } from './store.js';
import { Sidecar } from './sidecar.js';
import { Manager } from './manager.js';
import { createEngine } from './stt/index.js';
import { createApp } from './api.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);

const config = loadConfig(flagValue(args, '--config'));
// Overrides for a headless box, where editing a config file just to look at
// the UI is friction. assertSafeToListen still applies, so binding somewhere
// reachable without a token is refused exactly as it would be from the file.
const host = flagValue(args, '--host');
const port = flagValue(args, '--port');
if (host) config.host = host;
if (port) config.port = Number(port);
// --simulate swaps in the fake radio and the mock transcriber, so the whole
// pipeline can be exercised on a machine with no Bluetooth or Whisper model.
if (flag('--simulate')) {
  config.sidecar.backend = 'sim';
  config.stt = { engine: 'mock' };
}

assertSafeToListen(config.host, config.auth);

const store = new Store(join(config.dataDir, 'airscribe.sqlite'));
const sidecar = new Sidecar(config.sidecar);
const engine = createEngine(config.stt);
const manager = new Manager({
  sidecar,
  store,
  engine,
  audio: config.audio,
  dataDir: config.dataDir,
  reconnect: config.reconnect,
});
sidecar.start();

const server = createApp({ manager, store, sidecar, auth: config.auth, dataDir: config.dataDir }).listen(
  config.port,
  config.host,
  () => console.log(`airscribe on http://${config.host}:${config.port} (${config.sidecar.backend})`),
);

const shutdown = () => {
  manager.stopRetrying();
  sidecar.stop();
  engine.stop?.(); // engines that hold a worker process (sherpa-onnx) release it

  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
