# Decision Record

Architectural decisions, newest last. Each entry records what was decided, why,
and what would make us revisit it.

---

## ADR-001 — Target Minecraft 26.1.2 (Paper build 74), not 1.21.11

**Date:** 2026-09-06
**Status:** Accepted
**Supersedes:** the version guidance in the original project brief

### Context

The project brief specified Minecraft 1.21.11, on the stated grounds that
"Mineflayer currently documents support through 1.21.11". That premise no longer
holds — Mojang has moved to calendar versioning, and both Mineflayer and Paper
have moved with it.

Verified from primary sources on 2026-09-06:

| Fact | Source |
|---|---|
| Mineflayer 4.39.0 (published 2026-09-06) `testedVersions` ends at `26.1`; requires Node ≥22 | [`mineflayer/lib/version.js`](https://github.com/PrismarineJS/mineflayer/blob/master/lib/version.js) |
| `minecraft-data` has a data path for `26.1` but **not** `26.2` | [`minecraft-data/data/dataPaths.json`](https://github.com/PrismarineJS/minecraft-data/blob/master/data/dataPaths.json) |
| Latest Mojang release is `26.2` | Mojang `version_manifest_v2.json` |
| Paper **1.21.11 is UNSUPPORTED** — support ended 2026-06-15, last build #132 (2026-05-11) | `fill.papermc.io/v3` |
| Paper **26.1.2 is SUPPORTED** — build #74 (2026-07-06), Java minimum 25 | `fill.papermc.io/v3` |
| MC `26.1`, `26.1.1` and `26.1.2` all share **protocol 775** (`majorVersion: 26.1`) | `minecraft-data/protocolVersions.json` |

This is a squeeze from both directions: 26.2 is too new for Mineflayer (no
`minecraft-data` entry), and 1.21.11 is too old for Paper (end-of-life). Exactly
one release line satisfies both.

### Decision

Target **Minecraft 26.1.2**, Paper build **74**, JDK **25**.

The build is pinned with its SHA-256 in `minecraft/config/paper-version.json`.
`npm run minecraft:setup` verifies the checksum on every run and refuses to
write a mismatched file. Upgrades are a deliberate edit to that file;
`npm run minecraft:check-latest` reports available updates but never applies
them, so a given commit always reproduces the same server binary.

### Known risk

Mineflayer's test matrix contains `26.1` (dataVersion 4786); we will run 26.1.2
(dataVersion 4790). The protocol number is identical, so the handshake and
packet layer are fine, but registry/recipe data could have drifted slightly
between the two point releases.

**This is unverified until Stage 2 exercises it.** Stage 2's acceptance work must
specifically confirm that block, item and recipe lookups behave, not just that
the bot connects.

**Fallback if it bites:** drop the server to plain `26.1`, which Paper still
publishes. That is a one-line change to the pin file plus a re-run of setup — no
application code is affected.

### Revisit when

- `minecraft-data` gains a `26.2` data path *and* Mineflayer adds `26.2` to
  `testedVersions` — then a considered upgrade becomes possible.
- Paper marks 26.1.2 UNSUPPORTED.
- Stage 2 uncovers a real 26.1 ↔ 26.1.2 data incompatibility.

Do not upgrade merely because a newer Minecraft release exists. Paper supporting
a version is *not* sufficient; Mineflayer and `minecraft-data` gate the decision.

---

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

## ADR-008 — Stage 3 is code-complete but cannot be demonstrated on 26.1.2

**Date:** 2026-09-06 (Stage 3)
**Status:** **open decision for the operator**

The Stage 3 action layer is written, type-checked and unit-tested (15/15). The
brief's success criterion -- gather wood, craft, place, move, eat -- **cannot be
demonstrated on our 26.1.2 world**, because pathfinding does not work in real
terrain. This is not a code defect in this repository.

### Evidence

Controlled 2x2 benchmark (`npm run diagnose:pathfinder`), temporary servers,
identical settings, three `goto` attempts at ~15m:

| version | world | reached | wedged |
|---|---|---|---|
| 26.1.2 | superflat | 3/3 | 0 |
| **26.1.2** | **normal** | **0/3** | **3** |
| 1.21.8 | superflat | 3/3 | 0 |
| **1.21.8** | **normal** | **1/3** | **0** |

Pathfinding works fine on flat ground on both versions, so neither the library
nor our integration is fundamentally broken. On normal terrain, 26.1.2 **wedges
every time** and 1.21.8 **never** does. That is
[mineflayer-pathfinder#366](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/366)
("stuck behind every 1-block obstacle, walking into it instead of jumping",
1.21.10/1.21.11/26.2 broken, 1.21.8 working), isolated to the version.

The distinction that matters is *how* they fail. A wedge hangs forever;
`goto` never settles. A clean failure returns and can be retried -- so on
1.21.8 our retry logic compounds a 1/3 per-attempt rate into roughly 80% over
four attempts, while on 26.1.2 retries measurably do not help.

### Workarounds tried, and why each was insufficient

| Attempt | Result |
|---|---|
| Wedge detector (abort on "moving but not moving") | **Kept.** Converts an unrecoverable hang into a typed `unreachable` in ~2.4s. Necessary, not sufficient. |
| Retry with a fresh path, plus a jump-and-turn nudge | Kept. Still wedged after 4 attempts. |
| Try the 12 nearest candidate blocks, not just the closest | Kept -- better in general. All 12 logs still unreachable. |
| [PR #364](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/364) hitbox patch (`playerHalfWidth` 0.3 → 0.30001) | **Not adopted.** It does stop the wedging, which supports its float-boundary diagnosis, but the bot still never arrives -- it now burns the full timeout making partial progress. Against our wedge detector that trades a 2.4s clean failure for a 25s one. |

The first three are genuine improvements and are kept regardless of what is
decided below.

### The decision

Stage 4 (telemetry) does **not** depend on movement and could proceed now.
Stage 3 cannot be signed off until one of:

1. **Move to Minecraft 1.21.8.** New pin, regenerated world, re-verify Stages
   1-2, revise ADR-001. Paper 1.21.8 is EOL (support ended 2025-11-14), so this
   trades a supported server for a functional bot.
2. **Wait for upstream.** #366 is open with no replies since July; #364 is an
   unmerged fix whose author also renamed the package in the same PR.
3. **Accept degraded movement on 26.1.2** and design Stage 5 agents to operate
   locally, treating `unreachable` as normal. Viable but it constrains every
   later stage that assumes agents can travel.

Recorded rather than chosen: it costs the operator a world.
