import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Admin → Updates, MediaRiffle's design: the server only lists releases and
 * names one. AirScribe runs as an account that cannot install anything, so the
 * install is done by deploy/linux/airscribe-update, as root, which
 * airscribe-update.path starts when the request file appears. The updater
 * downloads that release's .deb and SHA256SUMS from the project's own address
 * (never one the request gives), checks one against the other, installs it,
 * waits for the new version to write its version to `running`, and puts the
 * old version and database back if it does not. It reports to status.json.
 */

export const GITLAB_PROJECT = 'https://gitlab.techidiots.net/techidiots-llc/airscribe';
export const RELEASES_API =
  'https://gitlab.techidiots.net/api/v4/projects/techidiots-llc%2Fairscribe/releases?per_page=30';
export const CHECKSUMS = 'SHA256SUMS';
/** A release version as the updater accepts it: 1.2.3 or 1.2.3-rc.1. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
/** Fixed, whatever dataDir says, because the updater looks here. */
export const UPDATE_DIR = '/var/lib/airscribe/update';
export const UPDATER = '/usr/lib/airscribe/airscribe-update';
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The running version, from package.json (the .deb's carries the release's). */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** States in which the updater is still working, so Admin keeps watching. */
export const BUSY = new Set(['downloading', 'installing', 'checking', 'rolling_back']);

/**
 * Order release versions: 1.2.3-rc.1 before 1.2.3, numeric pre-release parts
 * by number (SemVer). Anything after a "+" is ignored.
 * @param {string} a - One version.
 * @param {string} b - The other.
 * @returns {number} Negative, zero or positive.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [main] = String(v).split('+');
    const dash = main.indexOf('-');
    const core = (dash < 0 ? main : main.slice(0, dash)).split('.').map((p) => Number.parseInt(p, 10) || 0);
    return [core, dash < 0 ? [] : main.slice(dash + 1).split('.')];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const c = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (c) return Math.sign(c);
  }
  if (!pa.length || !pb.length) return pb.length - pa.length; // a release after its pre-releases
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    const c = na && nb ? Number(pa[i]) - Number(pb[i]) : na ? -1 : nb ? 1 : pa[i] < pb[i] ? -1 : pa[i] > pb[i] ? 1 : 0;
    if (c) return Math.sign(c);
  }
  return Math.sign(pa.length - pb.length);
}

/**
 * The .deb of a release, named as build/build-deb.sh names it: a pre-release
 * sorts before its release as 0.2.0~rc.1.
 * @param {string} version - A release version.
 * @returns {string} The file name.
 */
export function debFor(version) {
  return `airscribe_${version.replace('-', '~')}-1_all.deb`;
}

/**
 * GitLab's release list, as AirScribe needs it.
 * @param {unknown} list - The parsed JSON of GET /projects/:id/releases.
 * @returns {{version: string, name: string, notes: string, url: string,
 *   publishedUtc: string|null, prerelease: boolean, files: string[]}[]} Releases.
 */
export function parseReleases(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const tag = String(r?.tag_name ?? '');
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!VERSION_PATTERN.test(version) || r.upcoming_release) continue;
    out.push({
      version,
      name: String(r.name ?? tag),
      notes: String(r.description ?? ''),
      url: `${GITLAB_PROJECT}/-/releases/${encodeURIComponent(tag)}`,
      publishedUtc: r.released_at ?? null,
      prerelease: version.includes('-'),
      files: (r.assets?.links ?? []).map((l) => l?.name).filter((n) => typeof n === 'string'),
    });
  }
  return out;
}

/**
 * Whether this copy was installed from the .deb, which is what can update
 * itself from here.
 * @returns {boolean} True for /opt/airscribe with its updater beside it.
 */
export function isDebInstall() {
  return process.platform === 'linux' && APP_DIR.startsWith('/opt/airscribe') && existsSync(UPDATER);
}

/** Looks for newer releases, and hands one to the updater when an admin asks. */
export class Updates {
  /**
   * @param {object} [o] - Options; the defaults are the real install's.
   * @param {string} [o.version] - The running version.
   * @param {{checkHours?: number, prereleases?: boolean}} [o.config] - `updates` config.
   * @param {string} [o.dir] - Where the request, status and running files live.
   * @param {boolean} [o.installed] - Whether this is a .deb install.
   * @param {Function} [o.fetch] - fetch, replaced in tests.
   */
  constructor({ version = VERSION, config = {}, dir = UPDATE_DIR, installed = isDebInstall(), fetch = globalThis.fetch } = {}) {
    this.version = version;
    this.config = { checkHours: 12, prereleases: false, ...config };
    this.dir = dir;
    this.installed = installed;
    this.fetch = fetch;
    this.newer = [];
    this.checkedUtc = null;
    this.error = null;
    this.checking = null;
    this.timer = null;
  }

  get requestFile() { return join(this.dir, 'request'); }
  get statusFile() { return join(this.dir, 'status.json'); }
  get runningFile() { return join(this.dir, 'running'); }

  /** @returns {string|null} Why this install cannot update itself from here, or null. */
  whyNot() {
    if (this.installed) return null;
    return process.platform === 'linux'
      ? 'Only an install from the .deb (or the Proxmox template) updates itself from here. Update this one as it was installed.'
      : 'AirScribe updates itself from here only when installed from its .deb on Linux.';
  }

  /**
   * Tell an updater waiting on this version that it started.
   * @returns {void}
   */
  markRunning() {
    if (!this.installed) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.runningFile, `${this.version}\n`);
    } catch (e) {
      console.warn(`[updates] couldn't write ${this.runningFile}, which an update waits for: ${e.message}`);
    }
  }

  /**
   * Read the release list now. One at a time: a second caller waits for the first.
   * @returns {Promise<void>} Resolves when done, whether or not it worked.
   */
  check() {
    this.checking ??= this.#check().finally(() => { this.checking = null; });
    return this.checking;
  }

  async #check() {
    try {
      const res = await this.fetch(RELEASES_API, {
        headers: { 'User-Agent': `AirScribe/${this.version}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const current = VERSION_PATTERN.test(this.version) ? this.version : null;
      this.newer = parseReleases(await res.json())
        .filter((r) => (this.config.prereleases || !r.prerelease)
          && (!current || compareVersions(r.version, current) > 0))
        .sort((a, b) => compareVersions(b.version, a.version));
      this.error = null;
      if (this.newer.length) {
        console.log(`[updates] AirScribe ${this.newer[0].version} is available (this is ${this.version}): Admin → Updates`);
      }
    } catch (e) {
      this.error = `Couldn't read the releases from ${GITLAB_PROJECT}: ${e.message}`;
      console.warn(`[updates] ${this.error}`);
    } finally {
      this.checkedUtc = new Date().toISOString();
    }
  }

  /**
   * Check a minute after starting, then every checkHours. 0 checks only when asked.
   * @returns {void}
   */
  start() {
    const hours = Number(this.config.checkHours);
    if (!(hours > 0)) return;
    const loop = () => {
      this.check().finally(() => {
        this.timer = setTimeout(loop, hours * 3600_000);
        this.timer.unref?.();
      });
    };
    this.timer = setTimeout(loop, 60_000);
    this.timer.unref?.();
  }

  /** @returns {void} */
  stop() {
    clearTimeout(this.timer);
  }

  /**
   * The file this install needs from a release, and whether the release has
   * it with checksums.
   * @param {{version: string, files: string[]}} r - A release.
   * @returns {{file: string, ready: boolean}} What the updater would download.
   */
  readiness(r) {
    const file = debFor(r.version);
    return { file, ready: r.files.includes(file) && r.files.includes(CHECKSUMS) };
  }

  /** @returns {object|null} The updater's report, as it wrote it. */
  status() {
    try {
      return existsSync(this.statusFile) ? JSON.parse(readFileSync(this.statusFile, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  /** @returns {boolean} Whether a request waits for the updater. */
  pending() {
    return existsSync(this.requestFile);
  }

  /**
   * Ask the updater for a version.
   * @param {string} version - One of the newer releases.
   * @returns {string|null} The error to show, or null once asked.
   */
  request(version) {
    const why = this.whyNot();
    if (why) return why;
    const release = this.newer.find((r) => r.version === version);
    if (!release) return `${version} isn't a newer release here; check again.`;
    const { file, ready } = this.readiness(release);
    if (!ready) return `Release ${version} has no ${file} with checksums (${CHECKSUMS}) to update from.`;
    if (this.pending()) return 'An update is already waiting to start.';
    if (BUSY.has(this.status()?.state)) return 'An update is already under way.';
    try {
      mkdirSync(this.dir, { recursive: true });
      // The updater refuses a folder that is a link; so does this
      if (lstatSync(this.dir).isSymbolicLink()) return `${this.dir} is a link; not writing a request through it.`;
      const tmp = `${this.requestFile}.tmp`;
      writeFileSync(tmp, `id=${randomUUID().replaceAll('-', '')}\nversion=${version}\nsource=gitlab\n`);
      renameSync(tmp, this.requestFile);
    } catch (e) {
      return `Couldn't write the update request (${this.requestFile}): ${e.message}`;
    }
    console.warn(`[updates] update to AirScribe ${version} requested from Admin`);
    return null;
  }

  /** @returns {object} What Admin → Updates shows. */
  report() {
    return {
      current: this.version,
      page: `${GITLAB_PROJECT}/-/releases`,
      whyNot: this.whyNot(),
      checkedUtc: this.checkedUtc,
      error: this.error,
      pending: this.pending(),
      status: this.status(),
      prereleases: Boolean(this.config.prereleases),
      releases: this.newer.map((r) => ({
        version: r.version, name: r.name, notes: r.notes, url: r.url,
        publishedUtc: r.publishedUtc, prerelease: r.prerelease, ...this.readiness(r),
      })),
    };
  }
}
