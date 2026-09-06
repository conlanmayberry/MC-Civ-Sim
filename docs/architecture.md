# Architecture

**Status: stub.** This document is written for real at **Stage 4 (Telemetry
Foundation)**, when there is an actual event schema and data flow to describe.

Nothing here should be treated as implemented. As of Stage 1 the system is a
local Paper server and two setup scripts — there is no bot, no agent runtime, no
telemetry and no AI.

## Target shape

The intended end state, recorded so that Stage 1–3 choices do not paint us into
a corner:

```
Minecraft Server (Paper)
        |
Mineflayer Environment          <- Stage 2/3
        |
Agent Runtime                   <- Stage 5/6/7
  identity | goals | memory | relationships | decision making
        |
Claude / LLM                    <- Stage 5
        |
Tool / Action Layer             <- Stage 3 (deterministic) then Stage 5 (AI-driven)
        |
Telemetry / Event Bus           <- Stage 4
        |
SQLite                          <- Stage 4
        |
Dashboard                       <- Stage 13
```

## Boundaries that already constrain Stage 1

Three separations from the project's core principles are load-bearing, and the
Stage 1 configuration was chosen to keep them possible:

1. **Minecraft interaction is separate from AI decision-making.** The Paper
   server knows nothing about agents. `enable-command-block=false` and RCON/query
   disabled keep the server from becoming an administrative back channel an
   agent could reach.

2. **AI decision-making is separate from telemetry.** Not yet exercised.

3. **World truth is separate from agent knowledge.** The server holds ground
   truth. Agents will only ever learn what they observe or are told. Nothing in
   Stage 1 grants any client privileged world access.

## Deferred deliberately

The event schema, table design, indexing strategy and snapshot cadence are all
Stage 4 work. Designing them now, before a single bot action has been observed,
would be guessing at the shape of data we have never collected.
