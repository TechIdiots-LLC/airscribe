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

**Failover is not transparent.** The runbook has failover set to MANUAL and
`ALLOW_CONNECTIONS = NO` on the secondary, so there is no read scale-out and
no automatic move. The driver should be configured to retry, and the server
should survive the listener disappearing rather than exiting.

**Testing.** CI has no SQL Server. The dialect-specific SQL can be unit
tested by asserting on generated statements, and the rest with a container
when one is available — but a backend that cannot be tested in CI will rot
unless someone runs it regularly.

**Clips stay on local disk.** Only the rows would be shared. Several nodes on
one database would list each other's transmissions but could not serve each
other's audio without shared storage or a fetch-from-peer path. That is worth
deciding before it surprises someone.
