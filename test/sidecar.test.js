import test from 'node:test';
import assert from 'node:assert/strict';
import { Sidecar } from '../src/sidecar.js';

const after = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test('the bumble backend is told which dongle and where its pairing keys live', () => {
  const args = new Sidecar({
    python: 'python3', backend: 'bumble', transport: 'usb:0A12:0001',
    keys: '/var/lib/airscribe/bumble-keys.json', controlChannel: 4,
  }).args();
  assert.match(args[0], /airscribe_sidecar\.py$/);
  assert.equal(after(args, '--backend'), 'bumble');
  assert.equal(after(args, '--transport'), 'usb:0A12:0001');
  assert.equal(after(args, '--keys'), '/var/lib/airscribe/bumble-keys.json');
  assert.equal(after(args, '--control-channel'), '4');
});

test('the other backends are not given the dongle options', () => {
  const args = new Sidecar({ python: 'python3', backend: 'bluez', transport: 'usb:0', keys: '/k' }).args();
  assert.ok(!args.includes('--transport') && !args.includes('--keys'), args.join(' '));
});
