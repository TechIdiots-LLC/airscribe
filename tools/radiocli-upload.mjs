#!/usr/bin/env node
// Sends a Uniden scanner's recordings to AirScribe as radiocli makes them (docs/scanners.md).
//
//   node radiocli-upload.mjs --server URL --radio ID [--user NAME] [--once] [--every SECONDS] [--delete] [FOLDER]
//
// FOLDER is where `radiocli audio record` writes (default: recordings). Each WAV with its .json beside it is
// sent once both have sat still for two seconds, then moved to FOLDER/uploaded (or deleted, with --delete); one
// AirScribe refuses goes to FOLDER/rejected with the reason beside it. Signs in as --user, with the password
// from AIRSCRIBE_PASSWORD or asked for; or with AIRSCRIBE_TOKEN, a token from AirScribe's settings file.
// Needs nothing but Node 22 or later, so it can be copied on its own to the computer the scanner is on.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

const SETTLED_MS = 2000;
const KEEP = new Set(['uploaded', 'rejected']);

function parse(argv) {
  const o = { folder: 'recordings', every: 5, once: false, delete: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--server') o.server = value().replace(/\/+$/, '');
    else if (a === '--radio') o.radio = value();
    else if (a === '--user') o.user = value();
    else if (a === '--every') o.every = Number(value());
    else if (a === '--once') o.once = true;
    else if (a === '--delete') o.delete = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.folder = a;
  }
  return o;
}

/** Ask for a password without showing it. */
function askPassword(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const TOKEN_HINT = "give it a token from the settings file's auth.tokens in AIRSCRIBE_TOKEN instead (docs/scanners.md)";

/** How it signs in: a token, or a session cookie from signing in, got again when it lapses. */
function credentials(o) {
  const token = process.env.AIRSCRIBE_TOKEN;
  if (token) return { headers: async () => ({ authorization: `Bearer ${token}` }), renew: async () => false };
  if (!o.user) throw new Error('give --user NAME, or a token in AIRSCRIBE_TOKEN');
  let password = process.env.AIRSCRIBE_PASSWORD;
  let cookie = null;
  const signIn = async () => {
    password ??= await askPassword(`Password for ${o.user}: `);
    const res = await fetch(`${o.server}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: o.user, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`signing in as ${o.user}: ${body.error ?? res.status}`);
    if (body.twoStep) throw new Error(`${o.user} has two-step verification, which a script can't do: ${TOKEN_HINT}`);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    return true;
  };
  return {
    headers: async () => {
      if (!cookie) await signIn();
      return { cookie };
    },
    renew: async () => {
      cookie = null;
      return signIn();
    },
  };
}

/** WAVs with their .json, settled, oldest first; what's been sent or refused is left alone. */
function pending(folder, now = Date.now()) {
  const out = [];
  const walk = (dir, top) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const path = join(dir, d.name);
      if (d.isDirectory()) {
        if (!(top && KEEP.has(d.name))) walk(path, false);
      } else if (d.name.toLowerCase().endsWith('.wav')) {
        const json = path.replace(/\.wav$/i, '.json');
        try {
          const a = statSync(path);
          const b = statSync(json);
          if (now - Math.max(a.mtimeMs, b.mtimeMs) >= SETTLED_MS) out.push({ wav: path, json, at: a.mtimeMs });
        } catch {
          // no .json yet: radiocli writes it after the WAV
        }
      }
    }
  };
  walk(folder, true);
  return out.sort((x, y) => x.at - y.at);
}

/** Move a recording and its .json under FOLDER/<where>, keeping the folders radiocli made. */
function file(o, r, where, reason) {
  if (where === 'uploaded' && o.delete) {
    rmSync(r.wav, { force: true });
    rmSync(r.json, { force: true });
    return;
  }
  for (const p of [r.wav, r.json]) {
    const to = join(o.folder, where, relative(o.folder, p));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(p, to);
  }
  if (reason) writeFileSync(join(o.folder, where, relative(o.folder, r.wav)).replace(/\.wav$/i, '.error.txt'), `${reason}\n`);
}

/**
 * Send every settled recording once.
 * @returns {Promise<{sent: number, refused: number}>} How it went.
 * @throws when AirScribe won't take anything (signing in, an unknown scanner), which waiting won't fix.
 */
async function pass(o, auth) {
  let sent = 0;
  let refused = 0;
  for (const r of pending(o.folder)) {
    const name = relative(o.folder, r.wav);
    const body = readFileSync(r.wav);
    const meta = Buffer.from(readFileSync(r.json)).toString('base64');
    const send = async () => fetch(`${o.server}/api/radios/${encodeURIComponent(o.radio)}/recordings`, {
      method: 'POST', body, headers: { 'content-type': 'audio/wav', 'x-radiocli': meta, ...(await auth.headers()) },
    });
    let res = await send();
    if (res.status === 401 && (await auth.renew())) res = await send();
    const answer = await res.json().catch(() => ({}));
    if (res.ok) {
      file(o, r, 'uploaded');
      sent++;
      console.log(`${name}: ${answer.duplicate ? 'already there' : 'sent'} (transmission ${answer.id})`);
    } else if (res.status === 400 || res.status === 413) {
      file(o, r, 'rejected', answer.error ?? `refused (${res.status})`);
      refused++;
      console.log(`${name}: refused, moved to rejected: ${answer.error ?? res.status}`);
    } else if ([401, 403, 404].includes(res.status)) {
      throw new Error(`${answer.error ?? res.status}${res.status === 404 ? ` (is ${o.radio} the scanner's id in AirScribe?)` : ''}` +
        (answer.twoStep ? `; ${TOKEN_HINT}` : ''));
    } else {
      console.log(`${name}: AirScribe answered ${res.status}; trying again later`);
      break;
    }
  }
  return { sent, refused };
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help || !o.server || !o.radio) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(o.help ? 0 : 2);
  }
  const auth = credentials(o);
  for (;;) {
    try {
      await pass(o, auth);
    } catch (e) {
      if (e.cause?.code || e.name === 'TypeError') console.log(`AirScribe can't be reached (${e.cause?.code ?? e.message}); trying again later`);
      else {
        console.error(`radiocli-upload: ${e.message}`);
        process.exit(1);
      }
    }
    if (o.once) return;
    await new Promise((r) => setTimeout(r, Math.max(1, o.every) * 1000));
  }
}

main();
