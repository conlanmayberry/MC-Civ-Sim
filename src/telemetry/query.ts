#!/usr/bin/env node
/**
 * Telemetry inspection CLI.
 *
 *     npm run telemetry                 overview of every run
 *     npm run telemetry timeline [n]    what happened, in order
 *     npm run telemetry actions         what was attempted, and how it went
 *     npm run telemetry inventory       state snapshots over time
 *     npm run telemetry errors          what failed, and why
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
    console.error(`  ${DIM}summary | timeline [n] | actions | errors | inventory | sql "..."${RESET}`);
    process.exit(1);
}

console.log('');
db.close();
