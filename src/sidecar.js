import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../sidecar/airscribe_sidecar.py', import.meta.url));

/**
 * The Python process that owns the Bluetooth stack.
 *
 * Node has no usable Classic Bluetooth, and the radios' audio is Classic, so
 * a small Python helper holds the sockets. The two talk in JSON lines over
 * stdio: requests carry an `id` and are answered with `{id, ok, result|error}`;
 * anything with an `event` field is pushed unprompted. The child is respawned
 * with backoff, and radios that were connected are re-connected by the caller
 * on the `restart` event, because the child's state dies with it.
 *
 * Events: 'event' ({event, ...}), 'restart'.
 */
export class Sidecar extends EventEmitter {
  /**
   * @param {{python: string, backend: string}} o - Sidecar config.
   */
  constructor(o) {
    super();
    this.o = o;
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.stopped = false;
    this.backoff = 500;
  }

  /** @returns {void} */
  start() {
    this.stopped = false;
    // eslint-disable-next-line security/detect-child-process -- fixed script path, argv array
    const args = [SCRIPT, '--backend', this.o.backend];
    // Skipping the channel probe spares the radio sessions it frees slowly.
    if (this.o.controlChannel) args.push('--control-channel', String(this.o.controlChannel));
    if (this.o.audioChannel) args.push('--audio-channel', String(this.o.audioChannel));
    // eslint-disable-next-line security/detect-child-process -- fixed script path, argv array
    const child = spawn(this.o.python, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.on('error', (e) => this.emit('event', { event: 'sidecar-error', error: e.message }));
    child.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('sidecar exited'));
      this.pending.clear();
      if (this.stopped) return;
      setTimeout(() => {
        this.start();
        this.emit('restart');
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });
  }

  /**
   * @param {string} line - One JSON line from the child.
   * @returns {void}
   */
  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a stray print in the child must not take the server down
    }
    this.backoff = 500;
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    } else if (msg.event) {
      this.emit('event', msg);
    }
  }

  /**
   * @param {string} cmd - Command name.
   * @param {object} [args] - Command arguments.
   * @returns {Promise<any>} The command's result.
   */
  call(cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('sidecar not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  /** @returns {void} */
  stop() {
    this.stopped = true;
    this.child?.kill();
  }
}
