# MC-Civ-Sim

An artificial-society laboratory built on Minecraft.

The long-term goal is a persistent Minecraft world inhabited by autonomous AI
agents that survive, communicate, cooperate, compete, form relationships, build
settlements and develop economies — with structured telemetry good enough to
analyse the resulting society scientifically.

It is built in strictly sequenced stages. Each stage must produce a working,
testable system before the next begins.

---

## Current stage: **Stages 1–4 complete ✅**

One bot that connects, observes, obeys chat commands, and has a full
deterministic action layer — mine, craft, place, move, eat, collect. No AI yet;
that is Stage 5.

Verified: 15/15 unit tests, 7/7 data checks, 8/8 chat cases, typecheck clean.
Every action returns a typed result rather than throwing
([ADR-007](docs/decisions.md#adr-007--actions-are-typed-results-never-exceptions)).

**Stage 3's success criterion is met**: the bot gathers wood, crafts planks,
sticks and a crafting table, places the table, and navigates out and back —
7 steps, 0 failures.

That required moving from Minecraft 26.1.2 to **1.21.8**. Pathfinding wedges on
26.1.x in real terrain (0/3 reached, 3/3 wedged) and does not on 1.21.8 — an
upstream regression ([#366](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/366)),
not a defect here. Paper 1.21.8 is EOL, which is a deliberate trade: an
unsupported server on a loopback-only machine costs little, a bot that cannot
walk costs every stage from 3 onward. See
[ADR-001](docs/decisions.md#adr-001--target-minecraft-1218-paper-build-60) and
[ADR-008](docs/decisions.md#adr-008--stage-3-was-blocked-by-2612-resolved-by-moving-to-1218).

**Stage 4 is done.** Every event and periodic state snapshot is recorded to
SQLite via `node:sqlite` — no dependency, no native module
([ADR-009](docs/decisions.md#adr-009--telemetry-uses-nodesqlite-not-better-sqlite3)).
Telemetry did not require changing a single existing call site: the logger was
shaped for this in Stage 2, so it was a sink swap. See
[docs/architecture.md](docs/architecture.md).

**There is no AI and no telemetry database yet.** See
[What is not implemented](#what-is-not-implemented).

| Target | Version | Why |
|---|---|---|
| Minecraft | 1.21.8 | newest version where mineflayer-pathfinder does not wedge |
| Paper | build 60 | pinned + SHA-256 verified (EOL 2025-11-14 — see ADR-001) |
| Java | 21+ | Paper 1.21.8 minimum; verified on Temurin 25 |
| Node.js | ≥22 | Mineflayer 4.39 requirement |

`npm run minecraft` refuses to start if the existing world was created by a
different Minecraft version — Minecraft never downgrades a world, and opening
one with an older server corrupts it silently.

## Installation

Requires **Windows** with `winget` (see [docs/development.md](docs/development.md)
for the verified environment baseline).

```bash
winget install --id EclipseAdoptium.Temurin.25.JDK -e
```

```bash
winget install --id Mojang.MinecraftLauncher -e
```

Open a **new** terminal so `PATH` updates, then confirm `java -version` reports
21 or newer. In the Minecraft launcher, create a **1.21.8** profile — the client
version must match the server exactly.

## Starting Minecraft

Prepare the server — downloads and checksum-verifies the Paper jar, installs the
config, and asks you to accept the Minecraft EULA:

```bash
npm run minecraft:setup
```

Start it:

```bash
npm run minecraft
```

Join from the Minecraft Java client at **`127.0.0.1:25565`**.

The console is interactive — type `list`, `save-all`, `stop` directly. **Ctrl-C
performs a graceful save-and-stop** rather than killing the JVM.

Check whether a newer Paper build exists (reports only, never upgrades):

```bash
npm run minecraft:check-latest
```

## Starting the bot

With the server already running in another terminal:

```bash
npm run bot
```

Say `bot help` in Minecraft chat:

| | |
|---|---|
| `status` `inventory` `look` `who` | observe |
| `goto <x> <y> <z>` `come` `follow [name]` `stop` | move |
| `mine <block> [n]` `collect [radius]` | gather |
| `craft <item> [n]` `place <item> [x y z]` `eat` | make and use |
| `help` `quit` | meta |

Every command prints its `ActionResult`, error code included — the operator sees
exactly what Stage 5's model will see.

`bot quit` in chat and Ctrl-C are both hard stops — neither reconnects.

## Running the probes

Check that `minecraft-data` actually matches the running server (registries,
recipes, and a decode of ~8,000 live blocks against the block-state palette):

```bash
npm run bot:probe
```

Drive every chat command as a second player and assert the replies:

```bash
npm run bot:probe-chat
```

Measure movement health against the running world (~21 m and 0 corrections is
healthy; see [ADR-006](docs/decisions.md#adr-006--bot-movement-misdiagnosed-as-an-upstream-blocker-it-is-terrain)):

```bash
npm run diagnose:movement:live
```

Type-check (there is no build step — see
[ADR-004](docs/decisions.md#adr-004--no-build-step-node-runs-typescript-natively)):

```bash
npm run typecheck
```

## Running tests

```bash
npm test
```

Unit tests via Node's built-in runner — no test framework dependency. They cover
the action contract and harvestability logic, the parts with real logic to
isolate. Everything else is integration by nature and lives in the probes.

The Stage 3 acceptance scenario (gather → craft → place → move → eat):

```bash
npm run scenario:bootstrap
```

It reports per-capability rather than pass/fail overall, and will say
"NOT demonstrated" rather than claiming success when steps were skipped for
world reasons.

## Inspecting telemetry

```bash
npm run telemetry                 # runs, agents, event counts
npm run telemetry timeline 40     # what happened, in order, with locations
npm run telemetry actions         # attempts, success rate, durations
npm run telemetry errors          # failures grouped by error code
npm run telemetry inventory       # state snapshots over time
npm run telemetry sql "SELECT ..."
```

The database lives at `data/database/telemetry.sqlite` (git-ignored) and is
written while the bot runs. WAL means you can query it mid-run without blocking
anything.

## Security posture

The server binds to **`127.0.0.1` only** and runs with `online-mode=false`. Those
two settings are a deliberate pair: authentication is disabled so that many bot
agents can connect without a Minecraft licence each, and that is only acceptable
because the server is unreachable from the network. RCON, query and command
blocks are all disabled.

Read [ADR-002](docs/decisions.md#adr-002--online-modefalse-paired-with-a-loopback-only-bind)
before changing either setting.

No API keys are used or stored. `.env` is git-ignored; `.env.example` documents
the (currently non-secret) configuration.

## What is implemented

- Pinned, checksum-verified Paper server download
- Reproducible server configuration from a tracked template, with a fixed world seed
- Explicit, interactive EULA acceptance — never automatic
- Graceful save-and-stop on Ctrl-C
- Paper update checker that reports but never auto-upgrades
- Environment baseline and architectural decision records
- **Stage 1 verified end-to-end** — boot, human join, graceful save-and-stop
- One bot: connect, reconnect with capped exponential backoff, kill switch
- Pure, bounded, serialisable observations ([ADR-005](docs/decisions.md#adr-005--observations-are-pure-serialisable-and-bounded))
- Allowlisted chat commands with outgoing-chat rate limiting
- Event-shaped structured logging, ready to be pointed at SQLite in Stage 4
- TypeScript with no build step ([ADR-004](docs/decisions.md#adr-004--no-build-step-node-runs-typescript-natively))
- Two probes: `bot:probe` (data correctness) and `bot:probe-chat` (command replies)
- SQLite telemetry: events + snapshots, batched, WAL, with a query CLI
- Nine actions with typed results: move, follow, mine, collect, craft, place, eat, equip, stop
- World-version guard: refuses to open a world built by a different Minecraft

## What is not implemented

| Stage | Feature | Status |
|---|---|---|
| 2 | Mineflayer bot — connect, observe, chat | **done** |
| 3 | Deterministic bot actions — mine, craft, place, move | **done** |
| 4 | Telemetry event bus + SQLite | **done** |
| 5 | Claude decision loop | not started |
| 6 | Agent identity and goals | not started |
| 7 | Persistent agent memory | not started |
| 8 | Multiple agents | not started |
| 9 | Agent-to-agent communication | not started |
| 10–12 | Economy, relationships, settlements | not started |
| 13 | Dashboard | not started |
| 14 | Experiment runner | not started |

## Documentation

- [docs/development.md](docs/development.md) — environment, setup, troubleshooting
- [docs/decisions.md](docs/decisions.md) — architectural decision records
- [docs/architecture.md](docs/architecture.md) — stub until Stage 4
- [docs/experiments.md](docs/experiments.md) — stub until Stage 14
