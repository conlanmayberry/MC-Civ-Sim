#!/usr/bin/env node
/**
 * Stage 5 entry point: run one autonomous agent.
 *
 *     npm run agent                 -- live, spends money
 *     npm run agent -- --dry-run    -- full loop, stub provider, $0.00
 *     npm run agent -- --agent bob --interval 45 --budget 2
 *
 * The dry run is not a lesser mode. It exercises observe -> decide -> act ->
 * record end to end against the real Minecraft server, with a scripted provider
 * instead of a paid one, and it is how the loop gets verified before any API
 * call is made.
 *
 * Three ways to stop it, because an autonomous process that spends money needs
 * more than one: `agent stop` in Minecraft chat, Ctrl-C, or creating a file
 * named STOP in the project root. The file matters when the terminal is not to
 * hand -- and it is the one a dashboard button will use.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT, loadConfig, loadEnvFile } from '../config.ts';
import { createActions } from '../bot/actions/index.ts';
import {
  observeEntities,
  observeInventory,
  observeMapTiles,
  observeSelf,
} from '../bot/observations.ts';
import { connect } from '../bot/connection.ts';
import type { BotSession } from '../bot/connection.ts';
import { createTelemetry } from '../telemetry/index.ts';
import { createBudget, DEFAULT_LIMITS } from '../ai/budget.ts';
import { MODEL, describeModel, formatUsd } from '../ai/pricing.ts';
import { createOpenAiProvider } from '../ai/openai.ts';
import { createStubProvider } from '../ai/provider.ts';
import type { AiProvider } from '../ai/provider.ts';
import { createAgent } from './agent.ts';
import { loadIdentityById } from './identity.ts';
import { createInbox } from './inbox.ts';
import { createHearing } from './hearing.ts';
import { DEFAULT_CONTROL_PORT, startControlServer } from './control.ts';
import type { ControlServer } from './control.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const KILL_FILE = path.join(ROOT, 'STOP');
const KILL_POLL_MS = 2_000;
const DEFAULT_INTERVAL_MS = 30_000;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? '';
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

// Precedence: CLI flag > .env > default. A flag is a deliberate one-off; .env
// is the standing setting.
const env = { ...loadEnvFile(), ...process.env };

function numberSetting(flagName: string, envName: string, fallback: number): number {
  const fromFlag = Number(flag(flagName) ?? '');
  if (Number.isFinite(fromFlag) && fromFlag > 0) return fromFlag;
  const fromEnv = Number(env[envName] ?? '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return fallback;
}

const dryRun = hasFlag('dry-run');
const agentId = flag('agent') ?? env['AGENT_ID'] ?? 'alice';
const intervalMs = numberSetting('interval', 'AI_INTERVAL_SECONDS', DEFAULT_INTERVAL_MS / 1000) * 1000;
const budgetUsd = numberSetting('budget', 'AI_BUDGET_USD', DEFAULT_LIMITS.maxUsd);

const config = loadConfig();
const startedAt = new Date().toISOString();

let identity;
try {
  identity = loadIdentityById(agentId);
} catch (err) {
  console.error(`\n${RED}  ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  process.exit(1);
}

// --- provider selection, and the money conversation --------------------------

let provider: AiProvider;

if (dryRun) {
  // A fixed script rather than randomness: a dry run should be reproducible,
  // and these exercise a success, a likely failure, and a no-op.
  provider = createStubProvider([
    [{ callId: 'c1', name: 'mine_block', args: { block: 'spruce_log', count: 1, searchRadius: 32 } }],
    [{ callId: 'c2', name: 'craft_item', args: { item: 'spruce_planks', count: 4 } }],
    [{ callId: 'c3', name: 'eat_food', args: {} }],
    [],
  ]);
} else {
  const apiKey = env['OPENAI_API_KEY'] ?? '';
  if (apiKey.trim() === '') {
    console.error(`\n${RED}  OPENAI_API_KEY is not set.${RESET}`);
    console.error(`  Put it in .env (git-ignored):\n`);
    console.error(`      OPENAI_API_KEY=sk-...\n`);
    console.error(`  Or try the loop without spending anything:\n`);
    console.error(`      npm run agent -- --dry-run\n`);
    process.exit(1);
  }
  provider = createOpenAiProvider({ apiKey });
}

const limits = { ...DEFAULT_LIMITS, maxUsd: budgetUsd };
const budget = createBudget(limits);
const inbox = createInbox();
// Radius defaults to Infinity, matching vanilla Minecraft's global chat.
// AGENT_HEARING_RADIUS restricts it -- see hearing.ts on why Stage 9 needs that.
const hearing = createHearing(identity.username, {
  radius: Number(env['AGENT_HEARING_RADIUS'] ?? '') > 0
    ? Number(env['AGENT_HEARING_RADIUS'])
    : Number.POSITIVE_INFINITY,
});

const telemetry = createTelemetry(identity.id, {
  minecraftVersion: config.version,
  note: dryRun ? 'npm run agent --dry-run' : `npm run agent (${MODEL})`,
});
const log = telemetry.logger;

console.log('');
console.log(`${BOLD}  MC-Civ-Sim agent${RESET}  ${identity.username} (${identity.id})`);
console.log(`  ${DIM}${identity.traits.join(', ')}${RESET}`);
if (dryRun) {
  console.log(`  ${BOLD}DRY RUN${RESET} -- scripted decisions, no API calls, ${BOLD}$0.00${RESET}`);
} else {
  // Never let cost be a surprise. Printed before the first call, every time.
  console.log(`  ${YELLOW}LIVE -- this spends real money.${RESET}`);
  console.log(`  ${DIM}${describeModel(MODEL)}${RESET}`);
  console.log(
    `  budget ${BOLD}${formatUsd(limits.maxUsd)}${RESET}, ` +
      `thinking every ${intervalMs / 1000}s, max ${limits.maxRequestsPerMinute} calls/min`,
  );
}
console.log(`  ${DIM}stop with "agent stop" in chat, Ctrl-C, or by creating a file named STOP${RESET}`);
console.log(`  ${DIM}recording run ${telemetry.runId}${RESET}`);
console.log('');

// A stale STOP file from a previous run would stop this one instantly.
if (fs.existsSync(KILL_FILE)) {
  fs.rmSync(KILL_FILE, { force: true });
  console.log(`  ${DIM}(removed a leftover STOP file)${RESET}\n`);
}

// --- wire it up --------------------------------------------------------------

let session: BotSession | null = null;
let control: ControlServer | null = null;
let stopping = false;

function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  control?.close();
  agent.stop(reason);
  session?.stop(reason);
}

const agent = createAgent({
  identity,
  provider,
  budget,
  inbox,
  hearing,
  log,
  intervalMs,
  onStopped: (reason) => {
    telemetry.close();
    session?.stop(reason);
    setTimeout(() => process.exit(0), 500);
  },
});

// The kill file is polled rather than watched: fs.watch is unreliable across
// platforms and editors, and a two-second delay on a manual stop is fine.
const killPoll = setInterval(() => {
  if (fs.existsSync(KILL_FILE)) {
    console.log(`\n  STOP file detected -- shutting down.`);
    fs.rmSync(KILL_FILE, { force: true });
    shutdown('kill file');
  }
}, KILL_POLL_MS);
killPoll.unref();

session = connect(
  { ...config, username: identity.username },
  log,
  {
    onSpawn(bot) {
      telemetry.attach(bot);
      const actions = createActions(bot, log);
      void agent.run(bot, actions);

      if (control === null) {
        const controlPort = Number(env['AGENT_CONTROL_PORT'] ?? '') > 0
          ? Number(env['AGENT_CONTROL_PORT'])
          : DEFAULT_CONTROL_PORT;

        void startControlServer(
          {
            // Heard as speech: the agent may reply, or not.
            say(from, text) {
              agent.hear(from, text, null);
              // Logged here rather than in hear(): Minecraft chat is already
              // recorded by connection.ts, so logging inside hear() would
              // double-count it. This path is the one nothing else sees.
              log.event('chat_received', { from, message: text, source: 'control' });
              // Echo into Minecraft so anyone in-game sees what was said from
              // the terminal -- otherwise half a conversation is invisible.
              try {
                bot.chat(`[${from}] ${text}`);
              } catch {
                /* not connected; the agent still heard it */
              }
            },
            // An operator directive, recorded as an intervention.
            inject(from, text) {
              const queued = inbox.inject(text, from);
              if (queued !== null) agent.nudge(`instruction from ${from}`);
              return queued !== null;
            },
            state: () => {
              // Guarded: the dashboard polls continuously, including while the
              // bot is reconnecting and has no entity. A throw here would show
              // as the agent being dead rather than briefly disconnected.
              let self: unknown = null;
              let inventory: unknown = null;
              let nearbyEntities: unknown = null;
              try {
                if (bot.entity !== undefined) {
                  self = observeSelf(bot);
                  inventory = observeInventory(bot);
                  nearbyEntities = observeEntities(bot, 32, 12).entities;
                }
              } catch {
                /* mid-reconnect; report nulls rather than failing the request */
              }

              return {
                agentId: identity.id,
                username: identity.username,
                description: identity.description,
                traits: identity.traits,
                interests: identity.interests,
                values: identity.values,
                cycles: agent.cycles(),
                spentUsd: budget.spentUsd(),
                budgetUsd: limits.maxUsd,
                model: provider.model,
                running: budget.stopped() === null,
                pendingInjections: inbox.pending(),
                recentlyHeard: hearing.recent(),
                self,
                inventory,
                nearbyEntities,
                startedAt: startedAt,
              };
            },
            map: (radius) => {
              try {
                return bot.entity === undefined ? null : observeMapTiles(bot, radius);
              } catch {
                return null;
              }
            },
            stop: (reason) => shutdown(reason),
          },
          log,
          controlPort,
        )
          .then((server) => {
            control = server;
            console.log(`  [2mtalk to it from a terminal: npm run talk  (port ${server.port})[0m`);
          })
          .catch((err: unknown) => {
            // Not fatal: the agent runs fine without a control server, and
            // Minecraft chat still works.
            console.error(
              `  [33mcontrol server unavailable: ${err instanceof Error ? err.message : String(err)}[0m`,
            );
          });
      }
    },

    onChat(bot, username, message) {
      if (username === bot.username) return;
      const text = message.trim();

      // Operator control from inside the game. `agent tell ...` is thought
      // injection; the dashboard will use the same inbox.
      if (text === 'agent stop') {
        bot.chat('Stopping.');
        shutdown(`stopped by ${username}`);
        return;
      }
      if (text.startsWith('agent tell ')) {
        const injected = inbox.inject(text.slice('agent tell '.length), username);
        if (injected !== null) {
          bot.chat('Noted.');
          // Think now rather than at the next interval -- an operator who just
          // said something expects it to land.
          agent.nudge(`instruction from ${username}`);
        }
        return;
      }
      if (text === 'agent status') {
        bot.chat(`${identity.username}: ${agent.cycles()} decisions, ${budget.summary()}`);
        return;
      }

      // Anything else is ordinary conversation. The agent hears it, sees who
      // said it and how far away they were, and can answer with send_chat.
      const speaker = bot.players[username]?.entity;
      const distance =
        speaker === undefined || speaker === null
          ? null
          : Math.round(bot.entity.position.distanceTo(speaker.position) * 10) / 10;

      agent.hear(username, text, distance);
    },

    onStopping() {
      telemetry.snapshot('shutdown');
    },

    onStopped(reason) {
      log.event('bot_disconnected', { reason, final: true });
      telemetry.close();
      setTimeout(() => process.exit(0), 250);
    },
  },
);

process.on('SIGINT', () => {
  console.log('\n  SIGINT -- stopping the agent.');
  shutdown('SIGINT');
});
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  telemetry.close();
  setTimeout(() => process.exit(1), 250);
});
