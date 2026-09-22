import test from 'node:test';
import assert from 'node:assert/strict';
import { guessModel, normalizeMac, MODELS } from '../src/models.js';

test('longest match wins so VR-N7500 is not read as VR-N75', () => {
  assert.equal(guessModel('VR-N7500'), 'vr-n7500');
  assert.equal(guessModel('vr-n75'), 'vr-n75');
});
test('unknown names give null', () => assert.equal(guessModel('Headphones'), null));
test('MACs normalise from several spellings', () => {
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('nope'), null);
});
test('model ids are unique', () => assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length));
