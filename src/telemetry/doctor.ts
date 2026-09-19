/**
 * Known failure patterns, checked automatically.
 *
 * Every serious bug found in this project so far was found the same way: a
 * session was played, and then somebody queried the telemetry by hand until
 * the pattern showed. One placement retried 110 times. Items handed over and
 * never picked up. A starving agent standing still. follow_player succeeding a
 * third of the time. Each of those was a query written once and thrown away.
 *
 * This keeps them. Every check here is a failure that has actually happened,
 * so a session ends with a report instead of an archaeology project -- and a
 * fixed bug that comes back is caught the first time it does, rather than the
 * first time someone thinks to look.
 *
 * Checks are independent and individually guarded: a check that cannot run
 * (an older database without a table it needs) reports that and the rest
 * carry on. A doctor that crashes on the data it is meant to diagnose is no
 * use to anyone.
 */

import type { DatabaseSync } from 'node:sqlite';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  check: string;
  severity: Severity;
  /** Null when the finding is about the session rather than one agent. */
  agent: string | null;
  message: string;
}

export interface DoctorOptions {
  /** The runs to examine -- usually one session's worth. */
  runIds: readonly string[];
  /**
   * The session before, for regression checks. Omit to skip them, e.g. when
   * an agent reports on its own run at shutdown.
   */
  previousRunIds?: readonly string[];
}

// Thresholds. Each is set from a real incident rather than guessed at, and
// named so the report can say what it measured against.
const REPEAT_WARN = 10;
const REPEAT_ERROR = 30;
const MIN_ATTEMPTS = 20;
const LOW_SUCCESS_WARN = 0.4;
const LOW_SUCCESS_ERROR = 0.2;
const REGRESSION_POINTS = 15;
const PICKUP_WINDOW_MS = 150_000;
const UNCOLLECTED_RATIO = 0.3;
const STARVING_FOOD = 2;
const HUNGRY_FOOD = 4;
const HUNGRY_SNAPSHOTS = 3;
const STUCK_RADIUS = 4;
const STUCK_MS = 5 * 60_000;
const CHAT_RATIO = 0.5;
const MIN_CHAT = 30;
const DEATHS_PER_HOUR = 2;
const NOOP_RATIO = 0.25;
const MIN_DECISIONS = 40;

type Row = Record<string, unknown>;

function holes(ids: readonly string[]): string {
  return ids.map(() => '?').join(', ');
}

function rows(db: DatabaseSync, sql: string, params: readonly unknown[]): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Numbers vary between otherwise-identical failures -- "16.12m short", "9.93m
 * short" -- and would split one recurring problem into a hundred singletons
 * that never reach any threshold.
 */
export function normaliseMessage(message: string): string {
  return message.replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
}

// --- checks -------------------------------------------------------------------

/** The same failure, over and over: the 110-sapling loop. */
function repeatedFailures(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const groups = new Map<string, { agent: string; action: string; message: string; n: number }>();

  for (const row of rows(
    db,
    `SELECT agent_id, action, error_code, json_extract(data, '$.message') AS message
     FROM events WHERE ok = 0 AND action IS NOT NULL AND run_id IN (${holes(runIds)})`,
    runIds,
  )) {
    const message = normaliseMessage(String(row['message'] ?? row['error_code'] ?? 'failed'));
    const key = `${row['agent_id']}|${row['action']}|${message}`;
    const group = groups.get(key) ?? {
      agent: String(row['agent_id']),
      action: String(row['action']),
      message,
      n: 0,
    };
    group.n++;
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((g) => g.n >= REPEAT_WARN)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map((g) => ({
      check: 'repeated_failure',
      severity: g.n >= REPEAT_ERROR ? 'error' : 'warn',
      agent: g.agent,
      message: `${g.action} failed the same way ${g.n} times: "${g.message.slice(0, 90)}"`,
    }));
}

function successRates(
  db: DatabaseSync,
  runIds: readonly string[],
  byAgent: boolean,
): Map<string, { agent: string | null; action: string; attempts: number; ok: number }> {
  const out = new Map<string, { agent: string | null; action: string; attempts: number; ok: number }>();
  if (runIds.length === 0) return out;

  for (const row of rows(
    db,
    `SELECT ${byAgent ? 'agent_id' : 'NULL'} AS agent_id, action, COUNT(*) AS attempts,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok
     FROM events WHERE action IS NOT NULL AND ok IS NOT NULL AND run_id IN (${holes(runIds)})
     GROUP BY ${byAgent ? 'agent_id, ' : ''}action`,
    runIds,
  )) {
    const agent = row['agent_id'] === null ? null : String(row['agent_id']);
    out.set(`${agent}|${row['action']}`, {
      agent,
      action: String(row['action']),
      attempts: Number(row['attempts']),
      ok: Number(row['ok']),
    });
  }
  return out;
}

/** An action that mostly does not work: follow_player at 37%. */
function lowSuccess(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  return [...successRates(db, runIds, true).values()]
    .filter((r) => r.attempts >= MIN_ATTEMPTS && r.ok / r.attempts < LOW_SUCCESS_WARN)
    .sort((a, b) => a.ok / a.attempts - b.ok / b.attempts)
    .map((r) => ({
      check: 'low_success',
      severity: r.ok / r.attempts < LOW_SUCCESS_ERROR ? 'error' : 'warn',
      agent: r.agent,
      message: `${r.action} succeeded ${r.ok}/${r.attempts} (${pct(r.ok / r.attempts)})`,
    }));
}

/**
 * An action that got worse since last session.
 *
 * Pooled across agents: per-agent samples are too small to tell a regression
 * from a bad afternoon, and a code change affects every agent at once anyway.
 */
function successRegression(
  db: DatabaseSync,
  runIds: readonly string[],
  previousRunIds: readonly string[],
): Finding[] {
  const now = successRates(db, runIds, false);
  const before = successRates(db, previousRunIds, false);
  const findings: Finding[] = [];

  for (const [key, current] of now) {
    const prior = before.get(key);
    if (prior === undefined) continue;
    if (current.attempts < MIN_ATTEMPTS || prior.attempts < MIN_ATTEMPTS) continue;

    const drop = (prior.ok / prior.attempts - current.ok / current.attempts) * 100;
    if (drop >= REGRESSION_POINTS) {
      findings.push({
        check: 'success_regression',
        severity: 'warn',
        agent: null,
        message:
          `${current.action} fell from ${pct(prior.ok / prior.attempts)} to ` +
          `${pct(current.ok / current.attempts)} since the previous session`,
      });
    }
  }
  return findings;
}

/** Handed over and left on the ground: 12 of 37 gives, once. */
function uncollectedGives(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const agentsByName = new Map(
    rows(db, `SELECT agent_id, username FROM agents`, []).map((r) => [
      String(r['username']),
      String(r['agent_id']),
    ]),
  );

  const perRecipient = new Map<string, { gives: number; uncollected: number }>();

  for (const give of rows(
    db,
    `SELECT timestamp, json_extract(data, '$.to') AS recipient
     FROM events WHERE action = 'give_item' AND ok = 1 AND run_id IN (${holes(runIds)})`,
    runIds,
  )) {
    const recipient = agentsByName.get(String(give['recipient']));
    // Gives to a person are theirs to pick up or not; only agent-to-agent
    // handovers say anything about the agents.
    if (recipient === undefined) continue;

    const at = Date.parse(String(give['timestamp']));
    const collected = rows(
      db,
      `SELECT 1 FROM events
       WHERE agent_id = ? AND action = 'collect_items' AND ok = 1
         AND COALESCE(json_extract(data, '$.itemsGained'), 0) > 0
         AND timestamp > ? AND timestamp <= ?
       LIMIT 1`,
      [recipient, new Date(at).toISOString(), new Date(at + PICKUP_WINDOW_MS).toISOString()],
    );

    const entry = perRecipient.get(recipient) ?? { gives: 0, uncollected: 0 };
    entry.gives++;
    if (collected.length === 0) entry.uncollected++;
    perRecipient.set(recipient, entry);
  }

  return [...perRecipient.entries()]
    .filter(([, e]) => e.gives >= 3 && e.uncollected / e.gives >= UNCOLLECTED_RATIO)
    .map(([agent, e]) => ({
      check: 'uncollected_gives',
      severity: 'warn',
      agent,
      message: `${e.uncollected} of ${e.gives} items handed to them were never picked up`,
    }));
}

interface Snapshot {
  at: number;
  x: number;
  z: number;
  food: number | null;
}

function snapshotsByAgent(db: DatabaseSync, runIds: readonly string[]): Map<string, Snapshot[]> {
  const out = new Map<string, Snapshot[]>();
  for (const row of rows(
    db,
    `SELECT agent_id, timestamp, x, z, food FROM snapshots
     WHERE run_id IN (${holes(runIds)}) AND x IS NOT NULL
     ORDER BY agent_id, timestamp`,
    runIds,
  )) {
    const agent = String(row['agent_id']);
    const list = out.get(agent) ?? [];
    list.push({
      at: Date.parse(String(row['timestamp'])),
      x: Number(row['x']),
      z: Number(row['z']),
      food: row['food'] === null ? null : Number(row['food']),
    });
    out.set(agent, list);
  }
  return out;
}

/** Dying of hunger, and going hungry for minutes without doing anything about it. */
function hunger(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const snapshots = snapshotsByAgent(db, runIds);

  const starved = new Map<string, number>();
  for (const death of rows(
    db,
    `SELECT agent_id, timestamp, json_extract(data, '$.cause') AS cause FROM events
     WHERE event_type = 'death' AND run_id IN (${holes(runIds)})`,
    runIds,
  )) {
    const agent = String(death['agent_id']);
    const at = Date.parse(String(death['timestamp']));
    // The server's own death message, when recorded, settles it. Guessing from
    // the food bar called a skeleton volley "starvation" four times over.
    if (typeof death['cause'] === 'string') {
      if (death['cause'].startsWith('starved')) starved.set(agent, (starved.get(agent) ?? 0) + 1);
      continue;
    }
    // The snapshot taken at death records the inventory about to be lost, and
    // food as it was when the agent died.
    const before = (snapshots.get(agent) ?? [])
      .filter((s) => s.at <= at + 5_000 && s.at >= at - 120_000 && s.food !== null)
      .at(-1);
    if (before !== undefined && (before.food ?? 20) <= STARVING_FOOD) {
      starved.set(agent, (starved.get(agent) ?? 0) + 1);
    }
  }
  for (const [agent, n] of starved) {
    findings.push({
      check: 'starvation',
      severity: 'error',
      agent,
      message: `died ${n} time(s) with an empty food bar`,
    });
  }

  for (const [agent, list] of snapshots) {
    let run = 0;
    let episodes = 0;
    for (const s of list) {
      if (s.food !== null && s.food <= HUNGRY_FOOD) {
        run++;
        if (run === HUNGRY_SNAPSHOTS) episodes++;
      } else {
        run = 0;
      }
    }
    if (episodes > 0 && !starved.has(agent)) {
      findings.push({
        check: 'hunger_unaddressed',
        severity: 'warn',
        agent,
        message: `spent ${episodes} stretch(es) of ${HUNGRY_SNAPSHOTS}+ minutes nearly starving`,
      });
    }
  }

  return findings;
}

/**
 * Standing in one place for minutes.
 *
 * Time under a standing order is excluded: "stay put" is supposed to look
 * exactly like this, and flagging obedience as a fault would teach the reader
 * to ignore the check.
 */
function stuck(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const orders = new Map<string, Array<{ from: number; to: number }>>();
  const open = new Map<string, number>();

  for (const row of rows(
    db,
    `SELECT agent_id, timestamp, json_extract(data, '$.kind') AS kind FROM events
     WHERE event_type = 'thought_injected' AND run_id IN (${holes(runIds)})
       AND json_extract(data, '$.kind') IN ('standing_order_given', 'standing_order_lifted')
     ORDER BY timestamp`,
    runIds,
  )) {
    const agent = String(row['agent_id']);
    const at = Date.parse(String(row['timestamp']));
    if (row['kind'] === 'standing_order_given') {
      if (!open.has(agent)) open.set(agent, at);
    } else {
      const from = open.get(agent);
      if (from !== undefined) {
        orders.set(agent, [...(orders.get(agent) ?? []), { from, to: at }]);
        open.delete(agent);
      }
    }
  }
  for (const [agent, from] of open) {
    orders.set(agent, [...(orders.get(agent) ?? []), { from, to: Number.POSITIVE_INFINITY }]);
  }

  const findings: Finding[] = [];
  for (const [agent, list] of snapshotsByAgent(db, runIds)) {
    const underOrder = (at: number): boolean =>
      (orders.get(agent) ?? []).some((o) => at >= o.from && at <= o.to);

    let longest = 0;
    let episodes = 0;
    let i = 0;
    while (i < list.length) {
      const anchor = list[i];
      if (anchor === undefined) break;
      let j = i;
      while (
        j + 1 < list.length &&
        Math.hypot((list[j + 1]?.x ?? 0) - anchor.x, (list[j + 1]?.z ?? 0) - anchor.z) <= STUCK_RADIUS
      ) {
        j++;
      }
      const end = list[j];
      const span = end === undefined ? 0 : end.at - anchor.at;
      if (span >= STUCK_MS && !underOrder(anchor.at)) {
        episodes++;
        longest = Math.max(longest, span);
      }
      i = j + 1;
    }

    if (episodes > 0) {
      findings.push({
        check: 'stuck',
        severity: 'warn',
        agent,
        message:
          `stayed within ${STUCK_RADIUS} blocks for ${Math.round(longest / 60_000)}+ minutes ` +
          `(${episodes} time(s)) without being ordered to`,
      });
    }
  }
  return findings;
}

/** Talking instead of doing: the four-agent chat storm. */
function chatter(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows(
    db,
    `SELECT agent_id,
            SUM(CASE WHEN event_type = 'chat_sent' THEN 1 ELSE 0 END) AS said,
            SUM(CASE WHEN action IS NOT NULL THEN 1 ELSE 0 END) AS acted,
            SUM(CASE WHEN json_extract(data, '$.note') = 'chat withheld -- allowance spent' THEN 1 ELSE 0 END) AS withheld
     FROM events WHERE run_id IN (${holes(runIds)}) GROUP BY agent_id`,
    runIds,
  )) {
    const said = Number(row['said']);
    const acted = Math.max(1, Number(row['acted']));
    const withheld = Number(row['withheld']);
    if (said >= MIN_CHAT && said / acted > CHAT_RATIO) {
      findings.push({
        check: 'chatty',
        severity: 'warn',
        agent: String(row['agent_id']),
        message: `sent ${said} messages against ${acted} actions -- more talking than doing`,
      });
    }
    if (withheld >= 20) {
      findings.push({
        check: 'chat_rationed',
        severity: 'info',
        agent: String(row['agent_id']),
        message: `${withheld} messages were held back by the chat allowance`,
      });
    }
  }
  return findings;
}

function hoursByAgent(db: DatabaseSync, runIds: readonly string[]): Map<string, number> {
  return new Map(
    rows(
      db,
      `SELECT agent_id, MIN(timestamp) AS first, MAX(timestamp) AS last FROM events
       WHERE event_type = 'decision' AND run_id IN (${holes(runIds)}) GROUP BY agent_id`,
      runIds,
    ).map((r) => [
      String(r['agent_id']),
      Math.max(0, Date.parse(String(r['last'])) - Date.parse(String(r['first']))) / 3_600_000,
    ]),
  );
}

function deaths(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const hours = hoursByAgent(db, runIds);
  return rows(
    db,
    `SELECT agent_id, COUNT(*) AS n,
            GROUP_CONCAT(COALESCE(json_extract(data, '$.cause'), 'cause not recorded'), '|') AS causes
       FROM events
     WHERE event_type = 'death' AND run_id IN (${holes(runIds)}) GROUP BY agent_id`,
    runIds,
  )
    .map((r) => ({ agent: String(r['agent_id']), n: Number(r['n']), causes: summariseCauses(String(r['causes'] ?? '')) }))
    .filter((d) => {
      const h = hours.get(d.agent) ?? 0;
      return h >= 0.25 && d.n / h >= DEATHS_PER_HOUR;
    })
    .map((d) => ({
      check: 'deaths',
      severity: 'warn' as const,
      agent: d.agent,
      message: `died ${d.n} times in ${(hours.get(d.agent) ?? 0).toFixed(1)}h: ${d.causes}`,
    }));
}

/** "drowned|drowned|was shot by Skeleton" -> "drowned x2, was shot by Skeleton". */
export function summariseCauses(joined: string): string {
  const counts = new Map<string, number>();
  for (const cause of joined.split('|').filter((c) => c !== '')) {
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cause, n]) => (n > 1 ? `${cause} x${n}` : cause))
    .join(', ');
}

function loopHealth(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  const findings: Finding[] = [];

  for (const row of rows(
    db,
    `SELECT agent_id,
            SUM(CASE WHEN event_type = 'decision' THEN 1 ELSE 0 END) AS decisions,
            SUM(CASE WHEN json_extract(data, '$.note') = 'no-op turn' THEN 1 ELSE 0 END) AS noops,
            SUM(CASE WHEN json_extract(data, '$.note') = 'cycle failed' THEN 1 ELSE 0 END) AS failed
     FROM events WHERE run_id IN (${holes(runIds)}) GROUP BY agent_id`,
    runIds,
  )) {
    const agent = String(row['agent_id']);
    const decisions = Number(row['decisions']);
    const noops = Number(row['noops']);
    const failed = Number(row['failed']);

    if (decisions >= MIN_DECISIONS && noops / decisions > NOOP_RATIO) {
      findings.push({
        check: 'noop_turns',
        severity: 'warn',
        agent,
        message: `${noops} of ${decisions} turns (${pct(noops / decisions)}) accomplished nothing`,
      });
    }
    if (failed >= 3) {
      findings.push({
        check: 'provider_errors',
        severity: 'warn',
        agent,
        message: `${failed} decision cycles failed on a provider error`,
      });
    }
  }

  for (const row of rows(
    db,
    `SELECT agent_id, json_extract(data, '$.reason') AS reason FROM events
     WHERE event_type = 'agent_stopped' AND run_id IN (${holes(runIds)})`,
    runIds,
  )) {
    const reason = String(row['reason'] ?? '');
    if (/provider error|consecutive failures/.test(reason)) {
      findings.push({ check: 'stopped_on_error', severity: 'error', agent: String(row['agent_id']), message: `stopped: ${reason}` });
    } else if (/budget|maxUsd|spent/.test(reason)) {
      findings.push({ check: 'stopped_on_budget', severity: 'info', agent: String(row['agent_id']), message: `stopped at its spend cap: ${reason}` });
    }
  }

  return findings;
}

/**
 * Were these agents running the same code?
 *
 * The confound that spoiled the Luna/Terra comparison. A session where agents
 * ran different commits, or uncommitted changes, is not a clean comparison
 * between those agents, and a report about it should say so up front.
 */
function codeConsistency(db: DatabaseSync, runIds: readonly string[]): Finding[] {
  let manifests: Row[];
  try {
    manifests = rows(
      db,
      `SELECT agent_id, git_commit, git_dirty, system_prompt_hash FROM run_manifests WHERE run_id IN (${holes(runIds)})`,
      runIds,
    );
  } catch (err) {
    // A database no agent of this version has opened yet has no such table.
    // That is the same fact as "no manifest", not a broken check.
    if (!/no such table/.test(err instanceof Error ? err.message : String(err))) throw err;
    manifests = [];
  }

  if (manifests.length === 0) {
    return [
      {
        check: 'no_manifest',
        severity: 'info',
        agent: null,
        message: 'these runs predate run manifests, so the code they ran is not recorded',
      },
    ];
  }

  const findings: Finding[] = [];
  const commits = new Set(manifests.map((m) => String(m['git_commit'] ?? 'unknown')));
  if (commits.size > 1) {
    findings.push({
      check: 'mixed_code',
      severity: 'warn',
      agent: null,
      message: `agents in this session ran ${commits.size} different commits (${[...commits].map((c) => c.slice(0, 7)).join(', ')}) -- comparisons between them are confounded`,
    });
  }

  const dirty = manifests.filter((m) => Number(m['git_dirty']) === 1).map((m) => String(m['agent_id']));
  if (dirty.length > 0) {
    findings.push({
      check: 'uncommitted_code',
      severity: 'info',
      agent: null,
      message: `${dirty.join(', ')} ran with uncommitted changes -- not reproducible from a commit`,
    });
  }

  return findings;
}

// --- entry point ------------------------------------------------------------

const CHECKS: ReadonlyArray<{ name: string; run: (db: DatabaseSync, o: DoctorOptions) => Finding[] }> = [
  { name: 'code_consistency', run: (db, o) => codeConsistency(db, o.runIds) },
  { name: 'repeated_failure', run: (db, o) => repeatedFailures(db, o.runIds) },
  { name: 'low_success', run: (db, o) => lowSuccess(db, o.runIds) },
  {
    name: 'success_regression',
    run: (db, o) =>
      o.previousRunIds === undefined || o.previousRunIds.length === 0
        ? []
        : successRegression(db, o.runIds, o.previousRunIds),
  },
  { name: 'uncollected_gives', run: (db, o) => uncollectedGives(db, o.runIds) },
  { name: 'hunger', run: (db, o) => hunger(db, o.runIds) },
  { name: 'stuck', run: (db, o) => stuck(db, o.runIds) },
  { name: 'chatter', run: (db, o) => chatter(db, o.runIds) },
  { name: 'deaths', run: (db, o) => deaths(db, o.runIds) },
  { name: 'loop_health', run: (db, o) => loopHealth(db, o.runIds) },
];

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function runDoctor(db: DatabaseSync, options: DoctorOptions): Finding[] {
  if (options.runIds.length === 0) return [];

  const findings: Finding[] = [];
  for (const check of CHECKS) {
    try {
      findings.push(...check.run(db, options));
    } catch (err) {
      findings.push({
        check: check.name,
        severity: 'info',
        agent: null,
        message: `check could not run: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return findings.sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || String(a.agent).localeCompare(String(b.agent)),
  );
}

/** Plain lines, coloured if asked. Shared by the CLI and the agent's shutdown report. */
export function renderFindings(findings: readonly Finding[], colour = true): string[] {
  const c = (code: string, text: string): string => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);

  if (findings.length === 0) {
    return [`  ${c('32', 'healthy')} -- none of the known failure patterns turned up`];
  }

  const badge: Record<Severity, string> = {
    error: c('31', 'ERROR'),
    warn: c('33', 'WARN '),
    info: c('2', 'info '),
  };

  return findings.map(
    (f) => `  ${badge[f.severity]}  ${f.agent === null ? '' : `${f.agent}: `}${f.message} ${c('2', `[${f.check}]`)}`,
  );
}
