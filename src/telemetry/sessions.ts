/**
 * Which runs belong together.
 *
 * Every agent is its own process and its own run, so one play session with
 * four agents is four runs started within seconds of each other. "Look at the
 * latest session" therefore has to mean that cluster -- not the single newest
 * run, which is one agent, and not the newest row in `runs`, which is as likely
 * to be a dry run or a probe as anything real.
 *
 * Shared by doctor, replay and compare, so all three agree on what "latest"
 * means rather than each guessing slightly differently.
 */

import type { DatabaseSync } from 'node:sqlite';

/**
 * Runs starting within this long of each other are one session.
 *
 * start-all-agents.bat staggers launches by 3 seconds, so a real session spans
 * about ten. Ten MINUTES, the first guess, merged a restart eight minutes
 * earlier into the same session -- mixing a run that made fourteen decisions
 * with the one that made five hundred.
 */
export const SESSION_WINDOW_MS = 2 * 60_000;
/** A run with fewer decisions than this is a restart or a probe, not a session. */
export const MIN_DECISIONS = 5;

export interface RunInfo {
  runId: string;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  decisions: number;
  /** The model that made most of this run's decisions. */
  model: string;
}

/**
 * Runs worth analysing, newest first.
 *
 * Excludes runs with almost no decisions -- probes, restarts, a bot that never
 * spawned -- and dry runs on the stub provider, whose "decisions" are a script.
 * Pass `includeAll` to see everything anyway.
 */
export function listRuns(db: DatabaseSync, includeAll = false): RunInfo[] {
  const rows = db
    .prepare(
      `SELECT r.run_id AS runId, r.started_at AS startedAt, r.ended_at AS endedAt,
              e.agent_id AS agentId, COUNT(*) AS decisions,
              (SELECT json_extract(d.data, '$.model') FROM events d
               WHERE d.run_id = r.run_id AND d.event_type = 'decision'
               GROUP BY json_extract(d.data, '$.model')
               ORDER BY COUNT(*) DESC LIMIT 1) AS model
       FROM runs r
       JOIN events e ON e.run_id = r.run_id AND e.event_type = 'decision'
       GROUP BY r.run_id, e.agent_id
       ORDER BY r.started_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows
    .map((row) => ({
      runId: String(row['runId']),
      agentId: String(row['agentId']),
      startedAt: String(row['startedAt']),
      endedAt: row['endedAt'] === null ? null : String(row['endedAt']),
      decisions: Number(row['decisions']),
      model: String(row['model'] ?? 'unknown'),
    }))
    .filter((run) => includeAll || (run.decisions >= MIN_DECISIONS && run.model !== 'stub'));
}

/** Group runs into sessions by start time, newest session first. */
export function groupSessions(runs: readonly RunInfo[]): RunInfo[][] {
  const sorted = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const sessions: RunInfo[][] = [];

  for (const run of sorted) {
    const current = sessions.at(-1);
    const anchor = current?.[0];
    if (
      current !== undefined &&
      anchor !== undefined &&
      Date.parse(anchor.startedAt) - Date.parse(run.startedAt) <= SESSION_WINDOW_MS
    ) {
      current.push(run);
    } else {
      sessions.push([run]);
    }
  }

  return sessions;
}

/**
 * Resolve a user-facing spec into run ids.
 *
 *   latest     the newest session (default)
 *   previous   the one before it -- what "did this regress" compares against
 *   all        every run that made decisions
 *   <run_id>   exactly that run
 */
export function resolveRuns(db: DatabaseSync, spec = 'latest'): RunInfo[] {
  if (spec === 'all') return listRuns(db);

  const sessions = groupSessions(listRuns(db));
  if (spec === 'latest') return sessions[0] ?? [];
  if (spec === 'previous') return sessions[1] ?? [];

  // An explicit run id is honoured even if it is a dry run or a short one --
  // naming it is a deliberate choice.
  return listRuns(db, true).filter((run) => run.runId === spec);
}
