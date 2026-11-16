/**
 * The whole story of one session, in one screen.
 *
 * The doctor answers "what is broken"; compare answers "how did the agents
 * differ". Neither answers "what happened", which is the question actually
 * asked after every run -- and answering it by hand meant a dozen ad-hoc SQL
 * queries, twice, on 2026-09-16 and again on 2026-09-22. Both times the
 * biggest finding was one those queries were not looking for: 28 of 33 deaths
 * by drowning the first time, and 40% of all agent time spent stuck in one
 * spot the second.
 *
 * So the numbers here are the ones that turned out to matter, including the
 * ones that only matter when they are bad: where the time went, what killed
 * them, what they ate, and which failures repeat.
 */

import type { DatabaseSync } from 'node:sqlite';

import { normaliseMessage } from './doctor.ts';
import type { RunInfo } from './sessions.ts';

/** How far an agent can wander and still count as standing in one spot. */
const STUCK_RADIUS = 4;
/** Shortest stay in one spot worth calling stuck. */
const STUCK_MIN_MS = 10 * 60_000;

type Row = Record<string, unknown>;

export interface Stay {
  agent: string;
  from: string;
  to: string;
  minutes: number;
  x: number;
  y: number;
  z: number;
}

export interface SessionReport {
  runIds: string[];
  agents: string[];
  startedAt: string | null;
  endedAt: string | null;
  minutes: number;
  commits: string[];
  dirty: boolean;
  costUsd: number;
  decisions: number;
  chatSent: number;
  deathsByCause: Array<{ cause: string; count: number }>;
  deathsByAgent: Array<{ agent: string; count: number }>;
  stays: Stay[];
  stuckShare: number;
  actions: Array<{ action: string; attempts: number; ok: number; pct: number }>;
  repeatedFailures: Array<{ action: string; message: string; count: number }>;
  eaten: Array<{ item: string; count: number }>;
  kills: Array<{ target: string; count: number }>;
  reflexes: Array<{ outcome: string; count: number }>;
}

function rows(db: DatabaseSync, sql: string, params: readonly unknown[] = []): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}

function holes(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/**
 * Stretches an agent spent within STUCK_RADIUS of where it was.
 *
 * Deliberately naive -- a greedy sweep from each starting point rather than
 * the largest possible window -- because the question is "was it going
 * anywhere", and being off by a minute either way does not change the answer.
 */
export function longStays(
  snapshots: ReadonlyArray<{ agent: string; at: number; x: number; y: number; z: number }>,
  minMs = STUCK_MIN_MS,
): Stay[] {
  const byAgent = new Map<string, Array<{ agent: string; at: number; x: number; y: number; z: number }>>();
  for (const s of snapshots) {
    const list = byAgent.get(s.agent) ?? [];
    list.push(s);
    byAgent.set(s.agent, list);
  }

  const stays: Stay[] = [];
  for (const [agent, list] of byAgent) {
    list.sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < list.length) {
      const start = list[i];
      if (start === undefined) break;
      let j = i;
      while (j + 1 < list.length) {
        const next = list[j + 1];
        if (next === undefined) break;
        if (Math.hypot(next.x - start.x, next.z - start.z) > STUCK_RADIUS) break;
        j++;
      }
      const end = list[j] ?? start;
      const ms = end.at - start.at;
      if (ms >= minMs) {
        stays.push({
          agent,
          from: new Date(start.at).toISOString(),
          to: new Date(end.at).toISOString(),
          minutes: Math.round(ms / 60_000),
          x: Math.round(start.x),
          y: Math.round(start.y),
          z: Math.round(start.z),
        });
      }
      i = j + 1;
    }
  }
  return stays.sort((a, b) => b.minutes - a.minutes);
}

export function buildReport(db: DatabaseSync, runs: readonly RunInfo[]): SessionReport {
  const runIds = [...new Set(runs.map((r) => r.runId))];
  const q = holes(runIds.length);
  const agents = [...new Set(runs.map((r) => r.agentId))].sort();

  const span = rows(db, `SELECT MIN(timestamp) a, MAX(timestamp) b FROM events WHERE run_id IN (${q})`, runIds)[0];
  const startedAt = span?.['a'] === undefined || span['a'] === null ? null : String(span['a']);
  const endedAt = span?.['b'] === undefined || span['b'] === null ? null : String(span['b']);
  const minutes =
    startedAt === null || endedAt === null ? 0 : Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);

  const manifests = rows(
    db,
    `SELECT DISTINCT git_commit, git_dirty FROM run_manifests WHERE run_id IN (${q})`,
    runIds,
  );
  const commits = manifests
    .map((m) => (m['git_commit'] === null || m['git_commit'] === undefined ? '' : String(m['git_commit']).slice(0, 7)))
    .filter((c) => c !== '');
  const dirty = manifests.some((m) => Number(m['git_dirty']) === 1);

  const totals = rows(
    db,
    `SELECT COUNT(*) decisions, COALESCE(SUM(json_extract(data, '$.costUsd')), 0) cost
       FROM events WHERE event_type = 'decision' AND run_id IN (${q})`,
    runIds,
  )[0];

  const chat = rows(
    db,
    `SELECT COUNT(*) n FROM events WHERE event_type = 'chat_sent' AND run_id IN (${q})`,
    runIds,
  )[0];

  const deathRows = rows(
    db,
    `SELECT agent_id, COALESCE(json_extract(data, '$.cause'), 'cause not recorded') cause
       FROM events WHERE event_type = 'death' AND run_id IN (${q})`,
    runIds,
  );
  const tally = (list: string[]): Array<[string, number]> => {
    const counts = new Map<string, number>();
    for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };

  const snapshots = rows(
    db,
    `SELECT agent_id, timestamp, x, y, z FROM snapshots WHERE run_id IN (${q}) AND x IS NOT NULL ORDER BY timestamp`,
    runIds,
  ).map((r) => ({
    agent: String(r['agent_id']),
    at: Date.parse(String(r['timestamp'])),
    x: Number(r['x']),
    y: Number(r['y']),
    z: Number(r['z']),
  }));
  const stays = longStays(snapshots);
  const stuckMinutes = stays.reduce((sum, s) => sum + s.minutes, 0);
  const agentMinutes = minutes * Math.max(1, agents.length);

  const actions = rows(
    db,
    `SELECT action, COUNT(*) attempts, SUM(ok) ok FROM events
      WHERE action IS NOT NULL AND run_id IN (${q}) GROUP BY action ORDER BY attempts DESC`,
    runIds,
  ).map((r) => ({
    action: String(r['action']),
    attempts: Number(r['attempts']),
    ok: Number(r['ok']),
    pct: Math.round((100 * Number(r['ok'])) / Math.max(1, Number(r['attempts']))),
  }));

  const failures = new Map<string, { action: string; message: string; count: number }>();
  for (const row of rows(
    db,
    `SELECT action, json_extract(data, '$.message') message FROM events
      WHERE ok = 0 AND action IS NOT NULL AND run_id IN (${q})`,
    runIds,
  )) {
    const action = String(row['action']);
    const message = normaliseMessage(String(row['message'] ?? ''));
    const key = `${action}|${message}`;
    const entry = failures.get(key) ?? { action, message, count: 0 };
    entry.count++;
    failures.set(key, entry);
  }

  const eaten = rows(
    db,
    `SELECT json_extract(data, '$.item') item, COUNT(*) n FROM events
      WHERE event_type = 'item_consumed' AND ok IS NOT 0 AND json_extract(data, '$.item') IS NOT NULL
        AND run_id IN (${q}) GROUP BY item ORDER BY n DESC`,
    runIds,
  ).map((r) => ({ item: String(r['item']), count: Number(r['n']) }));

  const kills = rows(
    db,
    `SELECT json_extract(data, '$.target') target, COUNT(*) n FROM events
      WHERE action = 'attack_entity' AND ok = 1 AND run_id IN (${q}) GROUP BY target ORDER BY n DESC`,
    runIds,
  ).map((r) => ({ target: String(r['target'] ?? 'unknown'), count: Number(r['n']) }));

  const reflexes = rows(
    db,
    `SELECT json_extract(data, '$.outcome') outcome, COUNT(*) n FROM events
      WHERE event_type = 'reflex' AND run_id IN (${q}) GROUP BY outcome ORDER BY n DESC`,
    runIds,
  ).map((r) => ({ outcome: String(r['outcome'] ?? 'unknown'), count: Number(r['n']) }));

  return {
    runIds,
    agents,
    startedAt,
    endedAt,
    minutes,
    commits: [...new Set(commits)],
    dirty,
    costUsd: Number(totals?.['cost'] ?? 0),
    decisions: Number(totals?.['decisions'] ?? 0),
    chatSent: Number(chat?.['n'] ?? 0),
    deathsByCause: tally(deathRows.map((d) => String(d['cause']))).map(([cause, count]) => ({ cause, count })),
    deathsByAgent: tally(deathRows.map((d) => String(d['agent_id']))).map(([agent, count]) => ({ agent, count })),
    stays,
    stuckShare: agentMinutes === 0 ? 0 : stuckMinutes / agentMinutes,
    actions,
    repeatedFailures: [...failures.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    eaten,
    kills,
    reflexes,
  };
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function bar(share: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

/** The report as lines, ready to print. Colour off for anything but a terminal. */
export function renderReport(report: SessionReport, colour = true): string[] {
  const c = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);
  const out: string[] = [];
  const hours = report.minutes / 60;
  const perAgentHour = (n: number): string => (hours === 0 ? '-' : (n / (hours * Math.max(1, report.agents.length))).toFixed(1));

  out.push(
    `${c(BOLD, '  Session')} ${c(DIM, `${report.agents.join(', ')} -- ${report.minutes} min, ${report.decisions} turns, $${report.costUsd.toFixed(2)}`)}`,
  );
  out.push(
    c(
      DIM,
      `  ${report.startedAt?.slice(0, 16).replace('T', ' ') ?? '?'} to ${report.endedAt?.slice(11, 16) ?? '?'}` +
        `  code ${report.commits.join(', ') || 'unknown'}${report.dirty ? c(YELLOW, ' + uncommitted changes') : ''}`,
    ),
  );
  out.push('');

  out.push(`  ${c(BOLD, 'Where the time went')}`);
  out.push(
    `    stuck in one spot  ${bar(report.stuckShare)} ${(report.stuckShare * 100).toFixed(0)}% of agent time` +
      (report.stuckShare > 0.2 ? c(RED, '  <- worth looking at') : ''),
  );
  for (const stay of report.stays.slice(0, 5)) {
    out.push(c(DIM, `      ${stay.agent} ${stay.minutes} min at ${stay.x},${stay.y},${stay.z} (from ${stay.from.slice(11, 16)})`));
  }
  out.push(c(DIM, `    ${perAgentHour(report.decisions)} turns and ${perAgentHour(report.chatSent)} messages per agent-hour`));
  out.push('');

  out.push(`  ${c(BOLD, 'Deaths')} ${c(DIM, `${report.deathsByCause.reduce((n, d) => n + d.count, 0)} in ${report.minutes} min`)}`);
  if (report.deathsByCause.length === 0) out.push(c(DIM, '    none'));
  for (const death of report.deathsByCause) {
    out.push(`    ${String(death.count).padStart(3)}  ${death.cause}`);
  }
  if (report.deathsByAgent.length > 0) {
    out.push(c(DIM, `    by agent: ${report.deathsByAgent.map((d) => `${d.agent} ${d.count}`).join(', ')}`));
  }
  out.push('');

  out.push(`  ${c(BOLD, 'Actions')}`);
  for (const action of report.actions) {
    const flag = action.attempts >= 20 && action.pct < 50 ? c(RED, ' <- mostly fails') : '';
    out.push(
      `    ${action.action.padEnd(15)} ${String(action.ok).padStart(4)}/${String(action.attempts).padEnd(5)} ${bar(action.pct / 100, 10)} ${String(action.pct).padStart(3)}%${flag}`,
    );
  }
  out.push('');

  if (report.repeatedFailures.length > 0) {
    out.push(`  ${c(BOLD, 'What failed most')}`);
    for (const failure of report.repeatedFailures) {
      out.push(`    ${String(failure.count).padStart(3)}  ${failure.action}: ${c(DIM, failure.message.slice(0, 90))}`);
    }
    out.push('');
  }

  const food = report.eaten.reduce((n, e) => n + e.count, 0);
  out.push(`  ${c(BOLD, 'Food and fighting')}`);
  out.push(
    `    ate ${food} item(s)${food === 0 ? '' : `: ${report.eaten.map((e) => `${e.count}x ${e.item}`).join(', ')}`}` +
      (hours > 0 && food / (hours * Math.max(1, report.agents.length)) < 1 ? c(YELLOW, '  <- barely eating') : ''),
  );
  out.push(
    `    killed ${report.kills.reduce((n, k) => n + k.count, 0)}${report.kills.length === 0 ? '' : `: ${report.kills.map((k) => `${k.count}x ${k.target}`).join(', ')}`}`,
  );
  if (report.reflexes.length > 0) {
    out.push(`    reflexes: ${report.reflexes.map((r) => `${r.count} ${r.outcome}`).join(', ')}`);
  }

  return out;
}
