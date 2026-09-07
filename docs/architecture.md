# Architecture

Written at Stage 4, when telemetry made the shape of the system real. It
describes what exists, not what is planned; later stages extend it.

## The shape

```
Minecraft server (Paper, loopback only)
        │  protocol
        ▼
Mineflayer  ──────────────────────────────  src/bot/connection.ts
        │   connect, reconnect, kill switch
        ▼
Observations ─────────────────────────────  src/bot/observations.ts
        │   pure, serialisable, bounded (ADR-005)
        ▼
Actions  ─────────────────────────────────  src/bot/actions/
        │   typed results, never throw (ADR-007)
        ▼
Logger   ─────────────────────────────────  src/util/log.ts
        │   structured events, sink-agnostic
        ▼
Sinks    ─────────────────────────────────  src/telemetry/sink.ts
        ├── console (operator watching a run)
        └── SQLite  (the experimental record)
```

The single most useful property of this stack is that **each layer knows
nothing about the layer above it**. The logger has no Minecraft types; the
observations have no database; the actions have no idea whether a human or a
model called them. That is what let Stage 4 be a sink swap rather than a
rewrite, and it is what will let Stage 5 drop Claude in above the action layer
without touching anything below it.

## Telemetry

### Why events plus snapshots, not a tick log

Minecraft runs at 20 ticks a second. Eight agents logging state every tick
would produce tens of millions of near-identical rows a day — unaffordable to
store and, worse, unanalysable.

So two complementary records:

- **Events** say what *changed*. Every action emits exactly one, success or
  failure, through the `runAction` wrapper. Chat, connection, damage and death
  emit their own.
- **Snapshots** say what was *true*, occasionally: on spawn, on death, every
  60 seconds, and at shutdown.

Snapshots are not a luxury. Answering "what was it carrying when it died?" by
replaying every item event from the start is fragile and becomes wrong the
first time one event is missed. The snapshot is the ground truth the event
stream is reconciled against.

### Schema

Five tables ([src/telemetry/schema.ts](../src/telemetry/schema.ts)):

| table | holds |
|---|---|
| `runs` | one row per experiment; without it, two runs against one world interleave and every aggregate becomes meaningless |
| `agents` | identity; the offline-mode UUID is a stable function of the username (Stage 1) |
| `events` | the core record — what, when, where, whether it worked, how long |
| `snapshots` | periodic full state including inventory as JSON |
| `meta` | schema version, checked on open |

Tables the brief also lists — goals, decisions, relationships — arrive with the
stages that populate them (6, 5 and 11). An empty table is a promise the schema
has not kept, and it invites queries that silently return nothing.

**Some fields are hoisted into columns** rather than left in the JSON payload:
`action`, `ok`, `error_code`, `duration_ms`, `x/y/z`, `minecraft_tick`. These
are the ones queried constantly — "which actions failed and why" should be an
index scan, not a JSON extract across every row. Everything event-specific stays
in `data` as JSON, which SQLite can still query with `json_extract`.

**Error codes are a closed union** (ADR-007), which is what makes
`SELECT error_code, COUNT(*) ... GROUP BY error_code` meaningful. Free-text
messages cannot be counted.

### Durability

`node:sqlite`, built into Node 26 — no dependency, no native module to compile
(ADR-009).

- **WAL** so the query CLI can read while the bot writes. Without it,
  inspecting telemetry mid-run blocks the run.
- **`synchronous = NORMAL`** — one fsync per checkpoint instead of per commit. A
  crash can lose the last few events; it cannot corrupt the file. For research
  telemetry that is the right side of the trade.
- **Batched event writes** (50 rows or 2 seconds). Fsyncing every event would
  make the bot's own actions slower than the Minecraft server.
- **Snapshots write straight through**, unbatched — they are rare and
  individually valuable, and must not be lost in a dropped batch.
- **Telemetry never throws into the bot.** A failed write is reported to stderr
  and dropped. Losing data is bad; taking down a running experiment to avoid
  losing data is worse.

### Imperfect information

Everything recorded comes from what a *specific agent could observe*
([ADR-005](decisions.md#adr-005--observations-are-pure-serialisable-and-bounded)).
Nothing reads the server's world files or another agent's state.

This is a record of experiences, not an omniscient world log. Stage 7's memory
system and Stage 9's misinformation questions both depend on that distinction
holding, and it is far easier to preserve than to reintroduce.

## Inspecting a run

```bash
npm run telemetry              # runs, agents, event counts
npm run telemetry timeline 40  # what happened, in order, with locations
npm run telemetry actions      # attempts, success rate, durations
npm run telemetry errors       # failures grouped by code
npm run telemetry inventory    # snapshots over time
npm run telemetry latency      # reply latency, thinking time, unanswered
npm run telemetry sql "SELECT ..."
```

The subcommands exist to answer Stage 4's six required questions. `sql` exists
because a research database whose only interface is canned reports is not much
of a research database.

## What is not here yet

| | stage |
|---|---|
| Claude decision loop | 5 |
| Goals, agent identity | 6 |
| Persistent agent memory | 7 |
| Multiple agents, communication | 8–9 |
| Economy, relationships, settlements | 10–12 |
| Dashboard | 13 |
| Experiment runner | 14 |

The `runs` table and the `agent_id` column on every row exist now specifically
so that Stage 8's multiple agents and Stage 14's experiment runner do not
require a migration.
