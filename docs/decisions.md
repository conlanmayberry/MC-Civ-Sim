# Decision Record

Architectural decisions, newest last. Each entry records what was decided, why,
and what would make us revisit it.

---

## ADR-001 — Target Minecraft 1.21.8 (Paper build 60)

**Date:** 2026-09-06, superseding the same-day decision to target 26.1.2
**Status:** accepted

The server is pinned to **Minecraft 1.21.8, Paper build 60**
([minecraft/config/paper-version.json](../minecraft/config/paper-version.json)).

### Why this changed twice in one day

The first version of this ADR chose **26.1.2**, on the reasoning that it was the
newest release supported by both Paper and Mineflayer, and that the brief's
suggested 1.21.11 was end-of-life on Paper. That reasoning was sound but
incomplete: "supported" meant the protocol was modelled, not that the bot could
function.

Stage 3 found the gap. `mineflayer-pathfinder` **wedges** on 26.1.x in normal
terrain — it computes a route, executes part of it, then stops while
`isMoving()` still reports true, so `goto` never settles and the caller hangs.
A controlled benchmark (`npm run diagnose:pathfinder`, four temporary servers,
identical settings):

| version | world | reached | wedged |
|---|---|---|---|
| 26.1.2 | superflat | 3/3 | 0 |
| **26.1.2** | **normal** | **0/3** | **3** |
| 1.21.8 | superflat | 3/3 | 0 |
| **1.21.8** | **normal** | **1/3** | **0** |

That is [mineflayer-pathfinder#366](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/366),
isolated to the version. Full history in [ADR-008](#adr-008--stage-3-was-blocked-by-2612-resolved-by-moving-to-1218).

### The trade, stated plainly

Paper's support for 1.21.8 **ended 2025-11-14**. We are running a server that
will receive no further updates, in exchange for a bot that can actually
navigate. For a local, loopback-only research instrument that is the right way
round — an unsupported server on a machine nothing can reach costs us little,
while a bot that cannot walk costs us every stage from 3 onwards.

### Verified after the change

- Paper 1.21.8-60 boots clean, **0 errors** (26.1.2 left config files a 1.21.8
  server warns about; they are archived, not deleted).
- `npm run bot:probe` — **7/7**, 8,125 live blocks decoded against the `1.21`
  palette with no inconsistencies.
- `npm run bot:probe-path` — **GATE PASSED**, 3/3 with digging allowed, 2/3
  walk-only, **zero wedges**.
- `npm run scenario:bootstrap` — **Stage 3 criterion met**.

### The world could not come along

Minecraft upgrades worlds silently and never downgrades them, so the 26.1.2
`civ-sim-world` cannot be opened by 1.21.8 — attempting it corrupts the world,
and not visibly until much later. It is preserved at
`minecraft/server/civ-sim-world.26.1.2-archived` and a fresh world was
generated.

`scripts/start-server.mjs` now **refuses to start** when the world's recorded
version does not match the pin, and prints the command to move it aside. That
guard exists because losing a world mid-experiment invalidates the experiment,
and the failure is otherwise silent.

### Revisit if

Mineflayer-pathfinder fixes #366, at which point moving to a supported Minecraft
becomes attractive again. `npm run diagnose:pathfinder` is the test that decides
it, and it takes about eight minutes.

## ADR-002 — `online-mode=false` paired with a loopback-only bind

**Date:** 2026-09-06
**Status:** Accepted

### Context

Every Mineflayer bot that joins an online-mode server needs its own
Mojang-authenticated Microsoft account. Stage 8 calls for 3 agents and later
stages for more; buying and managing a Minecraft licence per agent is not a
viable path for a research sandbox.

The standard alternative is `online-mode=false`, which disables Mojang
authentication and lets any client join under any username. On a
network-reachable server that is a serious hole: anyone who can reach the port
can join as any player, including an operator.

### Decision

Set `online-mode=false` **and** `server-ip=127.0.0.1` together, in
`minecraft/config/server.properties.template`.

The loopback bind means the server accepts connections only from processes on
this machine. It is not reachable from the LAN and not reachable from the
internet. That containment is what makes disabling authentication acceptable.

Supporting choices in the same template, all reducing the remote-control surface
available to an autonomous agent:

- `enable-rcon=false`, `enable-query=false` — no additional listening sockets.
- `enable-command-block=false` — agents get Minecraft tools, not admin powers.
- `spawn-protection=0` — otherwise agents' first build/mine actions fail
  silently near spawn, which is very hard to diagnose from telemetry alone.

### Consequences

**These two settings are a pair.** Changing `server-ip` to anything other than
loopback requires reconsidering `online-mode` in the same edit. The template
carries a comment saying so at the point of use.

If the server ever needs to be reachable from another machine, the options are a
whitelist plus online-mode, or a VPN/SSH tunnel — not simply widening the bind.

### Revisit when

The operator wants to watch or join from a second machine.

---

## ADR-003 — AI provider authentication deferred to Stage 5

> **Superseded by [ADR-010](#adr-010--openai-behind-a-provider-seam-with-a-hard-spend-cap).**
> The deferred decision has now been made: OpenAI, via `OPENAI_API_KEY`.

**Date:** 2026-09-06
**Status:** Open — deliberately undecided

No `ANTHROPIC_API_KEY` appears in `.env.example`, and nothing in the project
reads one. Stages 1–4 involve no LLM at all.

The operator has a Claude subscription and uses Claude Code. Whether the running
simulation authenticates via the Claude Agent SDK's subscription-based flow or a
separate API key — and what that costs — is a real decision with billing
consequences, and it will be made at Stage 5 against the SDK documentation as it
stands then, not guessed at now.

Adding the variable early would imply a choice we have not made and risks
unintended API charges.

---

## ADR-004 — No build step: Node runs TypeScript natively

**Date:** 2026-09-06 (Stage 2)
**Status:** accepted

Node 26.4 executes `.ts` files directly by stripping type annotations, with no
flag. `node src/bot/index.ts` is the real entry point; there is no compile step,
no bundler, no `tsx` or `ts-node`, and no `dist/`.

`typescript` is a devDependency used **only** for `tsc --noEmit`. Types are
checked; they are never compiled.

### Why

The alternative is a build pipeline whose only job is to delete type
annotations. For a project whose runtime is a long-lived simulation process,
a watch-and-rebuild loop is friction with no compensating benefit, and a stale
`dist/` is a genuine source of confusion during a multi-hour experiment.

### The constraints this imposes

Both verified by experiment on this machine, not assumed:

| Constraint | Consequence |
|---|---|
| Relative imports need an explicit `.ts` extension | `./config.ts` resolves; `./config.js` and `./config` both throw `ERR_MODULE_NOT_FOUND` |
| Type stripping only *erases* | `enum`, `namespace` and parameter properties throw at runtime — they need code generation |

`satisfies`, `interface`, `type`, generics and `import type` are all fine.

The second constraint is the dangerous one: it fails at runtime, not at parse
time, and only on the line that uses the enum. So `tsconfig.json` sets
**`erasableSyntaxOnly: true`**, which makes the type-checker reject non-erasable
syntax outright. `npm run typecheck` is therefore a real gate, not a formality.

Enums are the notable loss. Use union types of string literals instead — as
`EventType` in [src/util/log.ts](../src/util/log.ts) does. They serialise better
to telemetry anyway.

### Consequence worth noting

A `.mjs` file can import a `.ts` module. That let
[scripts/start-server.mjs](../scripts/start-server.mjs) drop its private copy of
the `.env` reader and import `loadEnvFile` from
[src/config.ts](../src/config.ts) instead. One implementation, no drift.

### Revisit if

We need decorators (some DI frameworks), or we ever ship this as a published
package rather than running it from the repo. Neither is on the roadmap.

---

## ADR-005 — Observations are pure, serialisable and bounded

**Date:** 2026-09-06 (Stage 2)
**Status:** accepted

The functions in [src/bot/observations.ts](../src/bot/observations.ts) —
`observeSelf`, `observeInventory`, `observeEntities`, `observeBlocks` — obey
three rules from their first commit, before anything depends on them.

**1. Pure.** No side effects, no logging, no chat. Given a bot, return a value.

**2. Serialisable.** Plain numbers, strings, arrays and objects only. No `Vec3`,
no `Item`, no `Entity` references leak into the returned object.

**3. Bounded.** Every function takes an explicit radius or limit, and reports
what it sampled and whether it truncated.

### Why now, rather than at Stage 4

These return values have three consumers, and only the first exists yet:

- Stage 2 — chat command replies
- Stage 4 — rows written to SQLite
- Stage 5 — the observation object handed to Claude

Rules 1 and 2 are what make one function serve all three. A `Vec3` cannot be
written to a database column or put in a prompt; a function that logs cannot be
called speculatively. Retrofitting this after Stage 4 would mean touching every
call site and rewriting the telemetry schema.

Rule 3 is a cost control that only bites later. An unbounded `observeBlocks` is
merely slow in Stage 2, a storage problem in Stage 4, and an unaffordable prompt
in Stage 5. The radius parameters are in `.env` because their right values are
an experimental question, not a constant.

### The rule that is easiest to break

These functions read **only what the Mineflayer client knows** — which is what
the bot could actually see. `bot.blockAt()` returning `null` outside loaded
chunks is not a bug to work around; it is the agent genuinely not knowing what
is there.

Nothing here may consult the server's world files, another agent's memory, or
any global registry of world truth. Principles 9-11 of the project brief depend
on it, and this file is where imperfect information is either preserved or
quietly lost. `observeBlocks` tallies **every** non-air block rather than looking
up a list of "interesting" ones for the same reason — a hard-coded interest list
is prior knowledge the agent is supposed to discover (principle 8).

---

## ADR-006 — Bot movement: misdiagnosed as an upstream blocker; it is terrain

**Date:** 2026-09-06 (Stage 2)
**Status:** **resolved** — supersedes this ADR's own first conclusion

### Correction

This ADR originally concluded that mineflayer could not move a player on Paper
26.1.2, that the fault was upstream, and that Stage 3 was gated on someone else
fixing it. **That was wrong**, and the reasoning error is worth recording because
it is easy to repeat: every measurement came from a single spawn point, so
"the bot cannot move" and "the bot cannot move *here*" were indistinguishable in
the data, and the more dramatic reading got written down as fact.

A controlled experiment settled it. `npm run diagnose:movement` runs the same
measurement against vanilla and Paper on freshly generated **superflat** worlds,
holding version, Java, mineflayer and config constant:

| Server | Moved in 5s | Corrections while walking | Physics ticks |
|---|---|---|---|
| Vanilla 26.1.2 | **21.33 m** | **0** | 100 |
| Paper 26.1.2-74 | **21.11 m** | **0** | 99 |

Both walk perfectly. Mineflayer, Paper and Minecraft 26.1.2 are all fine.

### The actual cause

`npm run diagnose:movement:live` reproduces the failure on `civ-sim-world`, and
varying only the bot's footing explains all of it:

| Standing on | Moved in 5s | Corrections |
|---|---|---|
| `spruce_leaves` (canopy, y≈83) | 1.20 m | 71 |
| `grass_block` (forest floor, y≈74) | 6.88 m | 52 |
| flat ground (superflat baseline) | 21.33 m | 0 |

`civ-sim-world`'s spawn sits in a **dense spruce forest, and bots spawn in the
canopy** — standing on leaf blocks, metres above the ground, boxed in by trunks
and foliage. It is close to the worst possible terrain for a naive
"face the target and hold forward" walk, which is exactly what Stage 2's
`bot come` is. The bot walks into a trunk or off a leaf platform, its physics
and the server's diverge, and the server corrects it.

The human operator confirms `bot come` works in practice when the bot is
somewhere it can actually walk.

### Consequence

**Stage 3 is not blocked.** Movement works; naive movement is simply bad at
dense forest, which is the ordinary case for having no pathfinder.
`mineflayer-pathfinder` is Stage 3's first task and is the correct fix — it
computes walkable routes, handles jumps and step-ups, and avoids the divergence
that produces these corrections.

Two smaller consequences:

- Judge Stage 3 movement work on **open ground** as well as at spawn, or terrain
  difficulty will keep masquerading as a bug.
- `npm run diagnose:movement:live` is the standing regression check. Superflat
  gives ~21 m and 0 corrections; anything near that is healthy.

### A real, separate defect found on the way

Independent of the above, `minecraft-data`'s protocol schema for the attribute
packet is **wrong**, identically on 1.21.9, 1.21.11 and 26.1:

- The schema's ID→name mapping has **31 entries**; the real attribute registry
  has **35**.
- Missing from the schema: `mining_efficiency`, `movement_efficiency`,
  `oxygen_bonus`, `sneaking_speed`.
- Everything from index 20 is therefore shifted. Index 22 is `movement_speed`,
  but the schema labels it `generic.scale` — which is why a bot reports a
  nonsensical `generic.scale = 0.1` (0.1 being the vanilla default *movement
  speed*).
- `prismarine-physics` looks up `minecraft:movement_speed`, never finds it, and
  falls back to a built-in default.

This is genuinely worth reporting upstream to PrismarineJS. It is **not** the
cause of anything above: physics degrades gracefully when the attribute is
absent, injecting it by hand changes nothing, and bots walk at full speed on
flat ground regardless. It will start to matter when agents need accurate speed
under status effects, sprinting or soul sand.


---

## ADR-007 — Actions are typed results, never exceptions

**Date:** 2026-09-06 (Stage 3)
**Status:** accepted

Every action returns an `ActionResult` (see
[src/bot/actions/types.ts](../src/bot/actions/types.ts)):

```ts
{ ok, action, durationMs, detail, error?: { code, message } }
```

Enforced centrally by `runAction` in
[src/bot/actions/run.ts](../src/bot/actions/run.ts), so the rules hold by
construction rather than by everyone remembering them:

1. **Never throw.** A failure is a value.
2. **Always time-bounded.** Every action takes a timeout and returns `timeout`.
3. **Serialisable `detail`.** No Vec3/Block/Item/Entity, same rule as ADR-005.
4. **One at a time.** A mutex; concurrent callers get `interrupted`.
5. **One telemetry event per action**, success or failure.

### Why failures are values

Stage 5 hands these to Claude as tool results. A model that receives an
exception sees nothing and its agent loop dies; a model that receives
`{ ok: false, error: { code: 'no_tool' } }` can go and find a pickaxe. The
same object is what Stage 4 writes to SQLite.

### Why the codes are a closed union

`ActionErrorCode` is nine fixed values, not free text, because Stage 4 will
aggregate them ("how often do agents fail as `unreachable`?") and Stage 5 will
branch on them. Neither is possible over message strings. Specifics live in
`message`; the category lives in `code`.

### Consequences already visible

`mine_block` distinguishes `not_found`, `unreachable`, `no_tool` and `blocked`
where a boolean would have said only "failed". The `no_tool` case is the
clearest win: mining stone bare-handed *succeeds* and drops nothing, which
teaches an agent something false about the world. Refusing with a reason is
better than a hollow success.

---

## ADR-008 — Stage 3 was blocked by 26.1.2; resolved by moving to 1.21.8

**Date:** 2026-09-06 (Stage 3)
**Status:** **resolved** — the version was changed; see [ADR-001](#adr-001--target-minecraft-1218-paper-build-60)

Stage 3's action layer was written, type-checked and unit-tested, but its
success criterion could not be demonstrated: pathfinding did not work on 26.1.2
in real terrain. Nothing was wrong with the code in this repository.

### What was measured

Controlled 2x2 benchmark, temporary servers, identical settings:

| version | world | reached | wedged |
|---|---|---|---|
| 26.1.2 | superflat | 3/3 | 0 |
| **26.1.2** | **normal** | **0/3** | **3** |
| 1.21.8 | superflat | 3/3 | 0 |
| **1.21.8** | **normal** | **1/3** | **0** |

Flat ground worked on both, so neither the library nor our integration was
fundamentally broken. On normal terrain 26.1.2 **wedged every time** and 1.21.8
**never** did — mineflayer-pathfinder#366, isolated to the version.

The distinction that mattered was *how* they failed. A wedge hangs forever; a
clean failure returns and can be retried.

### Workarounds tried before changing the version

| Attempt | Outcome |
|---|---|
| Wedge detector — abort on "moving but not moving" | **Kept.** Turns an unrecoverable hang into a typed `unreachable` in ~2.4s. Necessary, not sufficient. |
| Retry with a fresh path plus a jump-and-turn nudge | **Kept.** Still wedged after 4 attempts on 26.1.2; genuinely useful on 1.21.8. |
| Try the 12 nearest candidate blocks, not just the closest | **Kept.** Better in general; all 12 were still unreachable on 26.1.2. |
| [PR #364](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/364) hitbox patch (0.3 → 0.30001) | **Rejected.** It did stop the wedging, supporting its float-boundary diagnosis, but the bot still never arrived -- it burned the full timeout instead, turning a 2.4s clean failure into a 25s one. |

The three kept changes are real improvements and remain in place on 1.21.8.

### Outcome

After moving to 1.21.8, with no further changes to the action layer:

- `npm run bot:probe-path` — **GATE PASSED**, 3/3 default, 2/3 walk-only, zero
  wedges, a 40 m route in 11 s.
- `npm run scenario:bootstrap` — **7 passed, 0 failed**: gathered 4 spruce logs,
  crafted planks, sticks and a crafting table, placed the table, and moved out
  and back. **Stage 3 success criterion met.**

Two bugs of our own surfaced once movement stopped masking them, both in
crafting and both recorded here because they are easy to reintroduce:

1. `bot.craft(recipe, count)` runs the recipe `count` **times**, while
   `bot.recipesFor(id, meta, minResultCount, table)` filters by resulting
   **items**. Conflating them asked for "4 sticks" as four repetitions, needed
   eight planks, found seven, and left mineflayer waiting forever on a slot
   update — surfacing as `Event updateSlot:0 did not fire`. The action now takes
   items and converts using `recipe.result.count`.
2. `bot.craft` resolves before the resulting inventory update necessarily
   arrives, so counting immediately reported a real success as "produced
   nothing". The count is now polled briefly before judging.

---

## ADR-009 — Telemetry uses `node:sqlite`, not `better-sqlite3`

**Date:** 2026-09-06 (Stage 4)
**Status:** accepted

The event store uses **`node:sqlite`**, built into Node 26 and no longer
flagged experimental. Verified working before adopting it: prepared statements,
WAL, transactions, `json_each`, `json_extract`, read-only handles.

The plan had assumed `better-sqlite3` (13.0.3). It is excellent and remains the
better choice on older Node — but it is a **native module**, and that is the
whole argument:

- It compiles on install, so the project stops being installable whenever a
  prebuilt binary lags a Node release. This repository is meant to be
  reproducible on a fresh machine years from now.
- Stage 2 lost hours to a stale-data dependency. Adding a compiled dependency to
  the critical path of the thing that *records the research output* is the worst
  place to accept that risk.
- The telemetry write path is a few prepared statements in a batch. The
  performance difference does not arise.

This keeps the project at **one runtime dependency** — mineflayer, plus
pathfinder from git — with everything infrastructural using the standard
library. Consistent with the no-build-step decision in ADR-004 and the
no-dotenv, no-test-framework choices before it.

### Revisit if

We need to support Node < 22, or we need something `node:sqlite` lacks
(user-defined functions, extensions like FTS5 or sqlite-vec). Stage 7's memory
retrieval is the plausible trigger: if semantic search later wants FTS5 or a
vector extension, that is a real reason to change, and the store is behind a
small interface (`openStore`) precisely so it can be.

### Consequence worth recording

`node:sqlite` refuses to bind `undefined`, and the bot legitimately has
undefined fields at lifecycle edges — mineflayer fires `spawn` from a handler
registered *before* the one that assigns `bot.health`, so health is genuinely
unset at that instant. The store therefore coerces non-finite values to NULL
rather than letting a partial row destroy a whole snapshot, and the spawn
snapshot is taken a second late so it captures real values.


---

## ADR-010 — OpenAI behind a provider seam, with a hard spend cap

**Date:** 2026-09-06 (Stage 5)
**Status:** accepted, superseding [ADR-003](#adr-003--ai-provider-authentication-deferred-to-stage-5)

Agents decide using **OpenAI**, model **`gpt-5.6-luna`**, authenticated with
`OPENAI_API_KEY` from `.env`.

### Why OpenAI, when the brief says Claude

An operator decision. The brief names Claude *and* requires "keep the AI
provider abstraction clean enough that the model can be changed later" — so the
right response was not to argue but to build the seam the brief asks for and put
OpenAI behind it. [src/ai/provider.ts](../src/ai/provider.ts) defines the
interface; [src/ai/openai.ts](../src/ai/openai.ts) is the only file in the
project that imports the SDK. Changing provider means writing one more
implementation of `AiProvider`.

The SDK is `openai` 7.10.0: Node ≥22, **zero dependencies**, which fits the
project's dependency policy better than most of what is already installed.

### Why Luna, and why the model is pinned in code

| model | $/M in | $/M out | ~$/agent-hour, no caching, one decision per 30s |
|---|---|---|---|
| GPT-6 Astra | 10 | 50 | ~3.60 |
| GPT-5.6 Sol | 4 | 20 | ~1.44 |
| GPT-5.6 Terra | 2 | 12 | ~0.77 |
| **GPT-5.6 Luna** | **0.20** | **1.20** | **~0.08** |

A 45x spread. Three agents for eight hours is ~$1.85 on Luna against ~$35 on
Sol, and this is a system designed to run for days.

These are the pre-caching numbers the cap was originally budgeted against,
worst case. Two things move the real figure since: the default interval is now
15s (half of what this table assumes, so roughly double the decision rate),
and OpenAI's prompt caching discounts the repeated system prompt and
observation structure -- measured live at ~1,400 of ~2,200 input tokens per
decision cached. Net effect, measured from a real run rather than estimated:
**~$0.06/agent-hour on Luna**, comfortably under the pre-caching estimate
despite twice the decisions -- gotten via `npm run telemetry sql` summing
`json_extract(data,'$.costUsd')` over `decision` events for a run.

The model lives in [src/ai/pricing.ts](../src/ai/pricing.ts), not `.env`,
**because the spend cap depends on knowing its price**. A model set by
environment variable could be one the price table has never heard of, and the
cap would then be enforcing a number it cannot compute. Changing model is a
deliberate edit that adds real prices alongside it.

### The safety rails are the point, not a formality

An agent loop is a program that spends money in a `while` loop. Everything in
[src/ai/budget.ts](../src/ai/budget.ts) **fails closed**:

- **Spend cap** (default $5) from real reported token usage, warning at
  50/75/90%, stopping at 100%.
- **An unpriced model throws** rather than costing zero. A silent zero reads as
  "free" and spends without limit — the worst possible failure mode, and the one
  a naive implementation lands on.
- **Rate limits** on requests/min and decisions/min, so event triggers cannot
  storm the API. A rate limit makes the agent *wait*; only a cap or a duration
  ceiling *stops* it.
- **Three kill switches**: `agent stop` in chat, Ctrl-C, and a `STOP` file
  polled every two seconds. The file exists because the terminal is not always
  to hand, and it is what a dashboard button will use.
- **Cost is disclosed before the first call** — model, prices, cap and interval
  are printed at startup, every time.

Cached input is billed separately and `input_tokens` *includes* the cached
portion, so the cost calculation subtracts it. Charging the full rate on the
whole amount would drift high and trip the cap early.

### The tool surface is the security boundary

The model gets exactly the nine actions from Stage 3, plus `send_chat`
([src/ai/tools.ts](../src/ai/tools.ts)). There is no tool that runs code, reads
a file, spawns a process or reaches the host. That is principle 16 of the brief,
enforced by construction rather than by instruction, and it is what makes the
next point acceptable.

**Player chat reaches an agent's observations**, so a person can try to talk an
agent into something. That is safe because the tool surface is closed — the
worst outcome is a bot playing Minecraft badly in a world we can delete — and it
is a legitimate object of study rather than a hole to plug: Stage 9 is explicitly
about misinformation between agents.

### A note on strict mode

OpenAI's `strict: true` requires `additionalProperties: false` **and every
property listed in `required`**. Our actions have genuinely optional arguments,
so those are declared nullable (`['integer','null']`) and `null` is translated
to "use the default" by the dispatcher. A unit test asserts every schema
satisfies this, because the alternative is discovering it as a runtime API
rejection during a paid run.

### Testing something that costs money

`createStubProvider` returns scripted decisions at zero cost, and
`npm run agent -- --dry-run` runs the entire observe/decide/act/record loop
against the live Minecraft server with it. That is not a lesser mode — it is how
the loop is verified before an API key is ever used, and it is why the agent
loop is testable in CI at all.

---

## ADR-011 — Agents remember places, and Mindcraft is a reference rather than a dependency

**Date:** 2026-09-07 (Stage 5)
**Status:** accepted

Agents can record named locations. Places belong to one agent, persist in the
telemetry database across restarts, and are shown in every observation with
their distance and direction.

### The failure this answers

Traced from one run. Alice built a shelter at `1419,71,-170`, drifted twenty
blocks over five turns, and went on placing torches "at the shelter's edge"
from wherever she was standing — eventually reporting she was finishing *our*
shelter from two hundred blocks away.

She was not confused about what a shelter is. Nothing in the system had ever
recorded where hers was. An observation says where an agent is **now**
([ADR-005](#adr-005--observations-are-pure-serialisable-and-bounded)) and
history is six turns of prose, so a phrase like "our shelter" had no
coordinates behind it and silently re-anchored to her own position.

That is a memory defect, not a knowledge defect, which is why loading a
Minecraft wiki or a note vault would not have touched it. No external corpus
knows where *her* shelter is.

### Design

A name, a position, a dimension, a short note — deliberately the smallest thing
that fixes it. [src/agent/places.ts](../src/agent/places.ts).

- **Explicit, via a `remember_place` tool**, plus one automatic case: where the
  agent died. Automatically inferring "this cluster of placed blocks is a
  shelter" was considered and rejected — it guesses at intent, and an agent that
  cannot say what it built has not really recorded anything.
- **Bounded at 12.** Every place is in every prompt from then on. The
  least-recently-recorded is dropped, on the reasoning that a place still worth
  keeping gets re-recorded when it is visited again.
- **Rendered with distance and direction**, not just coordinates. "shelter —
  1419,71,-170, 217m northeast" tells an agent that whatever it is standing in,
  it is not the shelter. A bare coordinate does not.
- **Never shared between agents.** Keyed by `agent_id`, never joined across
  agents. One agent learning where another's shelter is has to happen by being
  told, in chat — which is the exact channel Stage 9 studies. Sharing the table
  would quietly turn a misinformation experiment into a database read.
- **Additive schema.** `SCHEMA_VERSION` stays 1: the `places` table is appended
  with `CREATE TABLE IF NOT EXISTS`, so an existing database keeps opening, as
  [schema.ts](../src/telemetry/schema.ts) always intended.

### Why not adopt Mindcraft

[Mindcraft](https://github.com/mindcraft-bots/mindcraft) is the closest existing
project — LLM agents on Mineflayer — and its `MemoryBank` is twenty lines doing
exactly this, which is good evidence the small version is enough. It stays a
reference and not a dependency:

- It is a **whole agent runtime**, not a library: its own loop, mindserver,
  express, socket.io, prismarine-viewer, canvas/WebGL, thirty-odd dependencies.
  Adopting it means replacing this stack, and with it the telemetry, the action
  contract ([ADR-007](#adr-007--every-action-returns-a-typed-result-and-never-throws))
  and the closed tool surface.
- It pins `mineflayer-pathfinder ^2.4.5` — the stale npm release whose wedging
  on 1.21 is why this project tracks git master.
- Code generation and execution (`allow_insecure_coding`) is central to that
  family of designs, including Voyager's skill library. Principle 16 excludes it
  here on purpose.
- Different aim. Mindcraft is about capable bots; this is an instrument for
  observing behaviour, so a scientific record is the deliverable rather than a
  means.

The idea worth borrowing is theirs, and it is borrowed. The runtime is not.
