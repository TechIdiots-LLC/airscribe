#!/usr/bin/env node
// Changes the few settings an install sets, in place, keeping everything else
// in the file as it was. Used by the Proxmox template's first boot
// (proxmox/airscribe-firstboot) and usable by hand.
//
//   node tools/configure.mjs FILE [--host ADDR] [--port N] [--password-env NAME]
//
// --password-env names an environment variable holding the new password, so
// the plaintext never appears in a process listing; only its scrypt hash is
// written, as auth.passwordHash.
import { chownSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

/**
 * Apply settings to a parsed config.
 * @param {object} config - The config file's contents.
 * @param {{host?: string, port?: number|string, password?: string}} o - What to change.
 * @returns {object} The same object, changed.
 */
export function configure(config, { host, port, password } = {}) {
  if (host !== undefined) {
    if (!/^[0-9A-Za-z.:-]+$/.test(host)) throw new Error(`not a listen address: ${host}`);
    config.host = host;
  }
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`not a port: ${port}`);
    config.port = n;
  }
  if (password !== undefined) {
    if (String(password).length < 8) throw new Error('the password must be at least 8 characters');
    config.auth = { ...(config.auth ?? {}), passwordHash: hashPassword(String(password)) };
    // A plaintext one beside the hash would still be accepted
    delete config.auth.password;
  }
  return config;
}

/**
 * Whether a config already has something that lets a person sign in.
 * @param {object} config - The config file's contents.
 * @returns {boolean} True when a password or token is set.
 */
export function hasCredential(config) {
  const a = config.auth ?? {};
  return Boolean(a.passwordHash || a.password || a.apiKey || (a.tokens ?? []).length);
}

function main(argv) {
  const [file, ...rest] = argv;
  if (!file || file.startsWith('--')) {
    console.error('usage: node tools/configure.mjs FILE [--host ADDR] [--port N] [--password-env NAME] [--has-credential]');
    return 2;
  }
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--has-credential') return hasCredential(config) ? 0 : 1;
    const value = rest[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--host') opts.host = value;
    else if (flag === '--port') opts.port = value;
    else if (flag === '--password-env') {
      if (!process.env[value]) throw new Error(`${value} is not set`);
      opts.password = process.env[value];
    } else throw new Error(`unknown option ${flag}`);
  }
  configure(config, opts);
  // Written beside and renamed over, so a crash leaves the old file whole
  const tmp = `${file}.tmp`;
  const was = statSync(file);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
  // Run by root, the new file would be root's alone, and the service, which
  // reads it as root:airscribe 0640, would fail to start. Keep the old owners.
  if (process.getuid?.() === 0) chownSync(tmp, was.uid, was.gid);
  renameSync(tmp, file);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`configure: ${e.message}`);
    process.exitCode = 1;
  }
}
