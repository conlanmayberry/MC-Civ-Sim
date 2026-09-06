# Development

## Verified environment baseline

Captured 2026-09-06 on the operator's machine. This is the reference
configuration; if something behaves differently, check your versions against
this table first.

| Component | Detected | Required | Status |
|---|---|---|---|
| OS | Windows 11, build 10.0.26200.9278, x64 | — | ✅ |
| CPU | Intel i7-9750H, 6 cores / 12 threads | — | ✅ |
| RAM | 31.9 GB | 8 GB+ | ✅ |
| Disk (C:) | 30.7 GB free of 931 GB | see warning below | ⚠️ |
| Node.js | v26.4.0 | ≥22 (Mineflayer 4.39 `engines`) | ✅ |
| npm | 11.17.0 | — | ✅ |
| Git | 2.53.0.windows.1 | — | ✅ |
| Claude Code | working (desktop app) | — | ✅ |
| winget | present | — | ✅ |
| JDK | Temurin 25.0.4.1 LTS | 25 (Paper 26.1.2 minimum) | ✅ |
| Minecraft Java client | 26.1.2 profile | must match server protocol 775 | ✅ |

> ⚠️ **Disk pressure.** 30.7 GB free is comfortable for Stage 1 (JDK ≈ 330 MB,
> Paper jar ≈ 55 MB, generated world a few hundred MB), but multi-day
> experiments with world backups and telemetry will consume this quickly. The
> Stage 14 experiment runner needs an explicit retention policy, and long runs
> may need a second drive.

## One-time setup

### 1. Install the JDK

Paper 26.1.2 requires Java 25 or newer.

```bash
winget install --id EclipseAdoptium.Temurin.25.JDK -e
```

Open a **new** terminal afterwards so the updated `PATH` is picked up, then
confirm:

```bash
java -version
```

You should see `openjdk version "25.x.x"`. If you have several JDKs installed,
make sure the one on `PATH` is 25+ — `npm run minecraft:setup` will refuse to
continue otherwise rather than fail later with a confusing class-file error.

### 2. Install the Minecraft Java client

Needed to verify Stage 1 by actually joining the world.

```bash
winget install --id Mojang.MinecraftLauncher -e
```

Sign in, then let the launcher download a **26.1.2** profile. The client version
must match the server's protocol; a 26.2 client will not connect.

### 3. Prepare the server

```bash
npm run minecraft:setup
```

This will:

1. verify your JDK meets Paper's minimum,
2. download `paper-26.1.2-74.jar` and **verify its SHA-256** against the pin in
   `minecraft/config/paper-version.json`,
3. write `minecraft/server/server.properties` from the tracked template,
4. prompt you to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).

The EULA is never auto-accepted — the script requires an interactive `y`. Run it
from a normal terminal, not a CI or non-TTY context.

### 4. Optional: local config overrides

```bash
cp .env.example .env
```

`.env` is git-ignored. Stage 1 reads only `SERVER_MEMORY_MIN`,
`SERVER_MEMORY_MAX` and `MC_PORT` from it; everything else is documentation for
later stages.

## Running the server

```bash
npm run minecraft
```

The Paper console is interactive — type server commands (`list`, `save-all`,
`stop`) directly. **Ctrl-C performs a graceful save-and-stop** rather than
killing the JVM; press it a second time to force-kill if a shutdown hangs.

Join from the Minecraft client at **`127.0.0.1:25565`**.

### Checking for Paper updates

```bash
npm run minecraft:check-latest
```

Reports whether a newer Paper build or Minecraft version exists. It never
upgrades anything — the pin file is edited deliberately, so a given commit always
reproduces the same server binary. Before targeting a newer *Minecraft* version,
read [ADR-001](decisions.md#adr-001--target-minecraft-2612-paper-build-74-not-12111):
Paper supporting a version is not sufficient, Mineflayer and `minecraft-data`
gate that decision.

## Server configuration

Edit `minecraft/config/server.properties.template`, **not**
`minecraft/server/server.properties`. The latter is git-ignored and gets
rewritten by Paper at runtime. To apply template changes, delete the generated
copy and re-run setup:

```bash
rm minecraft/server/server.properties
npm run minecraft:setup
```

The server is bound to loopback and runs with authentication disabled so that
Mineflayer bots can connect without a Microsoft account each. Those two settings
are a pair — read
[ADR-002](decisions.md#adr-002--online-modefalse-paired-with-a-loopback-only-bind)
before changing either.

## Troubleshooting

**`No Java runtime found on PATH`** — the JDK is not installed, or you did not
open a new terminal after installing it.

**`Java NN is installed, but Paper requires Java 25`** — an older JDK is earlier
on `PATH`. Reorder `PATH` or uninstall the old JDK.

**`SHA-256 mismatch`** — do not work around this. Either the pin is wrong or the
download was corrupted. Re-run once; if it persists, verify the pin against
`https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds/latest`.

**Client cannot connect / "Outdated server"** — your Minecraft profile is not
26.1.2. Create a 26.1.2 profile in the launcher.

**Connection refused from another machine** — expected. The server binds to
`127.0.0.1` deliberately. See ADR-002.

**Port 25565 already in use** — another server is running. Set `MC_PORT` in
`.env` and `server-port` in the template, or stop the other process.

## Project layout

```
MC-Civ-Sim/
├── docs/
│   ├── architecture.md      # telemetry + system design (filled in at Stage 4)
│   ├── decisions.md         # ADRs
│   ├── development.md       # this file
│   └── experiments.md       # experiment protocol (filled in at Stage 14)
├── minecraft/
│   ├── config/              # TRACKED: version pin + server.properties template
│   └── server/              # generated at runtime, git-ignored
├── scripts/
│   ├── setup-paper.mjs
│   └── start-server.mjs
└── package.json
```

`src/` and `data/` do not exist yet. They are created when Stage 2 and Stage 4
actually need them — empty directories that exist only to look like the target
architecture are worse than no directories.

---

## Stage 1 verification record

Completed **2026-09-06**. All five criteria passed on the baseline machine above.

| # | Criterion | Evidence |
|---|---|---|
| 1 | JDK meets Paper's minimum | Temurin `openjdk version "25.0.4.1" 2026-08-18 LTS` |
| 2 | Jar verified, EULA accepted, config written | 52,893,229 bytes; SHA-256 matched the pin (independently re-hashed); `eula.txt` timestamped `2026-09-06T19:58:24Z` |
| 3 | Server boots cleanly | `Starting minecraft server version 26.1.2` / `Paper version 26.1.2-74-ver/26.1.2@e4e17fc` / `Done (42.812s)! For help, type "help"` |
| 3a | Loopback isolation | `Starting Minecraft server on 127.0.0.1:25565` |
| 4 | **Human joins from a Minecraft Java client** | player joined from `/127.0.0.1:57995`, spawned at overworld `(1251.5, 74.0, -245.5)` |
| 5 | Graceful shutdown | `stop` → all three dimensions saved, `ThreadedAnvilChunkStorage: All dimensions are saved`, 2209 block chunks written in 1.74s |

Log: **0 errors, 0 exceptions.** 10 warnings, all expected:

- `SERVER IS RUNNING IN OFFLINE/INSECURE MODE` — intended, and the reason the
  loopback bind is mandatory. See [ADR-002](decisions.md#adr-002--online-modefalse-paired-with-a-loopback-only-bind).
- `you are 2 release(s) behind the latest stable release (26.2)` — intended.
  26.2 has no `minecraft-data` entry, so Mineflayer cannot speak it. See
  [ADR-001](decisions.md#adr-001--target-minecraft-2612-paper-build-74-not-12111).
  Paper separately confirms `You are running the latest build for your Minecraft
  version (26.1.2)`.

First boot took ~43 s (Paper patches the vanilla jar and generates the world);
subsequent boots are much faster. The generated world was 17 MB after a few
minutes of play — a useful growth datapoint against the 30 GB disk headroom.

### Offline-mode UUIDs are stable — this matters for Stage 4

The joining player received UUID `aa260259-fb7e-32c5-a0e6-8fd1cdc7c118`. The `3`
in the third group marks it a **version-3 (name-based) UUID**: in offline mode
Minecraft derives it deterministically from `OfflinePlayer:<username>`, not
randomly.

Consequence for telemetry design: an agent's Minecraft UUID is a stable function
of its username, identical across server restarts and world regenerations. Agent
identity can therefore be keyed on username without a lookup table — but the
corollary is that **reusing a username reuses the identity**, so experiment runs
must namespace agent names if their event streams are to stay distinct.

---

## Stage 2 — running the bot

The Paper server must be running first (`npm run minecraft`, separate terminal).

```bash
npm run bot
```

Then say `bot help` in Minecraft chat. Commands: `status`, `inventory` (`inv`),
`look`, `who`, `come`, `stop`, `quit`, `help`.

Stop it with `bot quit` in chat or Ctrl-C. Both are hard stops — neither
reconnects.

### TypeScript with no build step

Node 26 runs `.ts` files directly, so there is nothing to compile. Two rules
follow from that ([ADR-004](decisions.md#adr-004--no-build-step-node-runs-typescript-natively)):

1. **Relative imports need the `.ts` extension** — `./config.ts`, not
   `./config.js` or `./config`. The other two fail at runtime.
2. **No `enum`, `namespace`, or parameter properties.** They need code
   generation, which type stripping does not do.

`npm run typecheck` enforces both (`erasableSyntaxOnly`), so run it before
committing. It is the only thing standing between you and a runtime crash on
otherwise valid-looking TypeScript.

### Probes

```bash
npm run bot:probe
```

Checks that `minecraft-data`'s 26.1 dataset actually matches the 26.1.2 server —
registries, name/id round-trips, recipes, and a decode of ~8,000 live blocks
against the block-state palette. This is the standing answer to
[ADR-001](decisions.md#adr-001--target-minecraft-2612-paper-build-74-not-12111);
re-run it after any version change.

```bash
npm run bot:probe-chat
```

Joins as a second player and drives the bot through every chat command,
asserting the reply format. Needs `npm run bot` already running.

Last run 2026-09-06: **7/7 data checks, 8/8 chat cases**, including 8,125 live
blocks decoded with zero palette inconsistencies.

### Known limitation: the bot cannot walk

`bot come` does not work. The server rejects mineflayer's movement packets and
teleports the bot back ~17 times a second; everything else is unaffected. Fully
measured in [ADR-006](decisions.md#adr-006--bot-movement-is-blocked-upstream-stage-3-gated-on-it).
**Stage 3 is gated on resolving it.**

### Troubleshooting

**`duplicate_login` kick loop** — two bot processes are sharing a username.
Killing an `npm run bot` wrapper can leave the `node` child alive; check with
`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and stop the orphan.

**Bot exits immediately instead of reconnecting** — should not happen now, but
it is what an accidentally `unref()`'d retry timer looks like. The retry timer
is the only thing holding the event loop open while the server is down.

**Chat replies intermittently missing** — almost always the duplicate-login loop
above rather than a chat problem.
