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
| Server | Ollama | Ollama's own API (`/api/chat`): the answer is held to a JSON schema, and a thinking model's thinking is turned off, which makes it several times quicker. OpenAI-style: `/v1/chat/completions` with a `json_schema` response format. |
| Address | | The server, `http://` or `https://`. |
| Model | `qwen3:8b` | As the server names it. |
| API key | none | Sent as `Authorization: Bearer`. Kept on this server and never shown again. |
| Webhook | none | Posted to for each watch match (below). |
| Keep for | 30 days | Findings and matches older than this are deleted, hourly. So are those of a deleted transmission. |
| Look back | 5 min | How far back the earlier transmissions given with each one go (1–30). |
| This channel's last | 5 | How many of the same channel's (0–20; 0 gives none). |
| Other channels' last | 5 | How many of the other channels' (0–20; 0 gives none). |
| Same call within | 5 s | Another radio on the same frequency this close heard the same transmission (0–30; 0 never counts one). |
| Wait for other engines | 3 min | How long to wait for the other speech engines before reading with the default one's alone (0–30; 0 reads the default engine's alone, as soon as it's done). |

## What the model is asked

The new transmission's transcript, and as context (numbers as set above) up to five earlier ones on the same channel from the five minutes
before it, so "the plate is…" after "Car 12, traffic stop on Route 9" reads as one call. Up to five from other channels in
the same five minutes go with it too, each with its channel and how long before, so a unit dispatched on one channel
and talking on another can be followed. It's told those are context only: what it reports is what the new one says.

The new one's transcript is the default engine's, or, when that heard nothing, the engine's that heard most. After
it come **other readings** of the same words: each other engine's, when it differs, and another radio's that heard
the same frequency within five seconds (two radios on one dispatch channel, a scanner and a handheld). The model is
told to use them together to work out what was said. A copy from another radio is left out of the other channels'
traffic. Any of them that came through
static is marked "heard through static", and the model is told to report from those only what reads clearly: speech
recognition writes words into hiss.

Each finding has **Sent to the model** under it: the message as it went, with the channel, the road names hinted, the
context and the transcript. The instructions that go with every one are at the top of the Findings tab. It's told to report only what
the new one says, to leave out what isn't said rather than guess, and to answer with:

| Field | |
| --- | --- |
| `summary` | One short sentence, or empty when nothing of substance was said |
| `incident` | The kind of call: "motor vehicle crash", "structure fire" |
| `service` | Who is talking: `police`, `fire`, `ems`, `works` (public works, highway, utilities, transit), `amateur` or `other`. The channel's name helps it ("Holden PD") |
| `addresses` | Addresses, intersections and named places: "412 Elm St", "Main St and Route 9" |
| `roads` | The roads those mention, each once: "Elm Street", "Route 9" |
| `plates` | Letters and digits only; a phonetic alphabet read out ("Adam Boy Charlie 1 2 3") becomes letters: "ABC123" |
| `vehicles` | "red Honda Civic" |
| `people` | Names or descriptions, not unit or badge numbers |
| `units` | "Engine 2", "Medic 4", "Car 12" |

Whatever comes back is held to that shape: lists of short strings, plates as 2 to 10 letters and digits.

**Treat it as a lead, not a fact.** Speech recognition mishears radio, and a model can turn a misheard word into a
confident wrong plate or address. Each finding shows the transcript and plays the clip: check them before acting on
anything. A bigger speech model (large-v3-turbo on a GPU) helps more than a bigger language model.

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
the transcripts (a plate however it's spaced); **only watch matches** narrows it to those. **Delete all findings**
empties it; the watch list stays.

The same, for scripts. Reading takes any signed-in user's token or session; the rest, an admin's:

| | |
| --- | --- |
| `GET /api/findings` | on or off, how many are kept, the model's instructions |
| `GET /api/findings/results` | `?q=&hits=1&before=&limit=`: findings, newest first, each with what was `sent` and whether it was `static` |
| `GET /api/findings/watches` | the watch list |
| `GET /api/findings/map` | `?hours=&also=`: the roads mentioned, as GeoJSON with what was said about each |
| `GET /api/admin/findings` | the settings (never the key), how many are kept, the last error |
| `PUT /api/admin/findings` | change them: `enabled`, `api`, `url`, `model`, `apiKey`, `webhook`, `keepDays`, `contextMinutes`, `contextCount`, `othersCount`, `sameCallSeconds`, `waitMinutes`; `forgetKey` |
| `POST /api/admin/findings/test` | `{text?}`: one through the model |
| `POST /api/admin/findings/backfill` | `{hours}`: read the transmissions of the last `hours` |
| `GET /api/admin/findings/results` | `?q=&hits=1&before=&limit=`: findings, newest first |
| `GET`, `POST /api/admin/findings/watches`; `DELETE …/watches/:id` | the watch list |
| `POST /api/admin/findings/forget` | delete every finding and match |

## Roads

With the roads around the channels in **Admin → Findings → Roads**, Findings does two more things:

- **The model is told the roads near the channel** whose names sound like something said. "Pheasant Street" in the
  transcript, with Pleasant Street a mile from the channel, is given to the model as Pleasant Street, and it writes
  that. Only names close to words in the transmission are sent, at most 25, never the whole list. The channel's name
  goes with them.
- **The roads mentioned light up on the Map.** On the Map's **Findings** tab, a signed-in user ticks **Roads on the map** and chooses how
  far back; the tab lists what was found in that time, and **Show** frames the roads one mentions. Each road a finding names is drawn where it runs near the transmission's channel, in the colour
  of the service that last mentioned it (police blue, fire red, EMS yellow, public works orange, amateur purple, other
  grey), fading the longer ago within the hours chosen, and wider the more it's been mentioned. A road whose name was only *like* one there (misheard,
  maybe) is dashed. Where an address names two roads that meet ("Main St and Route 9"), the corner gets a dot.
  Clicking one lists what was said about it, with the clip. **On the map** beside a finding goes there.

A road is found by its name, its other names (`alt_name`, `old_name`, …) and its number. "Route 9", "Rt 9", "State
Route 9" and "Highway 9" all find a road numbered `MA 9`, and "I-290" and "Interstate 290" find `I 290`. A
name said without its kind ("Elm") finds Elm Street. Of the roads with that name, the stretch nearest the channel is
taken, with any that carry on from it: Main Street in this town, not the next. A channel not placed on the map is
taken to be in the middle of those that are.

**Getting them.** One of:

- **From the map's tiles**: the roads within the given distance of the placed channels, read from the
  [OpenMapTiles](https://openmaptiles.org/schema/#transportation_name) tiles the Map's base maps draw (zoom 14, the
  `transportation_name` layer: each road's name, number and class). AirScribe finds them through the base maps in
  `map.styles`: the first with a vector source that has that layer. The settings file's `findings.roadTiles` names
  a TileJSON instead. They're the same roads an OpenMapTiles router uses (MaplibreNativeRouting's offline profiles
  read the same two layers), so one planet build serves the map, navigation and this. Tiles cut a road at their
  edges; pieces of one name whose ends lie on each other are joined again. A county takes a few hundred tiles and
  well under a minute. Tiles have only a road's `name` and `ref`, not OpenStreetMap's other names (`alt_name`,
  `old_name`), so a road locals still call by an old name is found only from an OpenStreetMap fetch or file.
- **Fetch from OpenStreetMap**: the named roads within the given distance of the placed channels, from
  [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) (`overpass-api.de`, or the settings file's
  `findings.overpass`). Only the area's box is sent. It takes a minute or two for a county. Channels spread over
  more than about 150 km are too much for one fetch: use a file.
- **Import a file**: GeoJSON, one feature a line (GeoJSONSeq) or a FeatureCollection, with OpenStreetMap's tags as
  each feature's properties. `tools/roads-from-osm.sh` makes one from any `.osm.pbf`, a state extract or the whole
  planet, with [osmium](https://osmcode.org/osmium-tool/), and can send it to AirScribe:

  ```sh
  # WEST,SOUTH,EAST,NORTH: the area, a bit beyond the channels
  AIRSCRIBE_TOKEN=<an admin token from auth.tokens> \
    tools/roads-from-osm.sh planet-latest.osm.pbf -72.3,42.0,-71.4,42.7 roads.geojsonseq https://airscribe.example
  ```

  Run after each planet download, it keeps the roads current. From the planet, the cut takes a while; a state
  extract is quicker.

Either way, the new roads replace the old only once they're all in. Roads are © OpenStreetMap contributors (ODbL).

| | |
| --- | --- |
| `GET /api/admin/findings/roads` | how many, from where, an import under way, the last failure |
| `POST /api/admin/findings/roads/tiles` | `{km}`: read from the map's tiles, in the background |
| `POST /api/admin/findings/roads/fetch` | `{km}`: fetch from Overpass, in the background |
| `PUT /api/admin/findings/roads?name=` | the file as the body (`application/octet-stream`) |
| `DELETE /api/admin/findings/roads` | delete them |
| `GET /api/admin/findings/map` | `?hours=&also=`: the roads mentioned, as GeoJSON with what was said about each |
