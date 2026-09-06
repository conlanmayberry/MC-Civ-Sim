# Experiments

**Status: stub.** Filled in at **Stage 14 (Experiment System)**.

No experiments have been run. There is no agent to observe yet — as of Stage 1
the project is a local Paper server.

## What an experiment record will need

Recorded now only so that Stage 4's telemetry schema is designed with
reproducibility in mind, rather than retrofitted:

- experiment ID
- world seed and Minecraft/Paper version
- server configuration
- agent configuration (count, identities, starting inventories)
- model configuration
- starting conditions and experiment variables
- start and end time

Target output layout:

```
data/experiments/experiment_001/
├── world/
├── database.sqlite
├── events.jsonl
├── metrics.json
├── configuration.json
└── report.md
```

## Reproducibility groundwork already in place

Two Stage 1 choices exist specifically to serve this:

- **Fixed world seed** (`level-seed` in
  `minecraft/config/server.properties.template`) — the same seed regenerates the
  same world.
- **Pinned, checksum-verified server build**
  (`minecraft/config/paper-version.json`) — a given commit always reproduces the
  same server binary. See
  [ADR-001](decisions.md#adr-001--target-minecraft-2612-paper-build-74-not-12111).

Full reproducibility also requires pinning the model version and the agent
prompt set. Those are Stage 5 concerns.
