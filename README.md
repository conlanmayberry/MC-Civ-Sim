# MC-Civ-Sim

An artificial-society laboratory built on Minecraft.

The long-term goal is a persistent Minecraft world inhabited by autonomous AI
agents that survive, communicate, cooperate, compete, form relationships, build
settlements and develop economies — with structured telemetry good enough to
analyse the resulting society scientifically.

It is built in strictly sequenced stages. Each stage must produce a working,
testable system before the next begins.

---

## Current stage: **Stage 2 — bot connects and observes ⚠️**

One Mineflayer bot that connects, observes the world, and answers chat commands.
No AI yet — that is Stage 5.

Working and verified: connection with bounded reconnect, chat commands,
observations (position, health, inventory, entities, blocks), structured event
logging, and two probes (7/7 data checks, 8/8 chat cases).

⚠️ **The bot cannot walk.** The server rejects mineflayer's movement packets and
teleports it back ~17×/second. The bot is behaving correctly at the protocol
level; this is an upstream problem, fully measured in
[ADR-006](docs/decisions.md#adr-006--bot-movement-is-blocked-upstream-stage-3-gated-on-it).
**Stage 3 is gated on it**, since Stage 3 is entirely about actions.

**There is no AI and no telemetry database yet.** See
[What is not implemented](#what-is-not-implemented).

| Target | Version | Why |
|---|---|---|
| Minecraft | 26.1.2 | newest release supported by *both* Paper and Mineflayer |
| Paper | build 74 | pinned + SHA-256 verified |
| Java | 25 | Paper 26.1.2 minimum |
| Node.js | ≥22 | Mineflayer 4.39 requirement |

The version choice differs from the original project brief, which specified
1.21.11. That version is now end-of-life on Paper. Full reasoning, with sources:
[ADR-001](docs/decisions.md#adr-001--target-minecraft-2612-paper-build-74-not-12111).

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
25.x. In the Minecraft launcher, create a **26.1.2** profile.

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

Say `bot help` in Minecraft chat. Commands: `status`, `inventory` (`inv`),
`look`, `who`, `come`, `stop`, `quit`, `help`.

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

Type-check (there is no build step — see
[ADR-004](docs/decisions.md#adr-004--no-build-step-node-runs-typescript-natively)):

```bash
npm run typecheck
```

## Running tests

No unit-test suite yet — the two probes above are connected diagnostics, which
is the right shape for a project whose failure modes are all integration-level.
Unit tests arrive in Stage 3 with the first logic worth isolating.

## Inspecting telemetry

Not implemented — Stage 4. There is no database yet.

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

## What is not implemented

| Stage | Feature | Status |
|---|---|---|
| 2 | Mineflayer bot — connect, observe, chat | **done, except movement** |
| 3 | Deterministic bot actions — mine, craft, place, move | **blocked by [ADR-006](docs/decisions.md#adr-006--bot-movement-is-blocked-upstream-stage-3-gated-on-it)** |
| 4 | Telemetry event bus + SQLite | not started |
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
