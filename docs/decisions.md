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

## ADR-006 — Bot movement is blocked upstream; Stage 3 gated on it

**Date:** 2026-09-06 (Stage 2)
**Status:** **open problem** — recorded, not resolved

A Mineflayer bot cannot walk on our Paper 26.1.2 server. Everything else in
Stage 2 works. This blocks the "can move" item in Stage 2 and all of Stage 3.

### What was measured

The bot is behaving correctly; the server refuses its movement.

| Measurement | Result |
|---|---|
| `physicsTick` events over 5s | **100** — exactly the expected 20/s |
| Packets sent while walking (5s) | `position_look` ×125, `teleport_confirm` ×63, `flying` ×62 |
| `player_loaded` sent | yes |
| Server position corrections — **idle** | **0** |
| Server position corrections — **walking** | **85 in 5s** (~17/s) |
| Correction contents | absolute, incrementing `teleportId`, all relative-flags false |
| Net movement | ~0.004 blocks/tick, snapped back each time |
| Server log warnings | none — no "moved wrongly", no "moved too quickly" |

Idle = 0 corrections and walking = 85 is the decisive pair. The connection is
healthy, the bot is fully loaded, and the server is content until the bot tries
to move. A **human player moves normally on this same server**, so the server is
not at fault either.

### What it is not

Ruled out by experiment, so nobody re-treads this:

- **Not our code.** A bare `mineflayer.createBot` with `setControlState('forward', true)`
  and no project code reproduces it exactly.
- **Not `player_loaded`.** `supportFeature('sendsPlayerLoadedPacket')` is true for
  26.1 and the packet is sent.
- **Not the block palette.** `npm run bot:probe` decodes 8,125 live blocks with
  zero inconsistencies.
- **Not terrain.** Reproduced on flat `grass_block` as well as in tree canopy.
- **Not physics stalling.** Physics ticks at the correct rate.
- **Not the attribute defect below.** Injecting the missing attribute by hand
  changes nothing.
- **Probably not fixed by downgrading.** The serverbound *and* clientbound
  movement packet schemas are byte-identical across 1.21.8, 1.21.9, 1.21.11 and
  26.1, so 26.1 is unlikely to be special here.

### A second, independent defect found on the way

`minecraft-data`'s protocol schema for the attribute packet is **wrong**, and
identically so on 1.21.9, 1.21.11 and 26.1:

- The schema's ID→name mapping has **31 entries**; the real attribute registry
  has **35**.
- Four attributes are missing from the schema: `mining_efficiency`,
  `movement_efficiency`, `oxygen_bonus`, `sneaking_speed`.
- Everything from index 20 is therefore shifted. Index 22 is `movement_speed`,
  but the schema labels it `generic.scale` — which is why the bot reports a
  nonsensical `generic.scale = 0.1` (0.1 being the vanilla default *movement
  speed*).
- `prismarine-physics` looks up `minecraft:movement_speed` and never finds it,
  falling back to a built-in default.

This is a genuine bug worth reporting upstream, but it is **not** the cause of
the movement failure — physics degrades gracefully when the attribute is absent,
and injecting it by hand does not restore movement.

### Consequence

Stage 2 ships with everything except reliable movement. `bot come` is
implemented and correct; it detects that it is not moving and says so within
~3 seconds rather than failing silently.

**Stage 3 must not start until this is resolved** — it is entirely about
actions (mine, craft, place, move), and a bot that cannot move cannot do them.

### Next steps, in order of cost

1. Report both defects upstream to PrismarineJS with the measurements above.
2. Test against a **vanilla** Minecraft server rather than Paper, to establish
   whether Paper's movement validation is involved.
3. Test an older Minecraft version end to end (1.21.8 or 1.21.4). This needs a
   second Paper jar, a fresh EULA acceptance and a regenerated world, so it is
   an operator decision, not an automatic fallback.
4. If a specific older version works, revise [ADR-001](#adr-001--target-minecraft-2612-paper-build-74-not-12111)
   and change the pin.
