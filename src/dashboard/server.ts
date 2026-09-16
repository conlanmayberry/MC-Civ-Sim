#!/usr/bin/env node
/**
 * The dashboard server.
 *
 *     npm run dashboard        then open http://127.0.0.1:25590
 *
 * A separate process from the agents, deliberately. It has to survive agent
 * restarts, show history for agents that have stopped, and eventually watch
 * several at once -- none of which works if it lives inside one agent.
 *
 * It combines two sources:
 *
 *   LIVE   the agent control APIs (position, inventory, spend, hearing), by
 *          scanning a small port range. Only reachable agents appear as live.
 *   PAST   the telemetry database, read-only, for decisions, actions and
 *          anything from a run that has already ended.
 *
 * Zero dependencies: node:http, node:sqlite and hand-written HTML. No build
 * step, consistent with ADR-004 and ADR-009.
 *
 * SECURITY: loopback only, like everything else here (ADR-002). It can stop
 * agents and inject instructions, so it must never be exposed.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { ROOT, loadEnvFile } from '../config.ts';
import { DEFAULT_CONTROL_PORT } from '../agent/control.ts';
import { DEFAULT_DB_PATH } from '../telemetry/index.ts';
import { runDoctor } from '../telemetry/doctor.ts';
import { resolveRuns } from '../telemetry/sessions.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const HOST = '127.0.0.1';

const env = { ...loadEnvFile(), ...process.env };
const PORT = Number(env['DASHBOARD_PORT'] ?? '') > 0 ? Number(env['DASHBOARD_PORT']) : 25590;

/**
 * Agents are found by scanning ports rather than by a registry.
 *
 * A registry would need agents to deregister cleanly on crash, which they
 * cannot be relied on to do -- a stale entry showing a dead agent as live is
 * worse than a 40ms scan.
 */
const SCAN_FROM = DEFAULT_CONTROL_PORT;
const SCAN_COUNT = 8;
const AGENT_TIMEOUT_MS = 2_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// --- live agents -------------------------------------------------------------

interface LiveAgent {
  port: number;
  state: Record<string, unknown>;
}

async function probe(port: number): Promise<LiveAgent | null> {
  try {
    const res = await fetch(`http://${HOST}:${port}/state`, {
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return { port, state: (await res.json()) as Record<string, unknown> };
  } catch {
    return null;
  }
}

async function findAgents(): Promise<LiveAgent[]> {
  const ports = Array.from({ length: SCAN_COUNT }, (_, i) => SCAN_FROM + i);
  const results = await Promise.all(ports.map(probe));
  return results.filter((a): a is LiveAgent => a !== null);
}

/** Forward a POST to one agent's control API. */
async function forward(port: number, endpoint: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`http://${HOST}:${port}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
}

// --- telemetry ---------------------------------------------------------------

const dbPath = env['TELEMETRY_DB'] ?? DEFAULT_DB_PATH;

/**
 * Opened per request rather than held.
 *
 * The agent writes to this database continuously; a long-lived read handle can
 * sit on a stale WAL snapshot and quietly serve old data, which on a dashboard
 * looks like the agent having stopped. Opening per request costs a millisecond
 * and is always current.
 */
function withDb<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
  if (!fs.existsSync(dbPath)) return fallback;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

function query(sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  return withDb(
    (db) => db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>,
    [],
  );
}

/**
 * When any source file was last modified.
 *
 * Cheap enough to do per request (a few dozen stats) and always current,
 * which matters more here than speed: a stale answer would defeat the point.
 */
function newestSourceMtime(): string | null {
  let newest = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          /* a file removed mid-walk is not worth failing the request over */
        }
      }
    }
  };

  walk(path.join(ROOT, 'src'));
  return newest === 0 ? null : new Date(newest).toISOString();
}

const HEALTH_CACHE_MS = 30_000;
let healthCache: { at: number; body: unknown } | null = null;

// --- routes ------------------------------------------------------------------

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const route = url.pathname.replace(/^\/api/, '');

  if (route === '/agents') {
    const agents = await findAgents();
    json(res, 200, {
      agents: agents.map((a) => ({ port: a.port, ...a.state })),
      // When the source last changed, so the dashboard can say that a running
      // agent predates it. A running Node process does not reload edited
      // source, which cost real confusion four separate times in one session:
      // changes were made, behaviour did not change, and nothing anywhere
      // said the agent was still executing the old code.
      codeChangedAt: newestSourceMtime(),
      // Agents that have run before but are not answering now. Being able to
      // inspect a finished run is half the point of the telemetry.
      known: query(
        `SELECT agent_id AS agentId, username, MAX(last_seen) AS lastSeen
         FROM agents GROUP BY agent_id ORDER BY lastSeen DESC`,
      ),
    });
    return true;
  }

  if (route === '/map') {
    const port = Number(url.searchParams.get('port') ?? SCAN_FROM);
    const radius = url.searchParams.get('radius') ?? '20';
    try {
      const upstream = await fetch(`http://${HOST}:${port}/map?radius=${radius}`, {
        signal: AbortSignal.timeout(8_000),
      });
      json(res, 200, upstream.ok ? await upstream.json() : null);
    } catch {
      json(res, 200, null);
    }
    return true;
  }

  if (route === '/decisions') {
    const agentId = url.searchParams.get('agent');
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '25') || 25);
    json(
      res,
      200,
      query(
        `SELECT timestamp, agent_id AS agentId,
                json_extract(data,'$.cycle')    AS cycle,
                json_extract(data,'$.trigger')  AS trigger,
                json_extract(data,'$.summary')  AS summary,
                json_extract(data,'$.tools')    AS tools,
                json_extract(data,'$.costUsd')  AS costUsd,
                json_extract(data,'$.injections') AS injections
         FROM events
         WHERE event_type = 'decision' ${agentId === null ? '' : 'AND agent_id = ?'}
         ORDER BY id DESC LIMIT ${limit}`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  if (route === '/actions') {
    const agentId = url.searchParams.get('agent');
    json(
      res,
      200,
      query(
        `SELECT action, COUNT(*) AS attempts,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
                ROUND(AVG(duration_ms)) AS avgMs
         FROM events
         WHERE action IS NOT NULL ${agentId === null ? '' : 'AND agent_id = ?'}
         GROUP BY action ORDER BY attempts DESC`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  if (route === '/events') {
    const agentId = url.searchParams.get('agent');
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? '40') || 40);
    json(
      res,
      200,
      query(
        `SELECT timestamp, event_type AS eventType, action, ok, error_code AS errorCode,
                x, y, z, data
         FROM events
         WHERE 1=1 ${agentId === null ? '' : 'AND agent_id = ?'}
         ORDER BY id DESC LIMIT ${limit}`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  /** Places the agent has changed the world: the map's points of interest. */
  /**
   * The conversation: what was said to the agent, what it said back, and any
   * operator instructions.
   *
   * Built from telemetry rather than from the agent's own hearing, because an
   * agent does not hear itself -- so its replies exist only in chat_sent, and a
   * log built from hearing alone shows one side of every conversation.
   */
  if (route === '/chat') {
    const agentId = url.searchParams.get('agent');
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '40') || 40);
    json(
      res,
      200,
      query(
        `SELECT timestamp, event_type AS eventType,
                json_extract(data,'$.from')     AS who,
                COALESCE(json_extract(data,'$.message'), json_extract(data,'$.text')) AS text,
                json_extract(data,'$.directed') AS directed
         FROM events
         WHERE event_type IN ('chat_received','chat_sent','thought_injected')
           ${agentId === null ? '' : 'AND agent_id = ?'}
         ORDER BY id DESC LIMIT ${limit}`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  /**
   * What the agent has written down about where things are.
   *
   * Read from the database rather than from the live agent so a finished run
   * can still be inspected -- and because this is the thing you most want to
   * see next to the map: a shelter marked at 1419,-170 with the agent two
   * hundred blocks away explains a great deal at a glance.
   */
  if (route === '/places') {
    const agentId = url.searchParams.get('agent');
    json(
      res,
      200,
      query(
        `SELECT name, x, y, z, dimension, note, updated_at AS updatedAt
         FROM places
         ${agentId === null ? '' : 'WHERE agent_id = ?'}
         ORDER BY updated_at DESC LIMIT 24`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  /**
   * The doctor's findings for the latest session.
   *
   * Cached briefly: it reads the whole session, and the dashboard polls far
   * more often than a session's health actually changes.
   */
  if (route === '/health') {
    const now = Date.now();
    if (healthCache === null || now - healthCache.at > HEALTH_CACHE_MS) {
      healthCache = {
        at: now,
        body: withDb((db) => {
          const runs = resolveRuns(db, 'latest');
          return {
            runs: runs.map((r) => ({ runId: r.runId, agentId: r.agentId, decisions: r.decisions })),
            findings: runDoctor(db, {
              runIds: runs.map((r) => r.runId),
              previousRunIds: resolveRuns(db, 'previous').map((r) => r.runId),
            }),
          };
        }, { runs: [], findings: [] }),
      };
    }
    json(res, 200, healthCache.body);
    return true;
  }

  if (route === '/marks') {
    const agentId = url.searchParams.get('agent');
    json(
      res,
      200,
      query(
        `SELECT event_type AS eventType, x, y, z, timestamp
         FROM events
         WHERE event_type IN ('block_mined','block_placed','death')
           AND ok IS NOT 0 AND x IS NOT NULL
           ${agentId === null ? '' : 'AND agent_id = ?'}
         ORDER BY id DESC LIMIT 250`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  /** Where the agent has been, from snapshots. */
  if (route === '/trail') {
    const agentId = url.searchParams.get('agent');
    json(
      res,
      200,
      query(
        `SELECT x, y, z, timestamp, reason
         FROM snapshots
         WHERE x IS NOT NULL ${agentId === null ? '' : 'AND agent_id = ?'}
         ORDER BY id DESC LIMIT 200`,
        agentId === null ? [] : [agentId],
      ),
    );
    return true;
  }

  if (req.method === 'POST' && (route === '/say' || route === '/tell' || route === '/stop')) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = (raw === '' ? {} : JSON.parse(raw)) as { port?: number; text?: string };

    const port = Number(body.port ?? SCAN_FROM);
    const endpoint = route.slice(1);
    const upstream = await forward(port, endpoint, {
      text: body.text ?? '',
      from: 'dashboard',
    });

    if (upstream === null) {
      json(res, 502, { error: 'agent did not respond' });
      return true;
    }
    json(res, upstream.status, await upstream.json().catch(() => ({ ok: upstream.ok })));
    return true;
  }

  return false;
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, requested);

  // Never serve outside the public directory, whatever the request says.
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err !== null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (!handled) json(res, 404, { error: 'unknown endpoint' });
        return;
      }
      serveStatic(res, url.pathname);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`\x1b[1m  MC-Civ-Sim dashboard\x1b[0m`);
  console.log(`  \x1b[36mhttp://${HOST}:${PORT}\x1b[0m`);
  console.log(`  \x1b[2mreading ${path.relative(ROOT, dbPath)}\x1b[0m`);
  console.log(`  \x1b[2mscanning agent ports ${SCAN_FROM}-${SCAN_FROM + SCAN_COUNT - 1}\x1b[0m`);
  console.log('');
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
