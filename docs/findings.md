# Findings

Findings has a language model read each transcript and pick out what's useful: the addresses, roads, plates, vehicles,
people and units mentioned, the kind of call, and a one-line summary. A **watch list** of plates, streets, names or
phrases is checked against each transcript and against what the model found, and a match can be posted to a webhook.

It's off until an admin turns it on, and **only admins ever see it**. What it keeps is about third parties heard on the
radio, so it isn't in the feed, the event stream, exports, the public view or anything a viewer can reach. It lives
under Admin, behind Admin's own two-step check ([two-step.md](two-step.md)), and is deleted after a set number of days.

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

From then on, each transcript from the default engine is read as it's finished, one at a time, behind live
transcription. **Read the last N hours** reads earlier ones that haven't been. A transmission with less than two words
of speech (a beep, `[BLANK_AUDIO]`) isn't sent.

| Setting | | |
| --- | --- | --- |
| Server | Ollama | Ollama's own API (`/api/chat`): the answer is held to a JSON schema, and a thinking model's thinking is turned off, which makes it several times quicker. OpenAI-style: `/v1/chat/completions` with a `json_schema` response format. |
| Address | | The server, `http://` or `https://`. |
| Model | `qwen3:8b` | As the server names it. |
| API key | none | Sent as `Authorization: Bearer`. Kept on this server and never shown again. |
| Webhook | none | Posted to for each watch match (below). |
| Keep for | 30 days | Findings and matches older than this are deleted, hourly. So are those of a deleted transmission. |

## What the model is asked

The new transmission's transcript, and as context up to three earlier ones on the same channel from the five minutes
before it, so "the plate is…" after "Car 12, traffic stop on Route 9" reads as one call. It's told to report only what
the new one says, to leave out what isn't said rather than guess, and to answer with:

| Field | |
| --- | --- |
| `summary` | One short sentence, or empty when nothing of substance was said |
| `incident` | The kind of call: "motor vehicle crash", "structure fire" |
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

**Admin → Findings → Found** lists the transmissions read, newest first: when, the channel, the summary, the kind of
call, the transcript, what was found (watched values marked), and the clip. **Search** looks in what was found and in
the transcripts (a plate however it's spaced); **only watch matches** narrows it to those. **Delete all findings**
empties it; the watch list stays.

The same, for scripts, with an admin's token or session:

| | |
| --- | --- |
| `GET /api/admin/findings` | the settings (never the key), how many are kept, the last error |
| `PUT /api/admin/findings` | change them: `enabled`, `api`, `url`, `model`, `apiKey`, `webhook`, `keepDays`; `forgetKey` |
| `POST /api/admin/findings/test` | `{text?}`: one through the model |
| `POST /api/admin/findings/backfill` | `{hours}`: read the transmissions of the last `hours` |
| `GET /api/admin/findings/results` | `?q=&hits=1&before=&limit=`: findings, newest first |
| `GET`, `POST /api/admin/findings/watches`; `DELETE …/watches/:id` | the watch list |
| `POST /api/admin/findings/forget` | delete every finding and match |

## Later: roads on the map

`roads` is there for the Map: lighting up the roads a channel mentioned, near where the channel is, by matching their
names in the map's own road layer, with the summary and the clip a click away. That part isn't built yet.
