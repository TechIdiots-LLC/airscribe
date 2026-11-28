import test from 'node:test';
import assert from 'node:assert/strict';
import { codesIn, onChannel, says, termKey, worthCollecting } from '../src/glossary.js';
import { numerals } from '../src/plates.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);
const heard = (text, term) => says(numerals(text), termKey(term));

test('a term is matched however it was said or heard', () => {
  assert.equal(termKey('Code four'), 'code 4');
  assert.equal(termKey('10-4'), '10 4');
  assert.ok(heard('car three code four', 'Code 4'));
  assert.ok(heard('he is making Q5 statements', 'Q5'));
  assert.ok(heard('Q 5 statements', 'Q5'), 'letters and digits apart');
  assert.ok(heard('making cue five statements', 'Q5'), 'a letter said as a word');
  assert.ok(heard('a section twelve up to UMass', 'Section 12'));
  assert.ok(heard('a secton 12 up to UMass', 'Section 12'), 'a long word a letter off');
  assert.ok(!heard('house 12', 'Section 12'));
  assert.ok(!heard('code 44 at the corner', 'Code 4'), 'a number is the number');
  assert.ok(!heard('go to five', 'Q5'));
});

test('the codes said on the air', () => {
  assert.deepEqual(codesIn('Code 4 for a minute, 10-4, signal twenty three, unit 26, code 4 again, 26 Elm'),
    ['Code 4', 'Signal 23', 'Unit 26', '10-4']);
  assert.deepEqual(codesIn('engine 2 at 205 Main'), [], 'a bare number isn’t collected');
  assert.deepEqual(codesIn('631 Salisbury Street at Eisenberg, Unit 506. 80-year-old female'), [], 'an apartment isn’t a unit');
});

test('a term the model didn’t know is collected unless it’s a number, letters or plain words', () => {
  const kept = ['Q5', 'Section 12', '209A', '10-13', '7-3', 'bolo', 'Mass PC', 'hold the fire', 'CO alarm'];
  const left = ['1946', '$4.49', '27.9', 'nineteen fifty one', 'A', 'V', 'Sierra Alpha', 'Mass PC 7 Charlie 88',
    'negative', 'clear', 'fire alarm clear', '73-year-old male', 'female party', 'how come I didn’t get a chair'];
  assert.deepEqual(kept.filter((t) => !worthCollecting(t)), []);
  assert.deepEqual(left.filter(worthCollecting), []);
});

test('an entry for some channels, with * for any characters', () => {
  assert.ok(onChannel('', 'anything'));
  assert.ok(onChannel('PD F*, Fire Ops*', 'PD F1 East'));
  assert.ok(onChannel('PD F*, Fire Ops*', 'fire ops c'), 'any case');
  assert.ok(!onChannel('PD F*', 'Holden PD'));
  assert.ok(!onChannel('PD (F1)', 'PD F1'), 'the rest is plain text, not a pattern');
});

test('known, collected, guessed and rejected', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Glossary } = await import('../src/glossary.js');
  let now = 1000;
  const g = new Glossary(new DatabaseSync(':memory:'), { now: () => now });
  g.add({ term: 'Code 4', meaning: 'all is well', channels: 'PD F*' });
  g.add({ term: 'Code 4', meaning: 'send help', channels: 'Fire*' });
  assert.deepEqual(g.said(['code four at the scene'], 'PD F1 East'), [{ term: 'Code 4', meaning: 'all is well', status: 'known' }]);
  assert.deepEqual(g.said(['code four'], 'Fire Ops A').map((e) => e.meaning), ['send help'], 'each channel its own');
  assert.deepEqual(g.said(['code four'], 'Holden PD'), [], 'not for a channel it isn’t on');

  // Counted where it's on, else for all channels; the same transmission once
  g.collect(['code 4 here'], { id: 1, channel: 'PD F1 East' });
  g.collect(['code 4 here'], { id: 1, channel: 'PD F1 East' });
  g.collect(['code 4 there'], { id: 2, channel: 'Holden PD' });
  const byKey = () => g.list().map((e) => [e.term, e.channels, e.status, e.uses]);
  assert.deepEqual(byKey(), [['Code 4', 'PD F*', 'known', 1], ['Code 4', 'Fire*', 'known', 0], ['Code 4', '', 'candidate', 1]]);

  // Worked out only once said enough, and asked again only after more
  for (let i = 3; i <= 5; i++) { now += 1000; g.collect([`unit ${i} Q5 statements`], { id: i, channel: 'PD F2 West', unknown: ['Q5'] }); }
  const q5 = g.list().find((e) => e.term === 'Q5');
  assert.equal(q5.uses, 3);
  assert.deepEqual(g.toWorkOut().map((e) => e.term), ['Q5']);
  assert.equal(g.seen(q5.id)[0].text, 'unit 5 Q5 statements', 'newest first');
  g.workedOut(q5.id, { meaning: '', confidence: 'low' });
  assert.equal(g.entry(q5.id).status, 'candidate', 'no meaning: still collected');
  assert.deepEqual(g.toWorkOut(), [], 'not asked again yet');
  g.workedOut(q5.id, { meaning: 'suicidal statements', confidence: 'sure' });
  assert.deepEqual([g.entry(q5.id).status, g.entry(q5.id).confidence], ['guess', 'low'], 'a confidence not on the list is low');
  assert.deepEqual(g.said(['cue five'], 'PD F2 West'), [{ term: 'Q5', meaning: 'suicidal statements', status: 'guess' }]);

  // Accepted, rejected, asked again
  assert.throws(() => g.update(q5.id, { status: 'known', meaning: '' }), /what it means/);
  g.update(q5.id, { status: 'rejected' });
  assert.deepEqual(g.said(['Q5'], 'PD F2 West'), []);
  g.update(q5.id, { status: 'candidate' });
  assert.equal(g.entry(q5.id).meaning, '', 'asked again from scratch');
  const fire = g.list().find((e) => e.channels === 'Fire*');
  assert.throws(() => g.update(fire.id, { channels: 'PD F*' }), /already there/);

  // Lines in and out
  assert.deepEqual(g.importText('# Worcester\nSection 12 = involuntary psychiatric hold\nnope\n\n10-4 = understood | PD F*'), { added: 2, skipped: 1 });
  assert.match(g.exportText(), /^10-4 = understood \| PD F\*\nCode 4 = all is well \| PD F\*\nCode 4 = send help \| Fire\*\nSection 12 = involuntary psychiatric hold$/);
  assert.equal(g.counts().known, 4);
});
