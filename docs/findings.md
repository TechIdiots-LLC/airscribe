# Findings

Findings has a language model read each transcript and pick out what's useful: the addresses, roads, plates, vehicles,
people and units mentioned, the kind of call, and a one-line summary. A **watch list** of plates, streets, names or
phrases is checked against each transcript and against what the model found, and a match can be posted to a webhook.

It's off until an admin turns it on. **Signed-in users, viewers and admins, see it** on the **Findings** tab; the public
view never does. What it keeps is about third parties heard on the radio, so it isn't in the feed, the event stream,
exports or the public view, and it's deleted after a set number of days. Its settings, its roads and the watch list are
changed only by admins, in **Admin → Findings**, behind Admin's own two-step check ([two-step.md](two-step.md)).

## Setting it up

It needs a model server on your network. [llm-lxc](https://gitlab.techidiots.net/techidiots-llc/llm-lxc) (Ollama on the
same GPU) is the obvious one; any Ollama, or any server with OpenAI's chat completions API, works.

1. On the model server, have a model that follows instructions and writes JSON well. `qwen3:8b` does:
   `ollama pull qwen3:8b`.
2. In AirScribe, **Admin → Findings**: tick **On**, choose **Ollama** (or **OpenAI-style**), and give the server's
   **Address** (`http://192.168.0.139:11434` for llm-lxc: Ollama's port, without `/v1`) and the **Model**. An API key
   is only for a server that asks for one. **Save**.
3. **Test** sends a made-up transmission and shows what came back, and how long it took. The first time, the model has
   to load onto the card, which can take most of a minute.

From then on, each transmission is read once every speech engine has finished it (`stt.engines`; the default first,
the others queued behind it), one at a time, behind live transcription. Should the others still be at it three minutes
(**Wait for other engines**) after the default engine, it's read with what's there. **Read the last N hours** reads earlier ones that haven't been. A transmission where no engine heard two words
or more (a beep, `[BLANK_AUDIO]`) isn't sent. One that came through static (marked in the feed) is still sent, and
the model is told so (below).

| Setting | | |
| --- | --- | --- |
| Server | Ollama | Ollama's own API (`/api/chat`): the answer is held to a JSON schema, and a thinking model's thinking is turned off, which makes it several times quicker (gpt-oss can't stop thinking, so it's asked to think as little as it can). An answer may be at most 2048 tokens, thinking included (8192 for an hour of the day so far): a model that goes round in circles is stopped there, and the error says so. OpenAI-style: `/v1/chat/completions` with a `json_schema` response format. |
| Address | | The server, `http://` or `https://`. |
| Model | `qwen3:8b` | As the server names it. |
| API key | none | Sent as `Authorization: Bearer`. Kept on this server and never shown again; **Forget the key** next to it removes it. |
| Webhook | none | Posted to for each watch match (below). |
| Keep for | 30 days | Findings and matches older than this are deleted, hourly. So are those of a deleted transmission. |
| Look back | 5 min | How far back the earlier transmissions given with each one go (1–30). |
| This channel's last | 5 | How many of the same channel's (0–20; 0 gives none). |
| Other channels' last | 5 | How many of the other channels' (0–20; 0 gives none). |
| Same call within | 5 s | Another radio on the same frequency this close heard the same transmission (0–30; 0 never counts one). It has to be on the air at the same time as well. Two radios' copies of one call start up to about 4 s apart; past that it's mostly the next call. |
| Earlier findings, last | 5 | How many of the findings already made, on its channel or naming something it says, go with each transmission (0–20; 0 gives none, and nothing is corrected). |
| from | 15 min | How far back those go (1–60). |
| Wait for other engines | 3 min | How long to wait for the other speech engines before reading with the default one's alone (0–30; 0 reads the default engine's alone, as soon as it's done). |

## What the model is asked

The new transmission's transcript, and as context (numbers as set above) up to five earlier ones on the same channel from the five minutes
before it, so "the plate is…" after "Car 12, traffic stop on Route 9" reads as one call. Up to five from other channels in
the same five minutes go with it too, each with its channel and how long before, so a unit dispatched on one channel
and talking on another can be followed. It's told those are context only: what it reports is what the new one says.

The instructions end with five short worked examples, because a small model follows an example more closely than a
rule: a reply after a dispatch that keeps the earlier address out, a plate spelled out, a ham's conversation summed up
with its equipment and band rather than as "a person discusses plans", an acknowledgement that has nothing to
report, and a short request summed up rather than quoted back. (qwen3:14b wrote "The speaker says '...'" for one
summary in eight.) Amateur summaries may run to two sentences, since there's no call to sum up. They're told radio talk is
short and plain, and not to fill in what a short transmission leaves out.

The new one's transcript is the default engine's, or, when that heard nothing, the engine's that heard most; but only
when another radio heard words too, or two other engines did: one engine finding words where the default heard none
was most often static made into words ("May Street in him"), so that isn't read. After
it come **other readings** of the same words: each other engine's, when it differs, and another radio's that heard
the same frequency within five seconds, while this one was on the air (two radios on one dispatch channel, a scanner and a handheld).
When one radio heard two calls close together (a "thank you", then the next call), the other radio's copy goes with
the one that started nearest it. The model is
told to use them together to work out what was said. A copy from another radio is left out of the other channels'
traffic.

A call heard by two radios is **read once**: whichever copy is read first is the finding, and the other is attached to
it (status `copy` in the database) rather than sent to the model again, so a call isn't found twice or its roads
counted twice. Should the second copy have heard words the first was read without (its transcript finished later),
the first is read again, with them as another radio's reading. The watch list sees the copy's words too. Calls read
twice before this was in place stay as they are.

Before all that come the **earlier findings**: the last five (by default) from the 15 minutes before that may be
the same call, each with its number, channel, how long before, its summary and what was found in it. They tell the
model what has been worked out already (the address a call settled on, the units on it), and let it correct them
(below). Those on the transmission's own channel go, and those on another channel only when they name a unit, road,
address or plate the transmission says (Engine 2 sent on dispatch, then talking on a fireground): given every
channel's, a small model copied a domestic call's address into a ham net. Those with nothing found are left out.

Any of the transmissions that came through
static is marked "heard through static", and the model is told to report from those only what reads clearly: speech
recognition writes words into hiss.

Each finding has **Sent to the model** under it: the message as it went, with the channel, the road names hinted, the
context and the transcript, and beside it the tokens the server counted for the prompt and the answer, and how long it
took. Admin → Findings says the biggest prompt of the last day: keep it well inside the model's context window
(llm-lxc's is 8192 tokens, `OLLAMA_CONTEXT_LENGTH`), which a server trims a prompt to without saying so. A server that
keeps the start of the last prompt cached may count only the rest. The instructions that go with every one are at the top of the Findings tab. It's told to report only what
the new one says, to leave out what isn't said rather than guess, and to answer with:

| Field | |
| --- | --- |
| `summary` | One short sentence, or empty when nothing of substance was said |
| `incident` | The kind of call: "motor vehicle crash", "structure fire" |
| `service` | Who is talking: `police`, `fire`, `ems`, `works` (public works, highway, utilities, transit), `amateur` or `other`. The channel's own service goes with it when it's known (below) |
| `addresses` | Addresses, intersections and named places: "412 Elm St", "Main St and Route 9" |
| `roads` | The roads those mention, each once: "Elm Street", "Route 9" |
| `plates` | Letters and digits only; a phonetic alphabet read out ("Adam Boy Charlie 1 2 3") becomes letters: "ABC123" |
| `vehicles` | "red Honda Civic" |
| `people` | Names or descriptions, not unit or badge numbers |
| `units` | "Engine 2", "Medic 4", "Car 12" |
| `corrections` | What the new transmission corrects in an earlier finding (below): `finding`, `field`, `was`, `now` |

Whatever comes back is held to that shape: lists of short strings, plates as 2 to 10 letters and digits.

### The channel's service

Asked one transmission at a time, the model labelled the same dispatch channel fire, then other, then amateur: a
dispatcher reading out "Sierra Alpha" sounds like a ham. So the service is worked out for the channel, and given
with its name ("Channel: Holden Fir (a fire channel)"), from the first of:

1. **Uniden's database**, when it's imported: the service it tags the channel's name with (law, fire or EMS
   dispatch, tactical or talk; ham; public works, utilities, transportation).
2. **Its name**, when the name says one service only: "PD", "police", "sheriff"; "FD", "fire", "Fir"; "EMS",
   "ambulance"; "DPW", "highway"; a callsign ("W1EMC") for amateur. "C8 Fire/EMS Dispatch" says two, so nothing.
3. **What its findings have mostly said**: seven in ten of five or more in the last fortnight, nine in ten for
   amateur, since that's the label the model got wrong.

The channel's service replaces an answer of `amateur` or `other` (and any answer on an amateur channel). Another
service the model names stays, since police can be heard on a fire channel.

### Plates read out

A small model reads a phonetic alphabet as names: "Mass Reg 4, Sierra, Sierra, Romeo 33" came back as "Sierra
Street", and the plate was dropped. So AirScribe reads plates out of the transcript itself (`src/plates.js`), in each
engine's reading, gives them to the model after the transmission ("Plates spelled out in it: 4SSR33"), and adds any
the model leaves out, so a watch for one always matches.

It reads the ICAO alphabet (Alpha, Bravo…), the older APCO one (Adam, Boy…), letters said as letters, and numbers said
as words. After "reg", "registration", "plate" or "tag" ("Mass range" too, as it's often misheard) it takes 2 to 8
letters and digits. With nothing before it, it takes 5 to 8 with at least two spelled letters and a digit
("Papa Juliet 415"), but not a ham callsign ("November 1 Victor Zulu" is N1VZ), a phone number, or a unit like "5 A1".

From real traffic, a few more rules:

- **Said twice.** Dispatch repeats a plate to confirm it ("4 Foxtrot Yankee Victor 34, 4 FYV 34"), and the
  recogniser runs the two together. An exact repeat marks where the plate ends: 4FYV34, not 4FYV344.
- **Not a plate.** A run of letters and digits isn't a plate when:
  - it ends in a number with a point ("PL 114.8" is a repeater's tone);
  - it's too long ("Mike Charlie India November November India Sierra 528 74" spells a name, then a date of birth);
  - it's one short thing said twice ("A12. A12").
- **One plate, several readings.** When engines read the ends differently (6PTP38 and H6PTP38), the one more
  readings read is kept. When they're read as often, both are kept, since one may be cut short.
- **Ham channels.** On a channel whose service is amateur, only a plate after "reg" or "plate" is read: a callsign
  is spelled out the same way.
- **The model's own plates.** A plate the model writes must look like one: 5 to 8 letters and digits, both (any 2 to
  8 after "reg" or "plate"). It mustn't be another reading of a plate read out, and on a ham channel it needs "reg"
  or "plate" said. A unit ("A12"), an apartment ("918") or a word ("REVOKED") is taken out and shown as "Left out,
  not a plate".

### What was said

A small model copies details from the context it's given, however it's told not to: "So you're in route at 2043"
came back with the address, vehicle, patient and units of the call before it, and a ham net's chat with a domestic
call's address. So every value the model writes is checked against what the transmission said, in any of its
readings (`src/heard.js`), and taken out if it wasn't:

- One of the words that tell it apart must have been said, or one a letter or two away ("Beechwood" for Beachwood
  Drive). Words most calls share don't count: "Fire" in "Rutland Fire", "female" in "89-year-old female".
- A value of only numbers and those words ("Car 12", "Quad 1") needs its number said. Numbers said as words count.
- An address needs its house number said too; its road may still be kept on its own.
- A road counts if it's one of those near the channel that sound like something said, so a mishearing put right stays.
- The letters a plate was spelled in don't count as words: "Sierra" read out isn't Sierra Street.
- A correction to an earlier finding needs its new value said.

The summary isn't checked. What was taken out shows under the finding on the Findings tab, as **Left out, not said in
it**: when something right is taken out, that line and the prompt are what to send in.

### Times said

Dispatch logs a unit en route, on scene or back in quarters by the 24-hour clock ("in route 1447", "back 0555"), and
the model wrote those numbers as roads and addresses ("Route 1447", "University 1717"). So `src/times.js` reads a
number of 3 or 4 digits (or with a colon, "8:30") within 5 minutes of the clock when it was said, in the server's time
zone, as a time. In real traffic they were 0 to 3 minutes off. Not a time:

- a house number: a road's kind follows ("1447 Main Street");
- a number of something said before it ("Unit 1447", "room 315", "Code 1447");
- a three-digit route ("Route 146"): no route has four digits, so "Route 1447" is a time.

The times go to the model after the transmission ("Times said in it: 1447 (2:47 PM)"), and an address, road or unit
the model writes that's only a time is taken out, shown as **Left out, a time**.

### Hearing a clip again

Hearing the same clip with the same engine gives the same words, so a clip is heard again *told which words to
expect*: whisper-server takes a prompt, which it reads as what was said just before the clip and leans towards. It's
sent when:

- the model answers `again`, and the transmission has that kind of thing in it:
  - `plate` (one only partly heard): "reg" or "plate" said, a plate read out, or two words of the phonetic alphabet;
  - `number` (a house number unclear): digits with a road's kind a few words on ("42 Cutler Street");
  - `road` (a name that doesn't sound right): a road's kind said ("Street", "Road");
  - for both of those, roads near the channel to tell it.
- "plate" or "reg" was said with no plate after it, or the readings give two versions of one plate equally often.

The check on the model's answer is there because of real traffic. Asked "is anything misheard?", qwen3:14b said "plate"
for "Thank you" and "Raising funds". Of 650 transmissions read, 478 were heard again, and the replies seldom helped.

What it's told depends on why, and is only the words that might be misheard. For a plate that's the phonetic
alphabet; for a road or a number, the roads near the channel that sound like something said. Whisper reads a prompt
as what was said just before, and writes its words into a mumble. A lead-in of "Copy. En route. Received." turned
"Receive 11" into "Received", and a road list turned "stand by for the following" into "Boulevard, Whitaker". It's
never told what the model thought was said.

The new transcript is kept beside the first, as `<engine>+again1`, and the transmission is read again with it as
another reading, which the model is told was heard with words to expect: a clip told "Beachwood Drive" may hear
Beachwood Drive in noise, so it's weighed as a hint, not as proof. What was found is still checked against the first
hearings (see [What was said](#what-was-said)). The clip heard again can settle between them, but a road, name or
number only it heard is left out. One exception: a plate it finishes ("plate Adam Boy Charlie one", then ABC123) is
kept. The finding shows **heard again: plate** (or
number, road).

Set on Admin → Findings: **Hear again up to** 0 to 2 times (1 by default; 0 never), **with** an engine that takes a
prompt (the default engine if it does). Clips heard again wait behind live traffic.

### Corrections

"Correction, one-twelve Main" after a finding of "12 Main St": the model is asked to say when the new transmission
corrects a detail of an earlier finding it was given, or says it more clearly (a house number, a plate, a street).
AirScribe changes that finding's value, so the Map moves its road and a corrected plate is checked against the watch
list, and both findings say so: **corrected** on the earlier one, **corrects** on the later. Only a finding the model
was shown is changed, and only a value it has ("12 Main Street" matches "12 Main St"; a plate however it's spaced);
anything else it claims is left alone. What was first found is kept in the database (`findings.original`). The
transcripts themselves never change. A transmission read again starts from its new answer.

### Notes on a finding

When the model gets something wrong, an admin can say so on the finding itself: **Add a note** under it ("the car
is grey, not great"). Everyone signed in sees the note. The model is given it with that finding whenever the
finding is listed with a later transmission ("…; a person's note on it: the car is grey, not great"), and with the
transmission itself if it's read again. It's told a note was written by someone who checked, to trust it over what
was found, and to read the new transmission the same way where the note says how something was misheard.

A note helps only while its finding is listed, which is for **Earlier findings, last** minutes. A mishearing that
keeps coming back ("great" for "grey" before every car) is better as a local term, which goes with every
transmission that says it: `great = often a mishearing of "grey", before a vehicle`.

Notes go with the finding: deleted when it is, and in the export.

### Local terms

Radio has its own words, and every area its own: "Code 5", "Q5 statements", "a Section 12 up to UMass". A model
that doesn't know them guesses, or quotes them back. **Admin → Findings → Local terms** says what they mean here.
When a transmission says one, the model gets it after the transmission ("Local terms said in it: Code 4: all is
well"), and is told to use it to understand and sum up. It's also told that a number is a code only where it's said
as one, never a house or apartment number. Only the terms said are sent, so a long list doesn't make every prompt
longer: 12 at most.

A term matches however it was said or heard. "Code four" is Code 4, and "Q 5" and "cue five" are Q5. A long word a
letter off still counts ("secton 12"). An entry can be kept to some channels (`PD F*, Fire Ops*`, with * for any
characters), so one code can mean one thing on the police channels and another on fire's.

There are four kinds of entry:

| Kind | Where it comes from | Given to the model |
| --- | --- | --- |
| **Known** | an admin added it, accepted a guess, or imported it | as what it means |
| **Guess** | the model worked it out from how it was used | marked "possibly … not confirmed": a hint it weighs against the transmission |
| **Collected** | said on the air, not worked out yet | no |
| **Rejected** | an admin rejected the guess | no |

**Collected.** As each transmission is read, AirScribe notes the codes said in it: "Code 5", "Signal 23", "Unit 26"
(not "Unit 308" after a street, which is an apartment) and "10-4" as written. It also notes the terms the model
says it didn't know (its `terms` answer), but only those the transmission really says. Each is counted, with the
last 12 transmissions it was said in.

**Worked out.** Once a collected term has been said 3 times, the model is asked what it likely means, given only
those transmissions and their channels, never its own earlier guess. With nothing waiting to be read, Findings
does this by itself every 15 minutes, a few terms at a time. **Work out meanings now** does it at once. An answer
with a meaning becomes a guess, with the model's confidence (low, medium, high). An answer without one stays
collected, to be asked again after 5 more uses. **Ask again** sends a rejected term back to be collected.

Each entry shows the transmissions it was said in. **Import or export** reads and writes the known ones, a line
each: `term = meaning`, with `| channels` after it to keep it to those. Lines starting with `#` are skipped. The
export file ([Sharing what it did](#sharing-what-it-did)) lists the known terms and guesses.

From the Nov 25 export of real Worcester-area traffic, the codes most said were Code 5 (18 times), Code 22 (6) and
Code 4 (4). The signal codes and Oscar/Charlie car numbers on older scanner guides weren't said at all, so a guide's
whole list is worth less than the terms the traffic actually uses.

**Treat it as a lead, not a fact.** Speech recognition mishears radio, and a model can turn a misheard word into a
confident wrong plate or address. Each finding shows the transcript and plays the clip: check them before acting on
anything. A bigger speech model (large-v3-turbo on a GPU) helps more than a bigger language model.

## The day so far

**Findings → The day so far** sums up the day, an hour at a time, and is rewritten as the day goes on.

- **Each hour.** A few minutes after an hour is over, once its transmissions have been read (Findings waits
  **Wait for other engines** for them, plus 5 minutes), its findings go to the model 60 at a time, a channel's
  together. The model picks out what happened: one item for each call or conversation, a plain sentence, citing
  the findings it came from. Routine traffic is left out. For ham traffic, the item says what was talked about.
  A note on a finding goes with it.
- **Grounded in the findings.** An item has to name at least one of the findings it was given, or it's dropped.
  Its channel, radio and service are taken from those findings, not from what the model says.
- **The overview.** After each hour, the day's overview is written again from all of the day's items: once for
  every radio, and once for each radio heard that day. It's 3 to 6 sentences, the most serious first. With more
  items than fit (about 10k tokens), those drawn from the most transmissions are kept.
- **Late findings.** If a transmission of an hour already summed up is read late, that hour is summed up again.
  Hours from the last 36 are looked at, up to 6 at a time, the latest first, every 5 minutes when nothing is
  waiting to be read. An hour the model fails on is tried again 30 minutes later; the tab shows the error.

The tab shows the day's overview, then its hours, newest first, each item with its time, channel and service. A
click on an item's transmissions opens the findings it came from, to read and play. Pick a day, a radio (its own
overview) or a channel (its items only). How busy each hour and channel was is on Insights, not repeated here.
Admins can **Update now**, and turn it off with **Sum up each hour** in Admin → Findings.

On 2,500 findings a day that's about 2 questions an hour for the items, plus one overview per radio, a few
seconds each. Days follow the AirScribe server's time zone: set the container's (`timedatectl set-timezone
America/New_York`) or midnight comes at the wrong hour. Digests are kept as long as findings are.

## Watches

A watch is a term: a plate, a street, a name, a phrase. Each transcript, and each field the model found, is checked:

- **Whole words, abbreviations spelled out:** "Elm St" matches "412 Elm Street" and "elm st.", not "helm".
- **A plate however it's spaced:** "ABC 123", "abc-123" and "ABC123" all match a plate found as ABC123, and a transcript
  where it was read out letter by letter ("a b c 1 2 3").
- **Even when the model fails:** a transcript is still checked when the server can't be reached.

A match is kept (once per watch and transmission), counted on the watch, marked in the list of findings, and posted to
the webhook:

```json
{
  "event": "airscribe.findings.watch",
  "term": "ABC 123", "note": "the stolen Honda", "field": "plates", "value": "ABC123",
  "transmission": {
    "id": 4821, "startedAt": "2026-11-21T22:49:56.000Z", "channel": "Holden PD",
    "text": "Car 12 respond to four twelve elm street…", "summary": "Two-car crash at 412 Elm Street",
    "incident": "motor vehicle crash"
  }
}
```

For Home Assistant, make an automation with a **Webhook** trigger (it gives a URL like
`http://homeassistant.local:8123/api/webhook/<id>`), and use `trigger.json.term` and `trigger.json.transmission.summary`
in a notification. The webhook URL is the only thing that guards an HA webhook, so keep it to your own network.

## Reading them

The **Findings** tab's **Found** lists the transmissions read, newest first: when, the channel, the summary, the kind of
call, the transcript, what was found (watched values marked), and the clip. **Search** looks in what was found and in
the transcripts (a plate however it's spaced); **only watch matches** narrows it to those, and the radio and channel
lists to one radio's or one channel's (the Map's Findings tab has its own, which the roads on the map follow too). **Delete all findings**
empties it; the watch list stays. A call another radio also heard says so (**also heard**), with what that radio heard
and its clip; a search finds it by those words too. While the tab is open, a new finding goes on top within about five
seconds, even after **More**. The whole list is reloaded every 30 seconds, so corrections to older rows show, except after
**More** or while one of its clips is playing.

### Sharing what it did

To look into what the model gets wrong, an admin can download what it was given and what came of it: **Export the
last N hours … with what was sent to the model**, under the search on the Findings tab, for the radio and channel
chosen there. It's one JSON file: the instructions; the settings that shape the prompt (the model, the engines, the
numbers above, but never the server's address, the API key or the webhook); and each transmission read, oldest first,
with every engine's transcript (and any heard again), the prompt sent, the answer as kept and as first found, what
was left out as not said, the tokens and time, and its corrections. It holds what was heard on the radio, names and
addresses included, so share it as carefully as the clips.

**Speak new findings** (beside **Refresh**, and **Speak new** on the Map's Findings tab) has this browser read out
each finding made from then on: its channel and summary, a plate letter by letter, "through static" when it was.
They're said one after another, after any clip that's playing, and the feed's **Play new** waits while one is said. A
summary much like one said in the last three minutes isn't said again: a dispatcher repeats a call as a second
transmission, and a call sent out on two channels at once is two findings. With AirScribe open in several tabs, only
one speaks; another browser is separate, and speaks too if it's ticked there.
Findings aren't on the event stream, so the page asks for new ones every five seconds; after a while away, only the
latest five are said. The voice is the browser's (the list beside it has the others it offers), and a browser may
want a click on the page first: ticking the box is one; after a reload it may say "blocked by the browser: tick it
again". It's remembered in this browser. Nothing is sent anywhere to be spoken, unless the voice chosen is marked
"online", which some browsers send to their maker's servers.

The same, for scripts. Reading takes any signed-in user's token or session; the rest, an admin's:

| | |
| --- | --- |
| `GET /api/findings` | on or off, how many are kept, when the last was made (`latestAt`), the model's instructions |
| `GET /api/findings/results` | `?q=&hits=1&before=&since=&limit=&channel=&radio=` (a radio by its address): findings, newest first; or `?after=` (ms): those made since then, in the order made (`madeAt`). Each with what was `sent`, whether it was `static`, the `usage` (tokens, time), and its corrections (`correctedBy`, `corrects`) |
| `GET /api/findings/watches` | the watch list |
| `GET /api/findings/map` | `?hours=&also=&channel=&radio=`: the roads mentioned, as GeoJSON with what was said about each |
| `GET /api/admin/findings` | the settings (never the key), how many are kept, the biggest prompt of the last day, the last error |
| `PUT /api/admin/findings` | change them: `enabled`, `api`, `url`, `model`, `apiKey`, `webhook`, `keepDays`, `contextMinutes`, `contextCount`, `othersCount`, `sameCallSeconds`, `waitMinutes`, `findingsCount`, `findingsMinutes`; `forgetKey` |
| `POST /api/admin/findings/test` | `{text?}`: one through the model |
| `GET /api/admin/findings/export` | `?hours=&channel=&radio=` (1 to 744 hours, 24 by default): the file above, as an attachment |
| `POST /api/admin/findings/backfill` | `{hours}`: read the transmissions of the last `hours` |
| `GET /api/admin/findings/results` | `?q=&hits=1&before=&limit=&ids=`: findings, newest first; `ids` for those listed |
| `GET`, `POST /api/admin/findings/watches`; `DELETE …/watches/:id` | the watch list |
| `GET`, `POST /api/admin/findings/terms`; `PUT`, `DELETE …/terms/:id` | local terms, and their counts; `{term, meaning, channels}`; `{meaning, channels, status}` |
| `GET /api/findings/digest` | `?day=&radio=&channel=`: the day so far, its overview and items by hour |
| `POST /api/admin/findings/digest/run` | sum up the hours that are over, now |
| `PUT /api/admin/findings/:id/note` | `{note}`: a note on a finding; empty takes it off |
| `GET /api/admin/findings/terms/:id/seen` | the transmissions a term was said in |
| `POST /api/admin/findings/terms/learn` | work out what the collected terms mean, now |
| `POST /api/admin/findings/terms/import`; `GET …/terms/export` | `{text}`, a line each; the known ones, as text |
| `POST /api/admin/findings/forget` | delete every finding and match |

## Roads

With the roads around the channels in **Admin → Findings → Roads**, Findings does two more things:

- **The model is told the roads near the channel** whose names sound like something said. "Pheasant Street" in the
  transcript, with Pleasant Street a mile from the channel, is given to the model as Pleasant Street, and it writes
  that. Only names close to words in the transmission are sent, at most 25, never the whole list, likeliest first:
  a name said whole ("Walnut Street"), then one said without its kind ("Holly"), then one a mishearing away
  ("Burncot" for Burncoat Street), then the others sharing a name said whole (Main Circle when "Main Street" was).
  Names only the earlier transmissions say come after all of the new one's. A name of common words alone ("A
  Street", "The Boulevard", "My Way") is never sent for "a", "the" or "my". The channel's name goes with them. A
  ham channel gets none: a chat about antennas sounded like 25 roads ("My Way", "Guys Way"), and the model reported
  some.
- **The roads mentioned light up on the Map.** On the Map's **Findings** tab, a signed-in user has **Roads on the map** (on unless
  unticked) and chooses how far back; the tab lists what was found in that time, and **Show** frames the roads one mentions. Each road a finding names is drawn where it runs near the transmission's channel, in the colour
  of the service that last mentioned it (police blue, fire red, EMS yellow, public works orange, amateur purple, other
  grey), fading the longer ago within the hours chosen, and wider the more it's been mentioned. A road whose name was only *like* one there (misheard,
  maybe) is dashed. Where an address names two roads that meet ("Main St and Route 9"), the corner gets a dot.
  Clicking one lists what was said about it, with the clip. **On the map** beside a finding goes there.

### Places and addresses

With towns, named places and addresses imported beside the roads ([getting them](#roads)):

- **Places said go to the model too**, after the roads: towns and parts of town within 60 km of the channel, and
  businesses, schools and the like within 25 km, whose names were said or are a mishearing away ("Family Dolar"
  for Family Dollar, "Grimfield" for Brimfield), at most 12, each with what it is and its street: "Family Dollar
  (variety store, High Street)". The model writes a business as a named place in the addresses, not a road, and a
  town after its street.
- **A town said a few kilometres off has its roads looked at too.** A county dispatch sends units to the next town:
  "East Hill Road, Brimfield" on a channel placed in Sturbridge gets Brimfield's roads first, then the channel's.
- **House numbers said are checked.** A number said just before a road near the channel ("1616 Roxbury Street") is
  looked up on that street, and the model is told: "Addresses said, checked against the map: 16 Roxbury Street is
  there; 1616 Roxbury Street isn't (its numbers run 16 to 120)". Where two numbers were said for one place, it
  reports the one that's there. Only streets with addresses imported are checked: no addresses, no line.
- **A house number that's the time said** ("1720. On arrival…" read as "1720 Lancaster Street") is taken out as a
  time when Lancaster Street has no 1720, though it has a road's kind ([times said](#times-said)).
- **On the Map,** an address whose house is among those imported gets a small dot at the house, beside its road;
  a named place found ("Family Dollar", "Walmart on Route 20") gets a dot ringed dark; and an address ending in a
  town ("26 East Hill Road, Brimfield") is looked for around that town, not the channel.

A road is found by its name, its other names (`alt_name`, `old_name`, …) and its number. "Route 9", "Rt 9", "State
Route 9" and "Highway 9" all find a road numbered `MA 9`, and "I-290" and "Interstate 290" find `I 290`. A
name said without its kind ("Elm") finds Elm Street. Of the roads with that name, the stretch nearest the channel is
taken, with any that carry on from it: Main Street in this town, not the next. A channel not placed on the map is
taken to be in the middle of those that are.

**Getting them.** Roads, towns and named places (businesses, schools, halls: [what they're for](#places-and-addresses))
and addresses come together, from one of:

- **From the map's tiles**: the roads within the given distance of the placed channels, read from the
  [OpenMapTiles](https://openmaptiles.org/schema/#transportation_name) tiles the Map's base maps draw (zoom 14, the
  `transportation_name` layer: each road's name, number and class; and the `poi` and `place` layers' named places
  and towns). The tiles' `housenumber` layer has no street for its numbers, so tiles bring no addresses: import
  them from a file. AirScribe finds them through the base maps in
  `map.styles`: the first with a vector source that has that layer. The settings file's `findings.roadTiles` names
  a TileJSON instead. They're the same roads an OpenMapTiles router uses (MaplibreNativeRouting's offline profiles
  read the same two layers), so one planet build serves the map, navigation and this. Tiles cut a road at their
  edges; pieces of one name whose ends lie on each other are joined again. A county takes a few hundred tiles and
  well under a minute. Tiles have only a road's `name` and `ref`, not OpenStreetMap's other names (`alt_name`,
  `old_name`), so a road locals still call by an old name is found only from an OpenStreetMap fetch or file.
- **Fetch from OpenStreetMap**: the named roads, towns, named places and addresses within the given distance of the
  placed channels, from [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) (`overpass-api.de`, or the
  settings file's `findings.overpass`). Only the area's box is sent. It takes a minute or two for a county. Channels
  spread over more than about 150 km are too much for one fetch: use a file.
- **Download and read an extract**: give the address of an OpenStreetMap extract, such as a state's
  `…-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/), and AirScribe downloads it into
  `<dataDir>/osm/`, cuts the area within the given distance of the placed channels out of it with
  [osmium](https://osmcode.org/osmium-tool/), and reads its roads, towns, named places and addresses: the same as
  `tools/roads-from-osm.sh` below, without a PC in between. It needs osmium on the server (`apt install
  osmium-tool`; the package recommends it, and the LXC template has it; the settings file's `findings.osmium`
  names another). The download is kept: reading again within a day, after placing another channel, uses it
  rather than fetching it again. A state's extract is a few hundred MB and takes a few minutes; the channels may
  be any distance apart. Read it again now and then to keep up with OpenStreetMap; Geofabrik updates daily.
- **Import a file**: GeoJSON, one feature a line (GeoJSONSeq) or a FeatureCollection, with OpenStreetMap's tags as
  each feature's properties: lines tagged `highway` are roads; points and areas tagged `place` (city, town,
  village, suburb, neighbourhood…) are towns, those with a `name` and `amenity`, `shop`, `leisure`, `office`,
  `healthcare` and the like are named places, and those with `addr:housenumber` and `addr:street` are addresses.
  An address file of its own works too, with OpenAddresses' `number`, `street` and `city`: a state's address
  points are often far more complete than OpenStreetMap's. `tools/roads-from-osm.sh` makes a file from any
  `.osm.pbf`, a state extract or the whole planet, with [osmium](https://osmcode.org/osmium-tool/), and can send it
  to AirScribe:

  ```sh
  # WEST,SOUTH,EAST,NORTH: the area, a bit beyond the channels
  AIRSCRIBE_TOKEN=<an admin token from auth.tokens> \
    tools/roads-from-osm.sh planet-latest.osm.pbf -72.3,42.0,-71.4,42.7 roads.geojsonseq https://airscribe.example
  ```

  Run after each planet download, it keeps the roads current. From the planet, the cut takes a while; a state
  extract is quicker.

Either way, the new ones replace the old only once they're all in, and each of roads, places and addresses only
when the import has some: an address file leaves the roads and places as they were, and the tiles leave the
addresses. Roads, places and addresses from OpenStreetMap are © OpenStreetMap contributors (ODbL).

| | |
| --- | --- |
| `GET /api/admin/findings/roads` | how many, from where, an import under way, the last failure |
| `POST /api/admin/findings/roads/tiles` | `{km}`: read from the map's tiles, in the background |
| `POST /api/admin/findings/roads/fetch` | `{km}`: fetch from Overpass, in the background |
| `POST /api/admin/findings/roads/extract` | `{url, km}`: download an `.osm.pbf` extract and read it with osmium, in the background |
| `PUT /api/admin/findings/roads?name=` | the file as the body (`application/octet-stream`) |
| `DELETE /api/admin/findings/roads` | delete them |
| `GET /api/admin/findings/map` | `?hours=&also=`: the roads mentioned, as GeoJSON with what was said about each |
