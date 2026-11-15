import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updates, VERSION, compareVersions, debFor, parseReleases } from '../src/updates.js';
import { createApp } from '../src/api.js';

/** A GitLab release as GET /projects/:id/releases returns it. */
const release = (version, files = [debFor(version), 'SHA256SUMS'], extra = {}) => ({
  tag_name: `v${version}`, name: `AirScribe v${version}`, description: `notes for ${version}`,
  released_at: '2026-11-01T00:00:00Z', assets: { links: files.map((name) => ({ name })) }, ...extra,
});

const fakeFetch = (list, status = 200) => async () => ({ ok: status === 200, status, json: async () => list });

function updates(list, o = {}) {
  return new Updates({ version: '0.2.0', dir: mkdtempSync(join(tmpdir(), 'updates-')), installed: true,
                       fetch: fakeFetch(list), ...o });
}

test('versions sort as SemVer: pre-releases before their release, numbers by value', () => {
  const sorted = ['0.10.0', '0.2.0', '0.2.0-rc.10', '0.2.0-rc.2', '1.0.0', '0.2.1-beta.1', '0.2.0-alpha.1']
    .sort(compareVersions);
  assert.deepEqual(sorted, ['0.2.0-alpha.1', '0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.2.1-beta.1', '0.10.0', '1.0.0']);
  assert.equal(compareVersions('0.1.0+ci12.abc', '0.1.0'), 0, 'build metadata is ignored');
});

test('the .deb is named as build-deb.sh names it', () => {
  assert.equal(debFor('0.2.0'), 'airscribe_0.2.0-1_all.deb');
  assert.equal(debFor('0.3.0-rc.1'), 'airscribe_0.3.0~rc.1-1_all.deb');
});

test('the release list keeps versions and skips what is not one', () => {
  const list = parseReleases([release('0.3.0'), { tag_name: 'nightly' }, release('0.4.0', [], { upcoming_release: true })]);
  assert.deepEqual(list.map((r) => r.version), ['0.3.0']);
  assert.equal(list[0].url, 'https://gitlab.techidiots.net/techidiots-llc/airscribe/-/releases/v0.3.0');
  assert.deepEqual(list[0].files, ['airscribe_0.3.0-1_all.deb', 'SHA256SUMS']);
  assert.deepEqual(parseReleases({ message: '404 Not Found' }), [], 'an error body is not a list');
});

test('only newer releases are offered, newest first, pre-releases when asked', async () => {
  const list = [release('0.1.0'), release('0.3.0'), release('0.2.0'), release('0.4.0-rc.1'), release('0.2.1')];
  const u = updates(list);
  await u.check();
  assert.deepEqual(u.newer.map((r) => r.version), ['0.3.0', '0.2.1']);
  const pre = updates(list, { config: { prereleases: true } });
  await pre.check();
  assert.deepEqual(pre.newer.map((r) => r.version), ['0.4.0-rc.1', '0.3.0', '0.2.1']);
});

test('a CI or local build is offered only releases after the one it builds on', async () => {
  // LXC 113 ran 0.1.0+local1.39b2568, which has the bumble backend that the 0.1.0 release doesn't, and was offered
  // 0.1.0 as an update. The root updater refuses it (dpkg: 0.1.0-1 < 0.1.0+local1…-1), so the page mustn't offer it.
  const u = updates([release('0.1.0'), release('0.1.1')], { version: '0.1.0+local1.39b2568' });
  await u.check();
  assert.deepEqual(u.newer.map((r) => r.version), ['0.1.1']);
  assert.match(u.request('0.1.0'), /isn't a newer release/);
});

test('a failed check is reported, not thrown', async () => {
  const u = updates([], { fetch: fakeFetch(null, 503) });
  await u.check();
  assert.match(u.error, /HTTP 503/);
  assert.ok(u.checkedUtc);
});

test('a request names only the version, and only a ready, newer one', async () => {
  const u = updates([release('0.3.0'), release('0.2.5', ['airscribe_0.2.5-1_all.deb'])]);
  await u.check();
  assert.match(u.request('0.9.0'), /isn't a newer release/);
  assert.match(u.request('0.2.5'), /no airscribe_0\.2\.5-1_all\.deb with checksums/);
  assert.equal(u.request('0.3.0'), null);
  const text = readFileSync(join(u.dir, 'request'), 'utf8');
  assert.match(text, /^id=[0-9a-f]{32}\nversion=0\.3\.0\nsource=gitlab\n$/);
  assert.equal(u.pending(), true);
  assert.match(u.request('0.3.0'), /already waiting/);
});

test('an update under way refuses another', async () => {
  const u = updates([release('0.3.0')]);
  await u.check();
  writeFileSync(join(u.dir, 'status.json'), JSON.stringify({ state: 'installing' }));
  assert.match(u.request('0.3.0'), /already under way/);
});

test('an install not from the .deb says so and writes nothing', async () => {
  const u = updates([release('0.3.0')], { installed: false });
  await u.check();
  assert.match(u.request('0.3.0'), /Only an install from the \.deb|only when installed from its \.deb/);
  assert.equal(existsSync(join(u.dir, 'request')), false);
  u.markRunning();
  assert.equal(existsSync(join(u.dir, 'running')), false, 'nothing waits on a non-.deb install');
});

test('the running version is written for the updater', () => {
  const u = updates([]);
  u.markRunning();
  assert.equal(readFileSync(join(u.dir, 'running'), 'utf8'), '0.2.0\n');
  assert.equal(typeof VERSION, 'string');
});

test('the updates API is for admins only, and absent from the public listener', async () => {
  const u = updates([release('0.3.0')]);
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'adm', role: 'admin' }, { token: 'view', role: 'viewer' }] } };
  const app = createApp({ manager: {}, store: {}, sidecar: {}, config, dataDir: '.', updates: u });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/updates`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { authorization: 'Bearer view' } })).status, 403);
    const adm = { authorization: 'Bearer adm', 'content-type': 'application/json' };
    const checked = await (await fetch(`${base}/check`, { method: 'POST', headers: adm })).json();
    assert.equal(checked.current, '0.2.0');
    assert.deepEqual(checked.releases.map((r) => [r.version, r.ready]), [['0.3.0', true]]);
    const bad = await fetch(`${base}/install`, { method: 'POST', headers: adm, body: '{"version":"9.9.9"}' });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/install`, { method: 'POST', headers: adm, body: '{"version":"0.3.0"}' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).pending, true);
  } finally {
    server.close();
  }

  // With a public listener, the admin routes 404 there whatever the credential
  const split = { ...config, adminPort: 1 };
  const pub = createApp({ manager: {}, store: {}, sidecar: {}, config: split, dataDir: '.', updates: u }).listen(0, '127.0.0.1');
  await new Promise((r) => pub.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${pub.address().port}/api/admin/updates`, { headers: { authorization: 'Bearer adm' } });
    assert.equal(res.status, 404);
  } finally {
    pub.close();
  }
});
