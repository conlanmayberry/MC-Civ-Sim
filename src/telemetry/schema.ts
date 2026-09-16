/**
 * The telemetry schema.
 *
 * The project brief treats the Minecraft world as an experimental apparatus, so
 * this database is the actual output of the whole system -- the world is
 * disposable, the data is not. Two principles shape it:
 *
 * EVENT-DRIVEN PLUS PERIODIC SNAPSHOTS, not per-tick logging. Minecraft runs at
 * 20 ticks a second and eight agents would produce millions of near-identical
 * rows a day, which is both unaffordable and unanalysable. Events record what
 * changed; snapshots record what was true, occasionally.
 *
 * WORLD TRUTH IS NOT AGENT KNOWLEDGE. Everything written here comes from what a
 * specific agent could observe (ADR-005). This is a record of experiences, not
 * an omniscient world log, and Stage 7's memory system depends on that
 * distinction holding.
 *
 * Only tables that something actually writes to exist. The brief also lists
 * goals, decisions and relationships; those arrive with the stages that produce
 * them (6, 5 and 11), because an empty table is a promise the schema has not
 * kept and invites queries that silently return nothing.
 */

export const SCHEMA_VERSION = 1;

/**
 * Applied in order, inside one transaction, on every open.
 *
 * Each statement is written to be safe to re-run. When Stage 5 needs new
 * tables, they are appended here rather than edited in place -- an existing
 * database must keep opening.
 */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  /**
   * One row per agent identity. In offline mode the Minecraft UUID is a stable
   * function of the username (established in Stage 1), so an agent's identity
   * survives restarts and world regeneration -- which is exactly why a run_id
   * exists below to keep separate experiments apart.
   */
  `CREATE TABLE IF NOT EXISTS agents (
     agent_id    TEXT PRIMARY KEY,
     username    TEXT NOT NULL,
     uuid        TEXT,
     first_seen  TEXT NOT NULL,
     last_seen   TEXT NOT NULL
   )`,

  /**
   * A run is one continuous experiment. Without it, re-running a scenario
   * against the same world silently interleaves two experiments in one table
   * and every aggregate becomes meaningless.
   */
  `CREATE TABLE IF NOT EXISTS runs (
     run_id            TEXT PRIMARY KEY,
     started_at        TEXT NOT NULL,
     ended_at          TEXT,
     minecraft_version TEXT,
     world_name        TEXT,
     note              TEXT
   )`,

  /**
   * The core table.
   *
   * Location and tick are denormalised onto every row on purpose: "where did
   * this happen" and "when in world time" are asked of nearly every query, and
   * joining them back from snapshots would be both slower and lossy.
   *
   * `data` holds the event-specific payload as JSON. SQLite can query into it
   * with json_extract, so this stays flexible without a column per event type.
   */
  `CREATE TABLE IF NOT EXISTS events (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id         TEXT NOT NULL,
     agent_id       TEXT NOT NULL,
     timestamp      TEXT NOT NULL,
     minecraft_tick INTEGER,
     event_type     TEXT NOT NULL,
     action         TEXT,
     ok             INTEGER,
     error_code     TEXT,
     duration_ms    INTEGER,
     x              REAL,
     y              REAL,
     z              REAL,
     dimension      TEXT,
     data           TEXT NOT NULL
   )`,

  /**
   * Periodic full state. Answers "what was the inventory at important times?"
   * without reconstructing it by replaying every item event, which would be
   * both fragile and wrong the moment one event is missed.
   */
  `CREATE TABLE IF NOT EXISTS snapshots (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id         TEXT NOT NULL,
     agent_id       TEXT NOT NULL,
     timestamp      TEXT NOT NULL,
     minecraft_tick INTEGER,
     x              REAL,
     y              REAL,
     z              REAL,
     dimension      TEXT,
     health         REAL,
     food           REAL,
     experience     INTEGER,
     inventory      TEXT NOT NULL,
     nearby_entities TEXT,
     reason         TEXT
   )`,

  /**
   * What an agent knows about where things are.
   *
   * Keyed by agent rather than by run: the whole value is that a shelter is
   * still findable after a restart. Never joined across agents -- one agent
   * learning where another's shelter is has to happen by being told, in chat,
   * or Stage 9's misinformation study is studying a database.
   *
   * Appended rather than versioned: SCHEMA_VERSION stays 1 because every
   * statement here is safe to re-run and an existing database must keep
   * opening.
   */
  `CREATE TABLE IF NOT EXISTS places (
     agent_id   TEXT NOT NULL,
     name       TEXT NOT NULL,
     x          REAL NOT NULL,
     y          REAL NOT NULL,
     z          REAL NOT NULL,
     dimension  TEXT NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, name)
   )`,

  /**
   * What a run WAS: the code, the configuration and the exact prompt.
   *
   * Added after a model comparison that could not be trusted. Bob's Luna and
   * Terra sessions were days apart, on different world states, with several
   * commits landing between them -- so part of the difference was the model
   * and part was fixes shipped in between, and nothing recorded could separate
   * the two. It also ends the stale-process question for good: a run says what
   * it was actually executing.
   *
   * One row per (run, agent), since every agent is its own process and its own
   * run. `system_prompt` is stored in full rather than hashed, because replay
   * needs the exact text to reproduce a decision.
   */
  `CREATE TABLE IF NOT EXISTS run_manifests (
     run_id             TEXT NOT NULL,
     agent_id           TEXT NOT NULL,
     created_at         TEXT NOT NULL,
     git_commit         TEXT,
     git_dirty          INTEGER,
     dirty_files        TEXT,
     node_version       TEXT,
     minecraft_version  TEXT,
     provider           TEXT,
     model              TEXT,
     interval_ms        INTEGER,
     budget_usd         REAL,
     identity           TEXT NOT NULL,
     settings           TEXT NOT NULL,
     system_prompt      TEXT NOT NULL,
     system_prompt_hash TEXT NOT NULL,
     tools_hash         TEXT NOT NULL,
     PRIMARY KEY (run_id, agent_id)
   )`,

  /**
   * Everything a decision was made FROM, so it can be made again.
   *
   * A decision is a pure function of its inputs -- system prompt, observation,
   * history, injections -- and the `decision` event already records the
   * output. Keeping the inputs is what lets a prompt or model change be tested
   * against hundreds of real situations from a past session, in minutes and
   * without a server, instead of against a fresh hour of play that can never
   * be compared like for like.
   *
   * Kept out of `events` on purpose: these rows are several kilobytes each,
   * and every dashboard query and CLI report would pay for them.
   */
  `CREATE TABLE IF NOT EXISTS decision_inputs (
     run_id      TEXT NOT NULL,
     agent_id    TEXT NOT NULL,
     cycle       INTEGER NOT NULL,
     timestamp   TEXT NOT NULL,
     trigger     TEXT,
     observation TEXT NOT NULL,
     history     TEXT NOT NULL,
     injections  TEXT NOT NULL,
     PRIMARY KEY (run_id, agent_id, cycle)
   )`,

  /**
   * Scenario test outcomes, kept so a regression is visible as a regression.
   * A scenario that passed last week and fails today is the most useful thing
   * the harness can say, and a JSON file per run cannot say it.
   */
  `CREATE TABLE IF NOT EXISTS scenario_results (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     batch_id    TEXT NOT NULL,
     run_at      TEXT NOT NULL,
     scenario_id TEXT NOT NULL,
     verdict     TEXT NOT NULL,
     detail      TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     git_commit  TEXT,
     git_dirty   INTEGER
   )`,

  // --- indexes ------------------------------------------------------------
  // Chosen for the questions the brief says the system must answer, not
  // speculatively: what did an agent do and when (1), what happened of a given
  // kind (2), how did actions fare (3), and what happened around a place (4).
  `CREATE INDEX IF NOT EXISTS idx_events_agent_time ON events (agent_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type_time  ON events (event_type, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_events_action     ON events (action, ok)`,
  `CREATE INDEX IF NOT EXISTS idx_events_run        ON events (run_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_agent   ON snapshots (agent_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_scenarios_id      ON scenario_results (scenario_id, id)`,
];
