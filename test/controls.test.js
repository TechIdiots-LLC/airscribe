import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/api.js';

const MAC = '38:D2:00:01:56:51';

test('a radio\'s controls: admins only, checked before they reach the radio', async () => {
  const calls = [];
  const store = { radio: (mac) => (mac === MAC ? { mac } : undefined), radios: () => [] };
  const manager = Object.assign(new EventEmitter(), {
    radios: () => [],
    radioControls: async (mac) => (calls.push(['read', mac]), { volume: 7 }),
    control: async (mac, action, value) => {
      calls.push([action, value]);
      if (action === 'region' && value === 9) throw new Error('the radio didn\'t move to that region');
      return { volume: action === 'volume' ? value : 7 };
    },
  });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'admin' }, { token: 'viewer', role: 'viewer' }] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/radios`;
  const call = (method, path, token, body) => fetch(`${base}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  try {
    assert.equal((await call('GET', `/${MAC}/controls`, 'viewer')).status, 403);
    assert.equal((await call('POST', `/${MAC}/controls`, 'viewer', { action: 'volume', value: 3 })).status, 403);
    assert.deepEqual(await (await call('GET', `/${MAC}/controls`, 'admin')).json(), { volume: 7 });
    assert.equal((await call('GET', '/AA:BB:CC:DD:EE:FF/controls', 'admin')).status, 404, 'a radio not added');

    for (const [action, value] of [['volume', 16], ['volume', 2.5], ['squelch', -1], ['scan', 'yes'],
      ['region', 64], ['transmit', true], [undefined, 1]]) {
      assert.equal((await call('POST', `/${MAC}/controls`, 'admin', { action, value })).status, 400,
        `${action} ${value} is refused`);
    }
    assert.equal(calls.filter((c) => c[0] !== 'read').length, 0, 'none of those reached the radio');

    assert.deepEqual(await (await call('POST', `/${MAC}/controls`, 'admin', { action: 'volume', value: 12 })).json(),
      { volume: 12 });
    const failed = await call('POST', `/${MAC}/controls`, 'admin', { action: 'region', value: 9 });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /didn't move to that region/, 'the radio\'s own reason comes back');
  } finally {
    server.close();
  }
});
