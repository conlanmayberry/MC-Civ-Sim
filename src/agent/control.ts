/**
 * A small local control server, so agents can be talked to from outside the game.
 *
 * Until now the only way to reach an agent was Minecraft chat, which means
 * launching the client and standing next to it. This exposes the same channels
 * over loopback HTTP: say something, inject a thought, read state, stop.
 *
 * It is deliberately built now rather than with the dashboard, because the
 * dashboard needs exactly these endpoints and this way they get exercised by a
 * CLI first -- a much faster way to find out the shape is wrong.
 *
 * SECURITY: binds to 127.0.0.1 only, same posture as the Minecraft server
 * (ADR-002). There is no authentication because there is no remote access; if
 * this is ever bound to a real interface it needs one, and the bind address is
 * hard-coded to make that a deliberate act rather than a config slip.
 */

import http from 'node:http';

import type { Logger } from '../util/log.ts';

export const DEFAULT_CONTROL_PORT = 25580;
const HOST = '127.0.0.1';
/** Refuse absurd bodies rather than buffering them. */
const MAX_BODY_BYTES = 8 * 1024;

export interface ControlState {
  agentId: string;
  username: string;
  description: string;
  traits: string[];
  interests: string[];
  values: string[];
  cycles: number;
  goal: string | null;
  spentUsd: number;
  budgetUsd: number;
  model: string;
  running: boolean;
  pendingInjections: number;
  recentlyHeard: unknown[];
  /** Null before the bot has spawned. */
  self: unknown;
  inventory: unknown;
  nearbyEntities: unknown;
  startedAt: string;
}

export interface ControlHandlers {
  /** Say something out loud in Minecraft, as the agent would hear a person. */
  say: (from: string, text: string) => void;
  /** Queue an operator instruction for the next decision. */
  inject: (from: string, text: string) => boolean;
  state: () => ControlState;
  /** Top-down surface view. Expensive, so the dashboard polls it rarely. */
  map: (radius: number) => unknown;
  stop: (reason: string) => void;
}

export interface ControlServer {
  port: number;
  close: () => void;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function startControlServer(
  handlers: ControlHandlers,
  log: Logger,
  port = DEFAULT_CONTROL_PORT,
): Promise<ControlServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${HOST}`);

      try {
        if (req.method === 'GET' && url.pathname === '/state') {
          json(res, 200, handlers.state());
          return;
        }

        if (req.method === 'GET' && url.pathname === '/map') {
          const requested = Number(url.searchParams.get('radius') ?? '20');
          // Cost is quadratic in radius, so cap it rather than trusting the
          // caller -- a stray ?radius=500 would freeze the agent.
          const radius = Number.isFinite(requested)
            ? Math.max(4, Math.min(40, Math.trunc(requested)))
            : 20;
          json(res, 200, handlers.map(radius));
          return;
        }

        if (req.method === 'POST' && (url.pathname === '/say' || url.pathname === '/tell')) {
          const raw = await readBody(req);
          const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
          const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
            text?: unknown;
            from?: unknown;
          };

          const text = typeof body.text === 'string' ? body.text.trim() : '';
          const from = typeof body.from === 'string' && body.from.trim() !== ''
            ? body.from.trim()
            : 'operator';

          if (text === '') {
            json(res, 400, { error: 'text is required' });
            return;
          }

          // /say is conversation -- the agent hears it like any other speech.
          // /tell is an operator instruction, weighted differently and recorded
          // as an intervention. Keeping them separate matters: a run where the
          // operator issued orders is not the same experiment as one where they
          // chatted, and the telemetry must be able to tell them apart.
          if (url.pathname === '/say') {
            handlers.say(from, text);
            json(res, 200, { ok: true, delivered: 'say' });
          } else {
            const accepted = handlers.inject(from, text);
            json(res, accepted ? 200 : 400, { ok: accepted, delivered: 'tell' });
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/stop') {
          json(res, 200, { ok: true });
          handlers.stop('stopped via control API');
          return;
        }

        json(res, 404, {
          error: 'not found',
          endpoints: ['/state', '/map', '/say', '/tell', '/stop'],
        });
      } catch (err) {
        log.error('control', err);
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Almost always a second agent, or a previous one that has not exited.
        reject(
          new Error(
            `control port ${port} is already in use -- another agent is probably running. ` +
              `Set AGENT_CONTROL_PORT to use a different one.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, HOST, () => {
      resolve({
        port,
        close: () => {
          server.close();
        },
      });
    });
  });
}
