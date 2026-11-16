# MC-Civ-Sim

**A lab for AI societies, built in Minecraft.** Autonomous agents powered by large language models live in a persistent Minecraft world. Each one can see what's around it, decide what to do next, talk to the others and to human players, and survive on its own. Everything they do is recorded to a database, so you can study how they behave afterward.

> Built solo in TypeScript on Node 22. It has 60 source modules, 28 test files and a written log of design decisions (ADRs) explaining every major trade-off.

## Highlights

- **LLM agents with names and roles.** Alice, Bob, Carla and Dmitri each have their own personality, memory of places, standing orders and a "voice" for in-game chat. The model picks from 21 typed tools (mine, craft, smelt, farm, fish, trade items, fight, remember places, chat, and more), and the actions run deterministically under the hood.
- **Safety and cost controls.** A hard spend cap on API usage, rate limiting, three separate kill switches, and a `--dry-run` mode that runs the whole decision loop for $0.
- **A real telemetry system.** Every action, chat message, injury and death is stored as an event in SQLite. Periodic state snapshots give a ground truth to check the events against. There are command-line tools to query the data, a "doctor" health check and run reports.
- **A live dashboard.** A web view of each agent's position, inventory, personality and decision stream, plus a way to inject a thought into an agent mid-run.
- **Replays and scenario tests.** Past runs can be replayed and compared. Scripted scenarios run agents through repeatable challenges on a sealed, resettable test platform, so a behavior change can be tested without playing for an hour.
- **Debugging driven by evidence.** Diagnostic scripts showed that pathfinding failed on Minecraft 26.1.x (0 of 3 trips reached their goal) and worked on 1.21.8. The server version is pinned on that basis and the reasoning is written up in an ADR.

## Tech stack

| Area | Tools |
|---|---|
| Language/runtime | TypeScript, Node.js 22 (built-in `node:sqlite` and `node:test`) |
| Game interface | Mineflayer, mineflayer-pathfinder, Paper server (SHA-256 verified) |
| AI | OpenAI API behind a swappable provider interface, tool calling, token and cost tracking |
| Data | SQLite event log and snapshots, JSON replays |
| Ops | RCON scenario control, Windows launch scripts, a loopback-only server for security |

## Architecture at a glance

```
LLM agent (decide) ─▶ typed tools ─▶ action layer (typed results, never throws)
        ▲                                   │
   observations ◀── Mineflayer bot ◀── Paper Minecraft server
                                            │
                     structured logger ─▶ console + SQLite telemetry ─▶ dashboard / replay / reports
```

Each layer knows nothing about the one above it. That's why adding telemetry only meant swapping where the logs go, and adding AI meant putting a decision-maker on top of the action layer without rewriting anything below it. See [docs/architecture.md](docs/architecture.md) and [docs/decisions.md](docs/decisions.md).

---


An artificial-society laboratory built on Minecraft.

The long-term goal is a persistent Minecraft world inhabited by autonomous AI
agents that survive, communicate, cooperate, compete, form relationships, build
settlements and develop economies — with structured telemetry good enough to
analyse the resulting society scientifically.

It is built in strictly sequenced stages. Each stage must produce a working,
testable system before the next begins.

---

## Current stage: **Stage 5 — autonomous agents ✅**

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

Agents now decide for themselves using **OpenAI GPT-5.6 Luna**, behind a
provider seam so the model can be changed
([ADR-010](docs/decisions.md#adr-010--openai-behind-a-provider-seam-with-a-hard-spend-cap)).

⚠️ **Running the agent spends real money** — every decision is a paid API call.
There is a hard spend cap (default $5), rate limits, and three kill switches.
`npm run agent -- --dry-run` exercises the entire loop for **$0.00**.

**Next: the dashboard** — live map, agent inventory, personality, decision
stream and thought injection.

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

**On Windows, just double-click:**

| file | does |
|---|---|
| `setup-server.bat` | one-time: downloads and verifies the Paper jar, writes the config, asks you to accept the EULA |
| `start-server.bat` | starts the server; the window stays interactive for `list` / `save-all` / `stop` |
| `start-bot.bat` | starts the scripted bot (no AI) |
| `dry-run-agent.bat` | runs the agent loop with no API calls — **free** |
| `start-agent.bat` | runs the default agent (Alice) for real — **spends money** |
| `start-alice.bat` / `start-bob.bat` / `start-carla.bat` / `start-dmitri.bat` | run one specific agent — **spends money** |
| `start-all-agents.bat` | run all four at once, each in its own window — **spends money, ×4** |
| `talk-to-agent.bat` | chat with the default agent from a terminal; pass a port (`talk-to-agent.bat 25581`) to reach another |
| `talk-alice.bat` / `talk-bob.bat` / `talk-carla.bat` / `talk-dmitri.bat` | chat with one specific agent |
| `dashboard.bat` | open the web dashboard |
| `response-times.bat` | how long the agent takes to answer; pass `all` to compare runs |
| `doctor.bat` | check the latest session for every known failure pattern — **free** |
| `scenarios.bat` | repeatable tests on a test arena; `--live` for agent tests — **free / a few cents** |
| `replay.bat` | re-run recorded decisions under the current prompt or another model — dry run unless `--go` |

`npm run telemetry compare` puts the agents side by side — turns, think time,
action success rate, blocks placed, messages sent, deaths, spend per hour —
which is how you tell whether a model upgrade on one agent actually bought
anything. `placed` is a proxy for building: the database cannot see whether a
structure was finished or whether it looks like anything, so read it next to
the world rather than instead of it.

They change to the project directory themselves and install dependencies on
first run, so they work from anywhere.

## Testing changes without playing for an hour

Most problems in this project used to be found the slow way: run the agents for
an hour, then dig through telemetry by hand until the pattern showed. Four
tools replace that loop. See
[ADR-012](docs/decisions.md#adr-012--a-reliability-harness-before-more-features).

**Every run records what it was.** Each agent writes down, at startup, the git
commit it is running, any uncommitted files, its full configuration and its
exact system prompt. A comparison between two sessions is then between known
quantities, and the startup banner warns when a run is not reproducible from a
commit.

**`npm run doctor`** checks a session for every failure pattern that has
actually happened: the same failure repeated dozens of times, actions that
mostly fail, a success rate that dropped since last session, handovers never
picked up, starvation, standing still outside a standing order, more talking
than doing, agents running different code, one spot where movement keeps
failing, the surfacing reflex struggling, and deaths to mobs without a fight.
Deaths are listed by cause, from the server's own death messages. It prints automatically when
each agent stops, and the dashboard shows it under Actions.

**`npm run replay`** takes real situations from a past session and puts them to
the *current* prompt, or another model, then reports how the decisions changed
-- including a tool-by-tool shift like `send_chat 140 -> 60`. No server needed.
It tests decisions, never execution, and has a free `--dry-run` estimate and a
hard spend cap. Situations are recorded from this version onward, so older
sessions cannot be replayed.

```bash
npm run replay -- --dry-run
```

```bash
npm run replay -- --model gpt-5.6-terra --prompt recorded
```

**`npm run scenarios`** runs small repeatable tests against the real server on a
glass arena at x=25000, z=25000 -- far from anywhere agents go, and removable
with `--cleanup`. The free ones drive actions directly (handovers, getting round
a wall, following a moving player, building, mining, crafting, eating); `--live`
adds full-agent tests for a few cents. Results are kept, so something that
passed before and fails now is reported as a regression. They need RCON, which
is loopback-only here -- enable it once, then restart the server:

```bash
npm run minecraft:enable-rcon
```

Replay catches decision regressions and scenarios catch execution bugs; neither
replaces the other. On its first run the scenario harness found a bug nothing
else had: crafting at a table was silently rejected by the server most of the
time, which is the likely source of `craft_item`'s 49% success rate.

## Roles, and which model an agent thinks with

Each `config/agents/*.json` may set two things beyond personality:

```jsonc
{
  "role": "builder -- build and finish the group's structures ...",
  "model": "gpt-5.6-terra"   // omit for the project default (Luna)
}
```

**`role` is a directive, and it is the one part of an identity that is.**
Everything else -- traits, interests, values -- is phrased as disposition on
purpose, because the brief is about behaviour that emerges. Assigning roles
changes what a run is evidence for: it is no longer evidence about whether
division of labour emerges, but about what a group does once it already has
one. Both are worth running. The role is recorded on the `agent_started`
event so analysis can tell the two kinds of run apart, and an agent with no
role keeps the original emergent framing exactly.

The four shipped agents are assigned: Alice farms, Bob builds, Carla mines,
Dmitri explores -- each matched to the personality it already had.

**`model` is per-agent** so a stronger model can be trialled on one agent
against the others on the cheap one, which is the only way to tell "the model
is not good enough" from "the prompt is not good enough" without changing
everything at once. It is priced from the same table the budget cap uses, so
an unknown model fails at startup rather than silently costing an unknown
amount.

## Running several agents at once

Four identities ship in `config/agents/`: Alice, Bob, Carla and Dmitri, each
with different traits and values on purpose — the brief is about behaviour
that emerges, and four copies of the same personality would not show much of
that. Each has its own `start-<name>.bat`, pinned to its own control port
(25580–25583) so the dashboard, `talk-to-agent.bat` and the telemetry can tell
them apart. `agent_id` is on every row already (Stage 4), so nothing about
querying or reviewing a run changes with more than one agent in it.

**Cost is per agent, not shared.** Each has its own `AI_BUDGET_USD` cap
(default $5), so four running to their caps is up to $20, not $5 — see
`start-all-agents.bat`'s own comments for how to lower that.

**The `STOP` file stops every agent**, since it is one file shared by the
whole project — that is the "something is wrong, halt everything" switch. To
stop one agent, close its window, Ctrl-C it, or use `/stop` from
`npm run talk -- --port <its port>`.

To add a fifth: copy `config/agents/alice.json`, give it a new `id` and
`username`, then copy a `start-<name>.bat` with an unused
`AGENT_CONTROL_PORT` (25584 and up — `dashboard.bat` already scans eight
ports past 25580, so no dashboard change is needed for a fifth or sixth).

The equivalent npm scripts, if you prefer a terminal:

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

## Running an agent

⚠️ **This spends money.** Try the free dry run first — it runs the complete
observe → decide → act → record loop against the live server with scripted
decisions instead of a model:

```bash
npm run agent -- --dry-run
```

Then, with `OPENAI_API_KEY` set in `.env`:

```bash
npm run agent
```

Cost, model, budget and interval are printed before the first call. Useful
overrides:

```bash
npm run agent -- --budget 1 --interval 60
```

**Stopping it** — any of three, because an autonomous process that spends money
needs more than one:

| how | when to use |
|---|---|
| `agent stop` in Minecraft chat | you are in the game |
| Ctrl-C | you are at the terminal |
| create a file named `STOP` | neither of the above; also what the dashboard will use |

## What an agent remembers

An observation says where an agent is **now**, never where it has been. Without
somewhere to write things down, "our shelter" has no coordinates behind it and
quietly re-anchors to wherever the agent is standing -- which is how one came to
report it was finishing a shelter from two hundred blocks away.

So agents can record named places: a shelter, a cave mouth, a village, where
they died. Each one is shown back to them every turn with its distance and
direction (`shelter -- 1419,71,-170, 217m northeast`), persists across restarts,
and belongs to that agent alone -- one agent learns where another's shelter is
by being told, in chat, like anything else.

They appear on the dashboard map as labelled markers. See
[ADR-011](docs/decisions.md#adr-011--agents-remember-places-and-mindcraft-is-a-reference-rather-than-a-dependency).

## Talking to an agent

Agents hear what is said near them, know when a message names them, and can
reply with `send_chat`.

**From Minecraft** — just talk. Anything a person says reaches every agent
immediately, however it is phrased: they can tell people from agents (from
`config/agents/`), and a person is the operator rather than another
participant. Agents talking among themselves need a name or an explicit
"everyone" to interrupt each other, which is what keeps four agents from
waking each other in a loop.

### Standing orders — making them obey until released

Ordinary chat competes with whatever the agent had in mind, and `agent tell`
lands once and is gone. Neither survives the agent deciding two turns later
that its own goal is more interesting. A standing order does:

| say in chat | effect |
|---|---|
| `agent obey come to me and stay put` | pinned at the top of every prompt, outranking the agent's goal, until lifted |
| `agent release` | lifts it — back to its own judgement |
| `agent orders` | what it is currently under, if anything |

Staying alive is deliberately exempt: an agent that stands still while
starving because it was told to stay put is obeying an instruction the
operator did not mean.

Orders are recorded in telemetry when given and when lifted, and every
decision made under one is tagged. A run where the operator silently steered
the agents is not a record of emergent behaviour, so analysis has to be able
to carve out the stretch where they were not deciding for themselves.

**From a terminal** — no need to launch the game:

```bash
npm run talk
```

or `talk-to-agent.bat`. Inside that prompt:

| | |
|---|---|
| *anything* | the agent hears it as speech and may reply |
| `/tell <x>` | an operator **instruction**, not conversation |
| `/state` | decisions made, spend so far |
| `/stop` | halt the agent |
| `/quit` | leave the prompt; the agent keeps running |

One message without the prompt:

```bash
npm run talk -- "Alice, what are you doing?"
```

**Say and tell are deliberately different.** *Say* is conversation — the agent
may reply or ignore it. *Tell* is a directive, weighted as one and recorded in
telemetry as an intervention. A run where the operator issued orders is not the
same experiment as one where they chatted, so the log has to distinguish them.

In-game, `agent tell <x>` still works as the directive form, and `agent status`
reports progress.

## Starting the scripted bot

The Stage 2/3 bot, with no AI — useful for testing actions directly. With the
server already running in another terminal:

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

## Dashboard

```bash
npm run dashboard
```

Then open **http://127.0.0.1:25590** (or double-click `dashboard.bat`, which
opens the browser for you).

| panel | shows |
|---|---|
| **Who** | name, description, traits, interests, values; health, food, position, spend against budget |
| **Map** | top-down surface view built from what the agent can see, with its facing, where it has been, and blocks it mined or placed |
| **Inventory** | every stack it is carrying, and nearby entities |
| **Talk** | the whole conversation — what was said to it, what it said back, and operator instructions in gold |
| **Decisions** | each decision with its trigger, one-line reason, tools called and cost |
| **Actions** | success rate and average duration per action |

Agents appear as tabs across the top; a green dot means live. Agents that have
run before but are stopped are still selectable, so you can read the history of
a finished run.

It works with no agent running — live panels go quiet, history still loads.

**The map is what the agent can see, not the truth.** Unloaded chunks are blank
rather than filled in from the server, which keeps the imperfect-information
property the experiment depends on ([ADR-005](docs/decisions.md#adr-005--observations-are-pure-serialisable-and-bounded)).

## Inspecting telemetry

```bash
npm run telemetry                 # runs, agents, event counts
npm run telemetry timeline 40     # what happened, in order, with locations
npm run telemetry actions         # attempts, success rate, durations
npm run telemetry errors          # failures grouped by error code
npm run telemetry inventory       # state snapshots over time
npm run telemetry latency         # how long it takes to answer somebody
npm run telemetry latency all     # ... per run, so a change shows as a change
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
- Autonomous agents on OpenAI, with identity and personality
- Spend cap, rate limits and three kill switches — all fail closed
- Thought injection, recorded as an operator intervention

## What is not implemented

| Stage | Feature | Status |
|---|---|---|
| 2 | Mineflayer bot — connect, observe, chat | **done** |
| 3 | Deterministic bot actions — mine, craft, place, move | **done** |
| 4 | Telemetry event bus + SQLite | **done** |
| 5 | AI decision loop (OpenAI) | **done** |
| 6 | Agent identity and goals | identity + personality **done**; goals not started |
| 7 | Persistent agent memory | not started |
| 8 | Multiple agents | not started |
| 9 | Agent-to-agent communication | not started |
| 10–12 | Economy, relationships, settlements | not started |
| 13 | Dashboard | **next** |
| 14 | Experiment runner | not started |

## Documentation

- [docs/development.md](docs/development.md) — environment, setup, troubleshooting
- [docs/decisions.md](docs/decisions.md) — architectural decision records
- [docs/architecture.md](docs/architecture.md) — stub until Stage 4
- [docs/experiments.md](docs/experiments.md) — stub until Stage 14
