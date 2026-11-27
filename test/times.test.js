import test from 'node:test';
import assert from 'node:assert/strict';
import { timesIn, withoutTimes } from '../src/times.js';

// Local time, as the server reads it
const at = (h, m, s = 0) => new Date(2026, 10, 25, h, m, s).getTime();
const said = (text, when) => timesIn([text], when).map((t) => t.number);

test('a number that is the clock when it was said is a time', () => {
  assert.deepEqual(timesIn(["I'll see you in route 1447."], at(14, 47, 57)),
    [{ said: '1447', number: '1447', clock: '2:47 PM' }]);
  assert.deepEqual(said('Received on scene, 1448', at(14, 48, 34)), ['1448']);
  // Before ten, said with its zero or without
  assert.deepEqual(said('Engine 6 back in quarters 0555', at(5, 55)), ['555']);
  assert.deepEqual(said('On arrival UMass 321', at(3, 21)), ['321']);
  assert.deepEqual(said('Fire on clear 8:30', at(8, 31)), ['830']);
  assert.deepEqual(said('Back at 8:30', at(20, 31)), ['830'], 'on the 12-hour clock too, with a colon');
  assert.deepEqual(said('Clear at 2358', at(0, 1)), ['2358'], 'across midnight');
});

test('a number far from the clock, or one of something else, is not', () => {
  assert.deepEqual(said('en route 1447', at(15, 10)), []);
  assert.deepEqual(said('Respond to 1447 Main Street', at(14, 47)), []);
  assert.deepEqual(said('Room 315, 71 year old female', at(3, 15)), []);
  assert.deepEqual(said('Unit 1447 on scene', at(14, 47)), []);
  assert.deepEqual(said('Taking Route 146 north', at(1, 46)), [], 'a route of three digits is a road');
  assert.deepEqual(said('PL 114.8', at(11, 48)), []);
  assert.deepEqual(said('callback 297-1447', at(14, 47)), []);
  assert.deepEqual(said('1,447 feet', at(14, 47)), []);
  assert.deepEqual(timesIn(['en route 1447'], undefined), []);
});

test('an address, road or unit that is only a time is taken out', () => {
  const times = timesIn(['in route 1447'], at(14, 47));
  const found = withoutTimes({
    addresses: ['Route 1447', '1447 Main Street', '12 Elm Street'], roads: ['Route 1447', 'Elm Street'], units: ['Engine 3'],
    unheard: [{ field: 'people', value: 'Bob' }],
  }, times);
  assert.deepEqual(found.addresses, ['1447 Main Street', '12 Elm Street']);
  assert.deepEqual(found.roads, ['Elm Street']);
  assert.deepEqual(found.units, ['Engine 3']);
  assert.deepEqual(found.unheard, [
    { field: 'people', value: 'Bob' },
    { field: 'addresses', value: 'Route 1447', why: 'time' },
    { field: 'roads', value: 'Route 1447', why: 'time' },
  ]);
  const none = { addresses: ['Route 1447'] };
  assert.equal(withoutTimes(none, []), none);
});

test('a house number that is the time, on a street that has no such number, is the time', () => {
  const times = timesIn(['1720. on arrival, two-story townhouse on lancaster street'], at(17, 20));
  const found = withoutTimes({ addresses: ['1720 Lancaster Street', '11 Lancaster Street'], roads: ['Lancaster Street'] },
    times, new Set(['1720 lancaster street']));
  assert.deepEqual(found.addresses, ['11 Lancaster Street']);
  assert.deepEqual(found.roads, ['Lancaster Street'], 'the road was said');
  assert.deepEqual(withoutTimes({ addresses: ['1720 Lancaster Street'] }, times).addresses, ['1720 Lancaster Street'],
    'no addresses imported to say otherwise: kept');
});
