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
