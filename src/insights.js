/**
 * Insights: what was said and when, over a time range.
 *
 * The word cloud counts the words of the transcripts the feed shows. Common
 * English words are left out, and so are a model's own annotations such as
 * "(static)" or "[BLANK_AUDIO]", which describe the audio rather than quote
 * it. Numbers of two or more digits are kept: on a dispatch channel, unit and
 * call numbers are much of what is said.
 */

/** Words too common to tell one channel's traffic from another's. */
export const STOP = new Set(`
  a about above after again against all am an and any are aren't as at be because been before being below
  between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
  few for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's
  hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's
  me more most mustn't my myself no nor not now of off on once only or other ought our ours ourselves out over
  own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them
  themselves then there there's these they they'd they'll they're they've this those through to too under
  until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which
  while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours
  yourself yourselves also yes yeah okay ok oh uh um uhh umm hmm gonna wanna gotta like
`.trim().split(/\s+/));

/**
 * The commonest words in some transcripts.
 * @param {string[]} texts - Transcripts.
 * @param {number} [n] - How many words.
 * @returns {{word: string, count: number}[]} Commonest first.
 */
export function topWords(texts, n = 80) {
  const counts = new Map();
  for (const raw of texts) {
    // A model's annotation of the audio isn't something anyone said
    const text = String(raw ?? '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, ' ');
    for (const token of text.match(/[a-z0-9']+/g) ?? []) {
      const word = token.replace(/^'+|'+$/g, '');
      if (word.length < 2 || STOP.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

/**
 * Everything the Insights page shows, for one time range and filter.
 * @param {import('./store.js').Store} store - The database.
 * @param {{since: number, mac?: string, channel?: string}} f - From when (ms), and for whom.
 * @returns {object} Totals, words, transmissions per hour and per channel.
 */
export function insights(store, { since, mac, channel }) {
  const { hourly, channels, texts } = store.insightRows({ since, mac, channel });
  return {
    since,
    total: hourly.reduce((s, h) => s + h.count, 0),
    airtimeMs: hourly.reduce((s, h) => s + (h.ms ?? 0), 0),
    transcripts: texts.length,
    words: topWords(texts),
    hourly,
    channels,
  };
}
