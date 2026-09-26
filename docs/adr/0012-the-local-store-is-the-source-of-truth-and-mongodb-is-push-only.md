# The Local Store is the source of truth, and MongoDB is push-only

Until now the CLI had one database and used it for both directions: every Flush wrote to
MongoDB Atlas, and the history view read back from it. A slow Atlas made the view slow, a down
one made it fail, and a laptop that was offline at the Flush Interval wrote nothing at all.
This ADR splits that one write in two. The **Flush** writes a **Local Store** — SQLite, on the
same machine — and that store is what the history view reads. The **Push** carries Flushed eras
to MongoDB, best-effort, for the website to render. MongoDB is write-only to this CLI from now
on.

## The decision

- The Local Store is SQLite, through Node's built-in `node:sqlite` (`DatabaseSync`). It adds no
  dependency, and the engines floor (`>=22.20.0`) already has it. It is experimental in Node and
  says so once on stderr at import; the documented launch line carries
  `--disable-warning=ExperimentalWarning`. `better-sqlite3` was considered and rejected: a
  native module is a rebuild on every ABI bump, for a repo whose one native artifact — the
  helper — is committed precisely to avoid that.
- The file lives at `~/Library/Application Support/activity-telemetry/telemetry.db` —
  macOS-only by ADR-0005 — and `LOCAL_STORE_PATH` moves it, read in `config.ts` like every
  other variable.
- The store fails fast at open. Unlike MongoDB — best-effort by design — it is the only write a
  Flush is required to reach, and a run that cannot record is a run that will spend hours
  collecting into a retry that can never succeed. An unopenable store ends the run at startup
  with the store's error, before the preflight and before the frame.
- Nothing in the store ages out. It is the record of every era this machine has Flushed;
  MongoDB's TTL indexes remain MongoDB's, created by the Push seam exactly as the store created
  them.

## The schema models the era, not the wire

Two tables: `eras`, keyed by the Flush's stamp, carrying the interval's totals and a
`pushed_at` that is NULL until a Push acknowledges the era; and `era_key_counts`, one row per
Key Label per era. Key Counts are normalised here and flattened back into the wire shape at
Push time — the Local Store's schema is local, and ADR-0004's wire format survives at the Push
seam untouched.

The Push Backlog is a query: `WHERE pushed_at IS NULL ORDER BY stamp`. "The tail of the Local
Store past the last successful Push" is that query, not a second structure to keep in step.

## The stamp is durable now

ADR-0009's stamp guard is per-process, which was enough when a stamp's only audience was the
collections it keyed: a clock that stepped backwards across a restart could stamp a new era
identically to an old one, and against a primary key that is a **merge** of two eras, not an
overwrite. Opening the store seeds the guard from its newest stamp. It costs one query at open
and turns "a fresh stamp repeats nobody" from a promise about one process into one about the
store.

## The Push is a drain

After each successful local Flush, and once at startup, the Pusher drains the backlog: oldest
era first, stopping at the first failure, so the backlog stays a tail rather than a scatter of
holes. It is single-flight and never awaited by the Flush path — a hanging Atlas must not
delay the next local write, which is the write that matters. On the way out, `stop()` awaits
the final Flush, makes one last drain attempt and awaits it, then closes the store and the
Mongo client, in that order: the drain reads the store, so the store closes after it.

The Pusher reports attempts the way the Session reports Flush attempts — through a callback,
with the composition root deciding where the news belongs. A failed drain is one red Run Log
entry per attempt, the same way a failed Flush already repeats each interval. A drain that made
up gathered ground — two eras or more — says so in one plain entry. The steady state, one era
Flushed and Pushed seconds later, says nothing: the Flush's own entry already told that story,
and an entry per interval would push Flush lines out of the six-entry window. `collect` keeps
its stderr, and the end of a run says "N eras await Push" when a backlog survives it — logged,
never an exit code, because a Push that has not happened costs the website an era and never the
CLI one.

## The reads are honest about being synchronous

`node:sqlite` has no promise in it, and the repo's own rule — declare async only where the real
thing is async — applies with full force. `flush()` returns its result directly; the read face
returns its `LoadResult` directly. That kills the machinery that existed to manage the wait:
`use-history.ts` and its three-state `LoadState` are deleted, and the history view calls
`load` during render — a read is sub-millisecond, and the view re-rendered exactly when the old
effect re-fired anyway. The "nothing yet" state existed only because a read took time;
"nothing there" and "could not ask" are still drawn, from data and from a failed `LoadResult`.

The read face keeps its warning reporter for the failure case — the dashboard appends an entry,
`collect` warns on stderr — but the union shrinks: `ignored-buckets` was `$bucket`'s sentinel,
and grouping rows in JavaScript, bounded by the same boundary list that defines the buckets,
leaves no bucket for a stranger to land in.

## What the modules become

`local-store.ts` owns the file and both faces — the write face the Session flushes through, the
read face satisfying `HistorySource`. `storage.ts` becomes `push.ts`: the Mongo write seam, its
narrowed driver slices unchanged, still creating the TTL indexes it always did. `history.ts`
and `aggregation.ts` are deleted — the pipelines are Mongo query language, and the grouping
they did is twenty lines of JavaScript over rows. ADR-0007's principle survives the move: the
boundary list is still the bucket identity, only the `$bucket` that consumed it is gone.

## What does not change

- `MONGO_URI` stays required. A local-only mode is speculative generality for a single-user
  tool; an offline _network_ is fully served by the backlog, and that was the case that
  mattered.
- The wire format is untouched, the website needs no change, and ADR-0004 stands.
- **No backfill**, not even once. MongoDB is never read to fill the store. The history view
  starts empty the day this ships and fills as eras land; the website keeps showing what it
  always showed. The alternative contradicts the definition this ADR exists to write: the
  store is what _this machine_ Flushed.
- Live Totals are untouched: a successful Flush is still the local write, and Push is invisible
  to them.

## Testing

The gate's "no test database" rule is amended to what it always protected: no test _server_.
Fakes remain for every seam above the store; the Local Store itself is tested against real
SQLite files in a temp directory — in-process, offline, and passing on a bare clone.

## Consequences

- The history view starts empty and accumulates. The CLI's first days of local history are
  sparse by design, while the website's is as it ever was.
- A down or slow Atlas costs the run one red entry per Flush Interval and nothing else. The
  view, the Flush cadence and the exit code are out of its reach.
- The write's fsync lands on the same thread that draws the frame — milliseconds, every Flush
  Interval. WAL keeps it there rather than letting it grow.
- The experimental SQLite warning is a documentation cost, paid once, in the launch line.
