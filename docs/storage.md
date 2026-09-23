# Storage backends

**Design, not built.** SQLite is the only backend today. This records what
supporting SQL Server would take, and the one obstacle that decides the shape.

## Why bother

SQLite is the right default: no server, no driver, nothing to install, and a
single scanner node produces a few hundred rows an hour. Nothing about the
current workload needs more.

Two things would justify a second backend:

**High availability.** A transcript log on one machine's disk is lost with
that machine. An availability group survives a node failing, which is the
point of running one.

**Several nodes, one store.** [publishing.md](publishing.md) describes
combining nodes by subscribing to each other's feeds. A shared database is the
other answer: nodes write to the same tables and every view is already
combined, with no feed, no polling and no duplication.

They are not equivalent. A shared database is simpler when every node is
yours, on one network, and you own the database anyway. Feeds are the answer
between people, across networks, and when nodes must keep working while the
others are unreachable. A node writing to a database it cannot reach stops
recording; a node whose peer is unreachable only stops being current.

## The obstacle: everything is synchronous

`node:sqlite` is synchronous, and the code took that freely. `Manager.onClip`
writes a transmission in the middle of a synchronous callback from the
segmenter; every API route calls the store inline. Nothing awaits anything.

A network database cannot be synchronous. So the work is not "add a driver" —
it is **making the store interface asynchronous**, which touches:

- every method on `Store`
- `Manager.onClip`, called synchronously from `Segmenter`'s `onClip`
- roughly twenty call sites across `api.js`

That refactor is most of the job and carries most of the risk. It is also
worth doing on its own: it decouples the store from the assumption that
storage is free and instant, which is not a true thing to believe even about
a local disk.

## Shape

Two phases, because the risky half can be proved without a database server.

**Phase one — make the interface async, keep SQLite.** Every `Store` method
returns a promise; the SQLite implementation simply wraps the synchronous
calls, which is honest, since they really are immediate. `Manager.onClip`
becomes async and serialises its own writes, so transmissions from one radio
cannot be recorded out of order. Every existing test must pass unchanged in
meaning. Nothing new is gained at this point, which is the sign it worked.

**Phase two — add the SQL Server implementation** behind the same interface,
chosen by config:

```json
"store": {
  "backend": "mssql",
  "server": "172.16.1.56",
  "port": 1433,
  "database": "AirScribe",
  "user": "airscribe",
  "password": "…",
  "encrypt": true,
  "trustServerCertificate": true
}
```

## What differs between the dialects

Not much, because the schema is three tables — but enough that the SQL cannot
be shared verbatim:

| | SQLite | SQL Server |
| --- | --- | --- |
| auto id | `INTEGER PRIMARY KEY AUTOINCREMENT` | `INT IDENTITY(1,1) PRIMARY KEY` |
| upsert | `ON CONFLICT … DO UPDATE` | `MERGE`, or update-then-insert |
| limit | `LIMIT ?` | `OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY` |
| introspection | `PRAGMA table_info` | `INFORMATION_SCHEMA.COLUMNS` |
| returning an id | `lastInsertRowid` | `OUTPUT INSERTED.id` |
| reserved words | `"group"` already quoted | `[group]` |

Migrations need a dialect-aware path for the same reason. The existing ones
are additive column adds, which both dialects spell similarly, but
`migrateTranscripts` drops columns and that is worth writing twice rather than
abstracting.

## Things that would bite

**A store that can fail.** SQLite writes do not fail in ways worth handling; a
network one does — a failover takes the listener away for a few seconds. A
transmission whose write fails must not be lost silently: the clip is on disk,
so the sensible answer is a retry, and a clear log rather than a dropped row.

**Failover is automatic, so brief outages are normal operation.** The AG runs
`FAILOVER_MODE = AUTOMATIC` — the runbook still says MANUAL and is out of date
on that point. The listener moves on its own, taking connections with it for
the seconds the move takes. That is not an incident to alert on; it is a
Tuesday.

So the store must **expect to be briefly unreachable** and carry on:

- the driver retries with backoff rather than failing the request
- the server survives the listener disappearing instead of exiting
- a failed write is retried, not dropped — the clip is already on disk, so
  nothing need be lost to a failover

`ALLOW_CONNECTIONS = NO` on the secondary still means no read scale-out;
everything goes through the listener either way.

**A retried write must not duplicate a transmission.** This is the part
automatic failover makes real. A write can fail *after* the server committed
it — the commit succeeded, the acknowledgement did not arrive — and a retry
would then insert the same transmission twice. Nothing in the current schema
prevents it, because SQLite never fails that way.

The answer is a natural key. A transmission is already uniquely identified by
its radio and the instant it started, so a unique constraint on
`(mac, started_at)` makes the retry safe: the second insert collides instead
of duplicating. That constraint is worth adding to the SQLite schema at the
same time, even though it cannot be hit there — a rule the two backends share
is one fewer thing that differs between them.

**Testing.** CI has no SQL Server. The dialect-specific SQL can be unit
tested by asserting on generated statements, and the rest with a container
when one is available — but a backend that cannot be tested in CI will rot
unless someone runs it regularly.

## Where the clips live

Rows in a shared database and clips on local disk is a half-measure: several
front ends would list each other's transmissions and then fail to play them.
The earlier HTCommander work put the audio in the database for exactly this
reason, and that is the right call once more than one server is serving the
same log.

A separate table rather than a column on `transmissions`, so listing the feed
never drags the audio along:

```
clips(transmission_id, format, bytes, audio)
```

**The size is the thing to plan for.** Raw 32 kHz mono is 64 kB/s, and a busy
scanner produced 22 minutes of audio in 3.9 hours — about 85 MB, so roughly
half a gigabyte a day, 15 GB a month. Synchronous-commit replication carries
all of it to the secondary. That is not alarming on a LAN, but it makes two
things load-bearing rather than optional:

- **Retention.** The audio rules in [publishing.md](publishing.md) stop being
  a tidiness feature and become the thing that keeps the database from
  growing without limit.
- **Encoding.** ffmpeg is already a dependency for the SBC decode, and Opus
  at this bandwidth is roughly a tenth the size. Storing clips encoded rather
  than raw turns 15 GB a month into 1.5 GB, at the cost of decoding again to
  transcribe — or keeping the WAV only until the engines have read it.

Serving a clip becomes streaming a blob rather than `sendFile`, which means
handling Range requests by hand. That is not hard, but it is the part that
`sendFile` was doing for free, and players depend on it.

A reasonable shape is to make clip storage its own choice — `disk` or
`database` — rather than tying it to the row backend. A single node has no
reason to pay the blob cost, and a multi-node deployment has no reason to
accept a shared filesystem.
