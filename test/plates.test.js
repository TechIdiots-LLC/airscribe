import test from 'node:test';
import assert from 'node:assert/strict';
import { numerals, readPlates, spelled } from '../src/plates.js';

const plates = (s) => readPlates(s).plates.map((p) => p.plate);

test('plates read out after "reg" or "plate", as heard on a dispatch channel', () => {
  assert.deepEqual(plates('Mass Range 6 Lima Alpha Mike 856 LAM 85'), ['6LAM856'], '"Mass range" is "Mass reg" misheard');
  assert.deepEqual(plates("It's going to be an Audi A3, Mass Reg 4, Sierra, Sierra, Romeo 33."), ['4SSR33']);
  assert.deepEqual(plates('plate Adam Boy Charlie one two three'), ['ABC123'], 'the older alphabet, numbers as words');
  assert.deepEqual(plates('plate x y z 7 8 9 on a gray sedan'), ['XYZ789'], 'letters said as letters');
  assert.equal(readPlates("It's going to be an Audi A3, Mass Reg 4, Sierra, Sierra, Romeo 33.").rest,
    'its going to be an audi a3 mass reg', 'the words it was spelled in are taken out');
});

test('a plate read out with nothing before it, but not a callsign, a phone number or a unit', () => {
  assert.deepEqual(plates('3xIndustrialMatchRises6, Mike, Charlie, Zulu, 87.'), ['MCZ87']);
  assert.deepEqual(plates('6th year Papa Juliet 415.'), ['PJ415']);
  for (const s of [
    'This is November 1, Victor Zulu, Net Control',     // N1VZ
    'KC1 Zulu Echo Lima, Mason in Chelmsford',          // KC1ZEL
    "Sierra Alpha 334-2628. That's a 334-2628.",        // too long for a plate
    "I'm five A1. Five A1.",
    'Fire alarm clear at 2034.',
    'Hotel 6 on Route 9, 2 adults',
    'Copy Delta 12 at 1430',
  ]) assert.deepEqual(plates(s), [], s);
});

test('"plate" said with no plate after it is unclear', () => {
  assert.equal(readPlates('plate is, uh, check that').unclear, true);
  assert.equal(readPlates('Mass reg 4 Sierra Sierra Romeo 33').unclear, false);
});

test('numbers said as words are digits', () => {
  assert.deepEqual(numerals('twenty four Old Boston, second floor, one two'), ['24', 'old', 'boston', '2nd', 'floor', '1', '2']);
  assert.equal(spelled('Adam Boy Charlie one two three'), 'abc123');
});
