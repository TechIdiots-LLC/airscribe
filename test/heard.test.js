import test from 'node:test';
import assert from 'node:assert/strict';
import { heardValue, onlyHeard, said } from '../src/heard.js';
import { tidy } from '../src/findings.js';

const kept = (text, answer, more = [], roads = []) => {
  const f = onlyHeard(tidy(answer), said([text, ...more], roads));
  return Object.fromEntries(['addresses', 'roads', 'plates', 'vehicles', 'people', 'units', 'corrections']
    .map((k) => [k, f[k]]).filter(([, v]) => v.length));
};

// What qwen3:8b answered on an evening's traffic: details copied from the call before
test('details copied from earlier transmissions are taken out', () => {
  assert.deepEqual(kept("So you're in route at 2043.", {
    addresses: ['20 Beachwood Drive'], roads: ['Cut Off Road', 'Beachwood Drive'], vehicles: ['Audi A3'],
    people: ['89-year-old female', 'male', 'person'], units: ['Rutland Fire', '2nd Medical', '5A1 squad'],
  }), {});
  assert.deepEqual(kept('Enjoy the chicken pot pie. When I am at Bolton Orchard, I will buy one', {
    addresses: ['520 South Ridge Street', 'Bolton Orchard'], roads: ['South Ridge Street'], people: ['Ali Catalano'],
  }), { addresses: ['Bolton Orchard'] }, 'a ham net given a domestic call’s address and names');
  assert.deepEqual(kept('103, dispatch.', { addresses: ['24 Old Boston Turnpike'], units: ['5A1 squad'] }), {});
});

test('what was said is kept, however it was said', () => {
  assert.deepEqual(kept("I'm dispatching Rutland Fire, 2nd Medical, 20 Beachwood Drive, for the 89-year-old female fall", {
    addresses: ['20 Beachwood Drive'], roads: ['Beachwood Drive'], people: ['89-year-old female'], units: ['Rutland Fire', '2nd Medical'],
  }), { addresses: ['20 Beachwood Drive'], roads: ['Beachwood Drive'], people: ['89-year-old female'], units: ['Rutland Fire', '2nd Medical'] });
  assert.deepEqual(kept('Car 12 respond to four twelve elm, plate Adam Boy Charlie one two three', {
    addresses: ['412 Elm St'], plates: ['ABC123'], units: ['Car 12'], vehicles: ['Honda'],
  }), { addresses: ['412 Elm St'], plates: ['ABC123'], units: ['Car 12'] }, 'numbers and letters said as words');
  // A mishearing the model put right, from another engine's reading or the roads near
  assert.deepEqual(kept('not Holman, received', { people: ['Holden'] }, ['not Holden, received']), { people: ['Holden'] });
  assert.deepEqual(kept('respond to beach wood drive', { roads: ['Beachwood Drive'] }), { roads: ['Beachwood Drive'] });
  assert.deepEqual(kept('respond to beechwood', { roads: ['Beachwood Drive'] }), { roads: ['Beachwood Drive'] }, 'one letter out');
  assert.deepEqual(kept('respond to cutoff', { roads: ['Cut Off Road'] }, [], ['Cut Off Road']), { roads: ['Cut Off Road'] });
});

test('an address needs its house number said, and spelled letters aren’t names', () => {
  assert.deepEqual(kept('Beachwood Drive.', { addresses: ['20 Beachwood Drive'], roads: ['Beachwood Drive'] }), { roads: ['Beachwood Drive'] });
  assert.deepEqual(kept('Audi A3, Mass Reg 4, Sierra, Sierra, Romeo 33.', { roads: ['Sierra Street'], plates: ['4SSR33'] }), { plates: ['4SSR33'] });
});

test('a correction to something not said is taken out', () => {
  const f = onlyHeard(tidy({ corrections: [
    { finding: 7, field: 'roads', was: 'Route 68', now: 'Cut Off Road' },
    { finding: 7, field: 'addresses', was: '12 Main St', now: '112 Main St' },
  ] }), said(['So you are en route 2042, one twelve main']));
  assert.deepEqual(f.corrections.map((c) => c.now), ['112 Main St']);
  assert.deepEqual(f.unheard, [{ field: 'roads', value: 'Cut Off Road', correction: 7 }]);
  assert.equal(heardValue(said(['x']), 'plates', 'ABC123'), false);
});
