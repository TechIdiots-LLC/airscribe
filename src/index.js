#!/usr/bin/env node
import { join } from 'node:path';
import { flagValue, loadConfig } from './config.js';
import { assertSafeToListen } from './auth.js';
import { Store } from './store.js';
import { Sidecar } from './sidecar.js';
import { Manager } from './manager.js';
import { createEngines } from './stt/index.js';
import { createApp } from './api.js';
import { Updates, VERSION } from './updates.js';
import { Cleanup } from './cleanup.js';
import { RadioReference } from './radioreference.js';
import { Accounts } from './accounts.js';
import { Logins } from './logins.js';
import { Findings } from './findings.js';

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
  // Said out loud because it replaces both the radio and the transcriber, and
  // a forgotten --simulate looks exactly like a configuration that stopped
  // working: real-looking traffic, mock transcripts.
  console.warn(
    '[simulate] using a fake radio and mock transcription; ' +
      'the stt and sidecar sections of the config are ignored',
  );
  config.sidecar.backend = 'sim';
  config.stt = { engine: 'mock' };
}

const { engines, primary, extra } = createEngines(config.stt);
// Which model is running should never be a guess.
console.log(
  `[stt] ${[...engines.keys()].join(', ')}` +
    ` (default: ${primary}${extra.length ? `, also: ${extra.join(', ')}` : ''})`,
);
const store = new Store(join(config.dataDir, 'airscribe.sqlite'), primary);
// People's accounts and invites, beside the settings file's password and tokens
const accounts = new Accounts(store.db, { rememberDays: config.twoStep?.rememberDays });
// An admin account counts as a credential, as one in the settings file does
assertSafeToListen(config, { admins: accounts.admins() });
// Bumble keeps its own pairing keys; beside the database, the one folder the service may write
const sidecar = new Sidecar({ keys: join(config.dataDir, 'bumble-keys.json'), ...config.sidecar });
const manager = new Manager({
  sidecar,
  store,
  engines,
  primary,
  extra,
  audio: config.audio,
  dataDir: config.dataDir,
  reconnect: config.reconnect,
  // A short transmission waits this long for the radio's modem to say it was a packet
  packetWaitMs: 1500,
});
sidecar.start();

console.log(`AirScribe ${VERSION}`);
const updates = new Updates({ config: config.updates });
updates.start();
// Admin → Storage, and the automatic cleanup, which is off until an admin sets
// how many days to keep
const cleanup = new Cleanup({ manager, store, dataDir: config.dataDir });
cleanup.start();
// Map → Find: where a channel is, from RadioReference, once an admin sets it up
const radioreference = new RadioReference({ store, config: config.radioreference });
// Signing in with Google, GitHub, Discord or Facebook, once an admin turns one on
const logins = new Logins({ store, accounts, config: config.auth });
// Admin → Findings: transcripts read by a language model, once an admin turns it on
const findings = new Findings({ store, manager, primary });
findings.start();
const app = createApp({
  manager, store, sidecar, config, dataDir: config.dataDir, updates, cleanup, radioreference, accounts, logins, findings,
});

// One address: signed-out visitors get the public view (docs/publishing.md)
if (config.adminPort || config.adminHost) {
  console.warn(`[config] adminPort and adminHost are no longer used: everything is on port ${config.port}, ` +
    'and visitors who aren’t signed in see only the public view');
}
const server = app.listen(config.port, config.host, () => {
  console.log(`airscribe on http://${config.host}:${config.port} (${config.sidecar.backend})`);
  // Listening is what an updater waiting on this version needs to see
  updates.markRunning();
  // Clips saved before static was measured, measured now from their audio
  manager.measureOlder().catch((e) => console.error(`[quality] ${e.message}`));
});

const shutdown = () => {
  updates.stop();
  cleanup.stop();
  findings.stop();
  manager.stopRetrying();
  sidecar.stop();
  for (const e of engines.values()) e.stop?.(); // release any held workers

  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
