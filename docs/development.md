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
| **JDK** | **not installed** | **25** (Paper 26.1.2 minimum) | ❌ install required |
| **Minecraft Java client** | **not installed** | any version able to run the 26.1.2 profile | ❌ install required |

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
