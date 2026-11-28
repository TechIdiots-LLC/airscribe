import test from 'node:test';
import assert from 'node:assert/strict';
import { numerals, platesIn, plausible, readPlates, spelled } from '../src/plates.js';

const plates = (s) => readPlates(s).plates.map((p) => p.plate);

test('plates read out after "reg" or "plate", as heard on a dispatch channel', () => {
  // "Mass range" is "Mass reg" misheard; "85, 6 LAM 85" run together is the plate said twice
  assert.deepEqual(plates('Mass Range 6 Lima Alpha Mike 856 LAM 85'), ['6LAM85']);
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

test('a plate said twice ends where its repeat begins', () => {
  assert.deepEqual(plates('Mass Ridge 4, Foxtrot, Yankee, Victor, 3-4, 4-F-Y-V, 3-4.'), ['4FYV34']);
  assert.deepEqual(plates("Master Edge 6 Papa Tango Papa 38. That's 6 PTP 38. Thank you."), ['6PTP38']);
  assert.deepEqual(plates('7 Foxtrot Delta Juliet 47. 7 FDJ 47.'), ['7FDJ47']);
  assert.deepEqual(plates('Mass red seven Tango Whiskey Delta eight seven seven T W D eight seven'), ['7TWD87'],
    'T W D: a W on its own is a letter, not west');
});

test('a tone, a name spelled out or a licence number isn’t a plate', () => {
  for (const s of [
    'This is the W1 BIM repeater. Text and math PL 114.8.',
    'Dexter, Mass. TL114.8',
    'A12. A12 shutting it down for the day.',
    'First name Robert, last name McGinnis, Mike, Charlie, India, November, November, India, Sierra, 528-74.',
    // A reference read back after "number"
    'Clear that motor vehicle stop. Location number 711640, Alpha Echo, 711640AE. Clear the gear.',
    'Your log number is 2 6 4 1 Alpha Bravo, 2641AB.',
  ]) assert.deepEqual(plates(s), [], s);
  assert.deepEqual(plates('Plate number 1 Adam Boy Charlie 23, that is 1ABC23'), ['1ABC23'], '"plate number" is still a plate');
});

test('of two readings of a plate, the one more engines spelled', () => {
  assert.deepEqual(platesIn(["Master Edge 6 Papa Tango Papa 38. That's 6 PTP 38.",
    "Masra H six papa tango papa three eight that's six ptp three eighty"]), ['6PTP38']);
  assert.deepEqual(platesIn(['Romeo 565 S2GR 565.', 'Chrome five six five and two GR five six five',
    'From you 565 and 2gr565']), ['2GR565']);
  assert.deepEqual(platesIn(['Mass reg 4 Sierra Sierra Romeo 33', 'Mass reg 5 Kilo Lima Mike 12']), ['4SSR33', '5KLM12'],
    'two plates, both kept');
  assert.deepEqual(platesIn(['KC1 Zulu Echo Lima 22 on the net', 'Mass reg 4 Sierra Sierra Romeo 33'], { cuedOnly: true }), ['4SSR33']);
});

test('what the model puts in plates has to look like one', () => {
  for (const p of ['22', '918', 'A12', 'K32', 'REVOKED', 'SA1640085', 'WA1BEI']) assert.equal(plausible(p, false), false, p);
  for (const p of ['6PTP38', '1MNF66']) assert.equal(plausible(p, false), true, p);
  assert.equal(plausible('22', true), true, 'after "plate", a short one can be');
});
