# Publishing

One server, three audiences on one address. You and the people you trust see
everything as it happens. Anyone else sees a subset, later, and only what you
decided to publish.

| Who | Sees |
| --- | --- |
| Signed out | published radios only, behind the delay, and a **Sign in** button |
| Viewer | everything, live, unpublished included; changes nothing |
| Admin | that, plus controlling the radios and Admin, behind two-step verification ([two-step.md](two-step.md)) |

What exists, and what doesn't yet:

| Part | State |
| --- | --- |
| The publishing rule: `publish.enabled`, a radio marked public, the delay, audio off by default, one transcript | built (`src/publish.js`), used by every public route |
| A radio's `public` flag and `group` | built, through the API (`PATCH /api/radios/:mac`); no switch for them in the console yet |
| The public view and API (`/api/public/...`) | built: what a visitor who isn't signed in sees, on the one address below |
| The podcast feed | not built |
| Grouping by channel, combining nodes, the word cloud, subscribing | not built |
| Retention | Admin → Storage deletes by age, by hand or every day; not the size-based rules below |

## One address

The first design gave the public page a port of its own (`port`) and kept the
console on another (`adminPort`, bound to loopback), as pmtiles-swarm does. That
made the console unreachable from outside rather than guarded. With accounts,
roles and two-step verification, the console doesn't need hiding: a visitor who
isn't signed in gets the public view, and the same page signs people in. One
address is simpler to put behind a proxy and a certificate, which passkeys need
anyway.

So `adminPort` and `adminHost` are gone. A settings file that still sets them
gets a warning at start, and the console is on `port`. Signed out, the API
answers only:

- `/api/session`, `/api/login` and the rest of signing in and joining;
- `/api/public/...`, through the publishing rule;
- `/feed.xml`, through the same rule, once it's built.

Everything else answers 401, and the console's data never reaches a visitor.
The page shows what's published, how far behind it is, and **Sign in**. Where
nothing is published it's the sign-in page alone, and `/#signin` always goes
straight there.

Behind a reverse proxy (HAProxy, nginx, Caddy) with a certificate:

```json
{ "host": "0.0.0.0", "port": 8100, "trustProxy": "loopback, 192.0.2.10" }
```

`trustProxy` is Express's `trust proxy`: the addresses of the proxies whose
`X-Forwarded-For` and `X-Forwarded-Proto` to believe. With it, AirScribe sees
the visitor's address (for the sign-in lockout) and that the page was HTTPS
(for the cookie's Secure flag and for passkeys). Without it, every visitor
looks like the proxy, and twenty wrong passwords from anyone lock everyone out.

## Nothing is public until it is said to be

Two levels, both defaulting to off:

```json
"publish": {
  "enabled": false,
  "transcripts": true,
  "audio": false,
  "feed": true,
  "delayMinutes": 30
}
```

and a `public` flag per radio. A transmission is publishable only if
`publish.enabled` **and** its radio is marked public. So "publish this
channel" can never accidentally mean "publish everything".

pmtiles-swarm defaults its public index *on*, because serving tiles is the
point. Here the opposite is right: a transcript log is a record of other
people's conversations, so publishing is a decision, not a starting state.

## The delay

`delayMinutes` holds a transmission back from the public surface for a while
after it happened. You see it live when signed in; the public page, API and
feed do not show it until the delay has passed.

This is the convention for public safety audio — Broadcastify and similar
delay their feeds, and agencies frequently make a delay a condition of
allowing one at all. The reasoning is that a live feed of an incident in
progress can affect the incident. A recording of what happened half an hour
ago cannot.

**It has to be enforced at every public route, not just the listing.**
Filtering the feed while leaving `/api/transmissions/1284/audio` fetchable
would mean anyone counting upwards gets it live. The rule is one function —
*is this transmission publishable yet* — applied to the page, the list, the
feed, and every audio and text download, with a 404 for anything not yet
eligible.

Worth checking against retention when both are set: an audio retention
shorter than the delay would mean no clip is ever published.

## Retention

Audio is the expensive part — roughly 64 kB/s of clips — and text is cheap
enough to keep for years. So expiring audio is a **downgrade, not a delete**:
the transmission and its transcripts survive, only the WAV goes.

```json
"retention": {
  "audio": { "keepDays": 30, "maxGB": 20 },
  "text":  { "keepDays": 365 }
}
```

`maxGB` matters more than days for audio, since a busy channel fills a disk on
its own schedule. Two rules fall out: `text.keepDays` must be at least
`audio.keepDays`, because deleting the row takes its audio with it; and
retention stays **off unless configured**, which is pmtiles-swarm's convention
and the right one when the alternative is deleting data nobody asked you to
delete.

The decision of what to expire should be a pure function of rows and rules —
testable without 20 GB existing, as pmtiles-swarm's `expired()` is.

## The feed is a podcast

Plain RSS 2.0 with an `<enclosure>` **is** a podcast feed, so any podcast
client can subscribe with no new software. That is pmtiles-swarm's reasoning
for its torrent enclosures, which qBittorrent's RSS downloader already
understands.

```xml
<item>
  <title>UV-PRO · 19:42 · "engine two on arrival…"</title>
  <description>[transcript]</description>
  <guid isPermaLink="false">1284</guid>
  <pubDate>Sun, 21 Sep 2026 19:42:03 GMT</pubDate>
  <enclosure url=".../api/public/transmissions/1284/audio" length="928000" type="audio/wav"/>
  <airscribe:radio>UV-PRO</airscribe:radio>
  <airscribe:durationMs>14530</airscribe:durationMs>
  <airscribe:rssi>9</airscribe:rssi>
</item>
```

The enclosure appears only when `publish.audio` is on; otherwise it is a
text-only feed. The delay applies here as everywhere.

A 15-second WAV is about 1 MB, which is bulky for a feed. If ffmpeg is present
— and it is, since the SBC decode needs it — Opus would cut that roughly
tenfold. Worth an option later rather than a requirement now.

## Grouping: radios, and the channels under them

A radio gets a `group` — "amateur", "emergency" — so a node running one radio
on ham bands and another on a scanner can offer them as separate views.

That alone is too coarse, because one scanning radio covers several agencies:
`Holden PD` and `Rutld FD` arrive on the same radio minutes apart. Every
transmission already records its channel name, so the filter should offer
**radio, group and channel** — and only the first needs anything new stored.

The public page then answers "everything", "this node", "the amateur radios",
or "just fire", from the same rows.

## Combining several nodes

The aggregation should happen **server side**, not in the browser. A page that
fetched three instances directly would break when one was down, could not
search across them, and would need every node reachable by whoever opens it.
Ingesting a peer's feed instead gives one URL to share, one search, and
survives a peer going offline.

That is the subscription mechanism described below, with the transmission
gaining a **source**: this node, or the peer it came from. The public page
filters on it exactly as it filters on radio or group, so "everything" and
"this node only" are the same query with a different argument.

Two things follow. A peer's transmissions must be marked as theirs rather
than silently presented as local. And what a peer publishes to you is not
automatically yours to republish onward — the default should be that
subscribed content stays in the signed-in console unless you say otherwise.

## A word cloud

Useful on a scanner: the common terms are the procedural vocabulary, and a
sudden unusual one is worth noticing.

It needs three filters, and the middle one is the domain-specific part:

- **Ordinary stopwords** — the, and, to.
- **Transcription noise** — `(static)`, `*DING*`, `[BLANK_AUDIO]`,
  `Thank you.` and the other phrases a model falls back on when fed a squelch
  tail. [tools/compare-engines.py](../tools/compare-engines.py) already
  classifies these, and that logic should move into the server rather than
  being written twice.
- **A minimum count**, or a single mis-transcription becomes a headline.

It must be built from the **published** rows only, and respect the delay. A
cloud is a summary, and summarising transmissions that are not yet publishable
would leak their content early — in aggregate rather than verbatim, but leak
it nonetheless.

Worth saying plainly, since this is public safety traffic: a word cloud makes
patterns legible that individual clips do not. Names and street names recur
and rise to the top. That is an argument for building it from the same gated
rows as everything else, and for treating it as a publishing decision rather
than a display option.

## Which transcript gets published

A clip may have several. The public surface should show the default engine's,
not all of them: the comparison between models is an operator's concern, and
publishing three disagreeing versions of what someone said is worse than
publishing one.

## Subscribing, later

The symmetry pmtiles-swarm has: it publishes a feed and follows others'. An
AirScribe that did both could ingest another node's feed, and transcribe
items from any podcast feed that has no transcript of its own — the feed
either carries text or it does not, and that decides whether the engine runs.

Three things would bite, recorded now so they are not rediscovered:

- **Queue starvation.** A transmission is seconds; a podcast episode is an
  hour. One episode would stall live transcription unless feed items run at a
  lower priority than radio traffic. The queue already has that split.
- **Enclosures are not WAVs.** MP3, AAC, Opus — so ffmpeg moves from being the
  SBC decoder to being a general dependency.
- **What you subscribe to is not yours to republish.** Your own traffic is
  yours to publish; a commercial podcast's transcript is not. Subscribed
  content should be excluded from the public surface by default.

