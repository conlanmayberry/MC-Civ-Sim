#!/usr/bin/env node
/**
 * Telemetry inspection CLI.
 *
 *     npm run telemetry                 overview of every run
 *     npm run telemetry timeline [n]    what happened, in order
 *     npm run telemetry actions         what was attempted, and how it went
 *     npm run telemetry inventory       state snapshots over time
 *     npm run telemetry errors          what failed, and why
 *     npm run telemetry latency [all]   how long the agent takes to respond
 *     npm run telemetry compare [all]   agents side by side: cost, work, talk
 *     npm run telemetry report [spec]   one session, end to end (latest|previous|all|<run>)
 *     npm run telemetry doctor [spec]   known failure patterns (latest|previous|all|<run>)
 *     npm run telemetry sql "SELECT..." anything else
 *
 * The subcommands exist to answer the six questions the project brief sets as
 * Stage 4's success criterion -- what did the bot do, when, where, did it
 * succeed, what was it carrying at important moments, and how long did actions
 * take. `sql` is there because a research database whose only interface is
 * canned reports is not much of a research database.
 *
 * Read-only: it opens the same file the bot is writing to, which WAL makes safe.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import { DEFAULT_DB_PATH } from './index.ts';
import { renderFindings, runDoctor } from './doctor.ts';
import { buildReport, renderReport } from './report.ts';
import { resolveRuns } from './sessions.ts';
import type { ChatEventRow, Reply, Unanswered } from './latency.ts';
import { distribution, pairReplies, percentile, secs, triggerKind } from './latency.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const dbPath = process.env['TELEMETRY_DB'] ?? DEFAULT_DB_PATH;

if (!fs.existsSync(dbPath)) {
  console.error(`\n  No telemetry database at ${dbPath}`);
  console.error(`  ${DIM}Run the bot first: npm run bot${RESET}\n`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

type Row = Record<string, unknown>;

function query(sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}

/** Renders rows as an aligned table, which is most of what a CLI like this is. */
function table(rows: Row[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log(`  ${DIM}(no rows)${RESET}`);
    return;
  }
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const text = rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))));
  const widths = cols.map((c, i) =>
    Math.min(46, Math.max(c.length, ...text.map((t) => (t[i] ?? '').length))),
  );

  const line = (cells: string[]): string =>
    '  ' + cells.map((cell, i) => cell.slice(0, widths[i]).padEnd(widths[i] ?? 0)).join('  ');

  console.log(`${BOLD}${line(cols)}${RESET}`);
  console.log(`  ${DIM}${widths.map((w) => '-'.repeat(w)).join('  ')}${RESET}`);
  for (const row of text) console.log(line(row));
}

const [subcommand = 'summary', ...args] = process.argv.slice(2);

console.log('');

switch (subcommand) {
  case 'summary': {
    console.log(`${BOLD}  Runs${RESET} ${DIM}${dbPath}${RESET}`);
    table(
      query(`
        SELECT r.run_id,
               substr(r.started_at, 1, 19) AS started,
               COALESCE(substr(r.ended_at, 1, 19), '(open)') AS ended,
               r.minecraft_version AS version,
               (SELECT COUNT(*) FROM events e WHERE e.run_id = r.run_id) AS events,
               (SELECT COUNT(*) FROM snapshots s WHERE s.run_id = r.run_id) AS snapshots
        FROM runs r ORDER BY r.started_at DESC LIMIT 20
      `),
    );

    console.log('');
    console.log(`${BOLD}  Agents${RESET}`);
    table(
      query(`
        SELECT agent_id, username, substr(uuid, 1, 13) AS uuid,
               substr(first_seen, 1, 19) AS first_seen,
               substr(last_seen, 1, 19) AS last_seen
        FROM agents ORDER BY last_seen DESC
      `),
    );

    console.log('');
    console.log(`${BOLD}  Events by type${RESET}`);
    table(
      query(`
        SELECT event_type, COUNT(*) AS count,
               SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
        FROM events GROUP BY event_type ORDER BY count DESC
      `),
    );
    break;
  }

  case 'timeline': {
    // "What did the bot do, when, and where" in one view.
    const limit = Number(args[0] ?? 40);
    console.log(`${BOLD}  Timeline${RESET} ${DIM}most recent ${limit}${RESET}`);
    table(
      query(
        `SELECT substr(timestamp, 12, 8) AS time,
                agent_id AS agent,
                event_type AS event,
                COALESCE(action, '') AS action,
                CASE WHEN ok IS NULL THEN '' WHEN ok = 1 THEN 'ok' ELSE 'FAIL' END AS result,
                COALESCE(error_code, '') AS error,
                CASE WHEN x IS NULL THEN '' ELSE
                  CAST(CAST(x AS INT) AS TEXT) || ',' || CAST(CAST(y AS INT) AS TEXT) || ',' || CAST(CAST(z AS INT) AS TEXT)
                END AS location,
                substr(data, 1, 44) AS data
         FROM events ORDER BY id DESC LIMIT ?`,
        limit,
      ),
    );
    break;
  }

  case 'actions': {
    // "Did it succeed, and how long did it take."
    console.log(`${BOLD}  Actions${RESET}`);
    table(
      query(`
        SELECT action,
               COUNT(*) AS attempts,
               SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
               SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
               ROUND(100.0 * SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct,
               ROUND(AVG(duration_ms)) AS avg_ms,
               MAX(duration_ms) AS max_ms
        FROM events WHERE action IS NOT NULL
        GROUP BY action ORDER BY attempts DESC
      `),
    );
    break;
  }

  case 'errors': {
    console.log(`${BOLD}  Failures by error code${RESET}`);
    table(
      query(`
        SELECT COALESCE(error_code, '(none)') AS error_code,
               COALESCE(action, '(n/a)') AS action,
               COUNT(*) AS count
        FROM events WHERE ok = 0
        GROUP BY error_code, action ORDER BY count DESC
      `),
    );
    console.log('');
    console.log(`${BOLD}  Most recent failures${RESET}`);
    table(
      query(`
        SELECT substr(timestamp, 12, 8) AS time,
               COALESCE(action, event_type) AS what,
               COALESCE(error_code, '') AS code,
               substr(COALESCE(json_extract(data, '$.message'), ''), 1, 60) AS message
        FROM events WHERE ok = 0 ORDER BY id DESC LIMIT 15
      `),
    );
    break;
  }

  case 'inventory': {
    // "What was the bot carrying at important times."
    console.log(`${BOLD}  Snapshots${RESET}`);
    table(
      query(`
        SELECT substr(timestamp, 12, 8) AS time,
               agent_id AS agent,
               reason,
               CAST(CAST(x AS INT) AS TEXT) || ',' || CAST(CAST(y AS INT) AS TEXT) || ',' || CAST(CAST(z AS INT) AS TEXT) AS location,
               health, food,
               (SELECT COUNT(*) FROM json_each(inventory)) AS stacks,
               substr(inventory, 1, 50) AS items
        FROM snapshots ORDER BY id DESC LIMIT 25
      `),
    );
    break;
  }

  case 'latency': {
    // How long the agent leaves somebody waiting -- the number that decides
    // whether it reads as present or absent. Broken into what the wait is
    // actually made of: waiting for the clock, thinking, and acting first.
    const scope = args[0] ?? 'last';
    const runs =
      scope === 'all'
        ? query(`SELECT run_id FROM runs ORDER BY started_at`).map((r) => String(r['run_id']))
        : query(`SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1`).map((r) =>
            String(r['run_id']),
          );

    if (runs.length === 0) {
      console.log(`  ${DIM}(no runs yet)${RESET}`);
      break;
    }

    const usernames = new Map(
      query(`SELECT agent_id, username FROM agents`).map((r) => [
        String(r['agent_id']),
        String(r['username']),
      ]),
    );

    const perRun: Row[] = [];
    const allReplies: Reply[] = [];
    const allUnanswered: Unanswered[] = [];

    for (const runId of runs) {
      const agents = query(
        `SELECT DISTINCT agent_id FROM events WHERE run_id = ? AND agent_id IS NOT NULL`,
        runId,
      ).map((r) => String(r['agent_id']));

      const runReplies: Reply[] = [];
      for (const agentId of agents) {
        const chat = query(
          `SELECT timestamp, event_type, data FROM events
           WHERE run_id = ? AND agent_id = ? AND event_type IN ('chat_received', 'chat_sent')
           ORDER BY id`,
          runId,
          agentId,
        );
        const { replies, unanswered } = pairReplies(
          chat as unknown as ChatEventRow[],
          usernames.get(agentId) ?? agentId,
        );
        runReplies.push(...replies);
        allUnanswered.push(...unanswered);
      }
      allReplies.push(...runReplies);

      const think = query(
        `SELECT duration_ms FROM events
         WHERE run_id = ? AND event_type = 'decision' AND duration_ms IS NOT NULL`,
        runId,
      )
        .map((r) => Number(r['duration_ms']))
        .sort((a, b) => a - b);

      const waits = runReplies.map((r) => r.waitedMs).sort((a, b) => a - b);
      perRun.push({
        run: runId,
        replies: runReplies.length,
        reply_p50: waits.length === 0 ? '' : secs(percentile(waits, 50)),
        reply_max: waits.length === 0 ? '' : secs(waits.at(-1) ?? 0),
        decisions: think.length,
        think_p50: think.length === 0 ? 'n/a' : secs(percentile(think, 50)),
      });
    }

    if (scope === 'all') {
      // One row per run, so a change made between runs shows up as a change.
      console.log(`${BOLD}  Response time by run${RESET} ${DIM}oldest first${RESET}`);
      table(perRun);
      console.log('');
    }

    console.log(`${BOLD}  Reply latency${RESET} ${DIM}somebody speaks -> the agent answers${RESET}`);
    table([
      distribution('addressed by name', allReplies.filter((r) => r.directed).map((r) => r.waitedMs)),
      distribution('spoken to nearby', allReplies.filter((r) => !r.directed).map((r) => r.waitedMs)),
      distribution('all', allReplies.map((r) => r.waitedMs)),
    ]);

    if (allUnanswered.length > 0) {
      console.log('');
      console.log(
        `${BOLD}  Never answered${RESET} ${RED}${allUnanswered.length}${RESET}` +
          ` ${DIM}(silence can be a decision -- worth checking it was a deliberate one)${RESET}`,
      );
      table(
        allUnanswered.slice(-8).map((m) => ({
          time: m.at.slice(11, 19),
          from: m.from,
          named: m.directed ? 'yes' : '',
          message: m.text.slice(0, 50),
        })),
      );
    }

    const slowest = [...allReplies].sort((a, b) => b.waitedMs - a.waitedMs).slice(0, 6);
    if (slowest.length > 0) {
      console.log('');
      console.log(`${BOLD}  Slowest replies${RESET}`);
      table(
        slowest.map((r) => ({
          asked: new Date(r.askedAt).toISOString().slice(11, 19),
          waited: secs(r.waitedMs),
          named: r.directed ? 'yes' : '',
          msgs: r.burst,
          from: r.from,
          message: r.text.slice(0, 44),
        })),
      );
    }

    // What the wait was spent on. Thinking is dead air by design; waiting for
    // the clock is the part that is cheap to fix.
    const placeholders = runs.map(() => '?').join(', ');
    const decisions = query(
      `SELECT duration_ms, json_extract(data, '$.trigger') AS trigger
       FROM events WHERE event_type = 'decision' AND run_id IN (${placeholders})
       ORDER BY id`,
      ...runs,
    );

    const byTrigger = new Map<string, number[]>();
    for (const row of decisions) {
      if (row['duration_ms'] === null) continue;
      const kind = triggerKind(String(row['trigger'] ?? 'interval'));
      const list = byTrigger.get(kind) ?? [];
      list.push(Number(row['duration_ms']));
      byTrigger.set(kind, list);
    }

    console.log('');
    if (byTrigger.size === 0) {
      console.log(
        `${BOLD}  Thinking time${RESET} ${DIM}not recorded before this was added -- ` +
          `start a fresh run to collect it${RESET}`,
      );
    } else {
      console.log(`${BOLD}  Thinking time${RESET} ${DIM}model latency, by what woke it${RESET}`);
      table(
        [...byTrigger.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([kind, samples]) => distribution(kind, samples)),
      );
    }

    break;
  }

  case 'compare': {
    // Agents side by side.
    //
    // Exists for the question you cannot answer by looking at the world: with
    // one agent on a stronger model and the rest as a control, "is it actually
    // better" needs the same numbers for each of them, from the same window,
    // or it is just an impression. Defaults to the newest run per agent, since
    // that is the current experiment rather than the whole history.
    const scope = args[0] ?? 'last';

    const agents = query(
      `SELECT DISTINCT agent_id FROM events WHERE agent_id IS NOT NULL`,
    ).map((r) => String(r['agent_id']));

    if (agents.length === 0) {
      console.log(`  ${DIM}(no agents have run yet)${RESET}`);
      break;
    }

    const rows: Row[] = [];

    for (const agentId of agents) {
      // One run each, or everything the agent has ever done.
      const runs =
        scope === 'all'
          ? query(`SELECT DISTINCT run_id FROM events WHERE agent_id = ?`, agentId).map((r) =>
              String(r['run_id']),
            )
          : query(
              `SELECT run_id FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT 1`,
              agentId,
            ).map((r) => String(r['run_id']));

      if (runs.length === 0) continue;
      const holes = runs.map(() => '?').join(', ');

      const decisions = query(
        `SELECT timestamp, duration_ms,
                json_extract(data,'$.costUsd') AS cost,
                json_extract(data,'$.model')   AS model,
                json_extract(data,'$.trigger') AS trigger
         FROM events
         WHERE agent_id = ? AND event_type = 'decision' AND run_id IN (${holes})
         ORDER BY id`,
        agentId, ...runs,
      );

      if (decisions.length === 0) continue;

      const first = Date.parse(String(decisions[0]?.['timestamp']));
      const last = Date.parse(String(decisions.at(-1)?.['timestamp']));
      const hours = Math.max((last - first) / 3_600_000, 1 / 3_600_000);

      const spend = decisions.reduce((sum, d) => sum + Number(d['cost'] ?? 0), 0);
      const think = decisions
        .map((d) => Number(d['duration_ms']))
        .filter((n) => Number.isFinite(n) && n > 0);

      const count = (sql: string, ...params: unknown[]): number =>
        Number(query(sql, ...params)[0]?.['n'] ?? 0);

      const acted = count(
        `SELECT COUNT(*) n FROM events WHERE agent_id = ? AND action IS NOT NULL AND run_id IN (${holes})`,
        agentId, ...runs,
      );
      const actedOk = count(
        `SELECT COUNT(*) n FROM events WHERE agent_id = ? AND ok = 1 AND action IS NOT NULL AND run_id IN (${holes})`,
        agentId, ...runs,
      );

      // Placements are the closest thing to "did it build", and completed
      // structures are not something the database knows -- so this is a proxy,
      // and an honest one only alongside actually looking at the world.
      const placed = count(
        `SELECT COUNT(*) n FROM events WHERE agent_id = ? AND event_type = 'block_placed' AND ok = 1 AND json_extract(data, '$.alreadyThere') IS NULL AND COALESCE(action, 'place_block') = 'place_block' AND run_id IN (${holes})`,
        agentId, ...runs,
      );

      rows.push({
        agent: agentId,
        model: String(decisions[0]?.['model'] ?? '?').replace(/^gpt-/, ''),
        mins: (hours * 60).toFixed(0),
        turns: decisions.length,
        'turns/h': Math.round(decisions.length / hours),
        think_p50: think.length === 0 ? '' : secs(percentile(think, 50)),
        acted,
        'act%': acted === 0 ? '' : Math.round((100 * actedOk) / acted),
        placed,
        said: count(
          `SELECT COUNT(*) n FROM events WHERE agent_id = ? AND event_type = 'chat_sent' AND run_id IN (${holes})`,
          agentId, ...runs,
        ),
        died: count(
          `SELECT COUNT(*) n FROM events WHERE agent_id = ? AND event_type = 'death' AND run_id IN (${holes})`,
          agentId, ...runs,
        ),
        places: count(
          `SELECT COUNT(DISTINCT json_extract(data,'$.name')) n FROM events
           WHERE agent_id = ? AND event_type = 'place_remembered' AND run_id IN (${holes})`,
          agentId, ...runs,
        ),
        usd: spend.toFixed(4),
        'usd/h': (spend / hours).toFixed(2),
      });
    }

    console.log(
      `${BOLD}  Agents side by side${RESET} ` +
        `${DIM}${scope === 'all' ? 'every run' : 'each agent\'s most recent run'}${RESET}`,
    );
    table(rows.sort((a, b) => String(a['agent']).localeCompare(String(b['agent']))));

    console.log('');
    console.log(
      `  ${DIM}placed = successful block placements, a PROXY for building: the database` +
        ` cannot see whether\n  anything was finished or whether it looks like anything.` +
        ` Read it next to the world, not instead of it.${RESET}`,
    );

    break;
  }

  case 'report': {
    // Everything that mattered about one session, in one screen: where the
    // time went, what killed them, what they ate, what keeps failing.
    const spec = args[0] ?? 'latest';
    const runs = resolveRuns(db, spec);
    if (runs.length === 0) {
      console.log(`  ${DIM}(no runs match "${spec}")${RESET}`);
      break;
    }
    for (const line of renderReport(buildReport(db, runs))) console.log(line);
    console.log('');
    break;
  }

  case 'doctor': {
    // Known failure patterns, checked. See doctor.ts for why each exists.
    const spec = args[0] ?? 'latest';
    const runs = resolveRuns(db, spec);
    if (runs.length === 0) {
      console.log(`  ${DIM}(no runs match "${spec}")${RESET}`);
      break;
    }

    // "Did this get worse" only makes sense against the session before this
    // one, so regression checks run for the latest session only.
    const previous = spec === 'latest' ? resolveRuns(db, 'previous') : [];
    const findings = runDoctor(db, {
      runIds: runs.map((r) => r.runId),
      previousRunIds: previous.map((r) => r.runId),
    });

    console.log(
      `${BOLD}  Doctor${RESET} ${DIM}${spec} -- ${runs.map((r) => `${r.agentId} (${r.decisions} turns)`).join(', ')}${RESET}`,
    );
    for (const line of renderFindings(findings)) console.log(line);

    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warn').length;
    console.log('');
    console.log(`  ${DIM}${errors} error(s), ${warnings} warning(s)${RESET}`);
    // Non-zero on errors, so a script or a scenario batch can act on it.
    if (errors > 0) process.exitCode = 1;
    break;
  }

  case 'sql': {
    const sql = args.join(' ');
    if (sql === '') {
      console.error('  Usage: npm run telemetry sql "SELECT ..."');
      process.exit(1);
    }
    if (!/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
      // Opened read-only, so a write would fail anyway -- but failing here
      // gives a clear reason instead of an SQLite error.
      console.error('  Only read queries are allowed here.');
      process.exit(1);
    }
    table(query(sql));
    break;
  }

  default:
    console.error(`  Unknown subcommand "${subcommand}".`);
    console.error(
      `  ${DIM}summary | timeline [n] | actions | errors | inventory | latency [all] | compare [all] | doctor [spec] | sql "..."${RESET}`,
    );
    process.exit(1);
}

console.log('');
db.close();
