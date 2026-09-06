#!/usr/bin/env node
/**
 * Stage 2 entry point: one bot, no AI.
 *
 *     npm run bot
 *
 * This wires the four pieces together and does nothing else. Deliberately no
 * decision loop, no goals, no periodic reasoning -- the bot reacts to chat
 * commands and otherwise stands still. Autonomy arrives in Stage 5, on top of
 * exactly these observation functions.
 */

import { loadConfig } from '../config.ts';
import { createLogger } from '../util/log.ts';
import { connect } from './connection.ts';
import type { BotSession } from './connection.ts';
import { createCommandHandler } from './commands.ts';
import { createActions } from './actions/index.ts';

const config = loadConfig();
const log = createLogger(config.username);

console.log('');
console.log(`\x1b[1m  MC-Civ-Sim\x1b[0m  bot "${config.username}" -> ${config.host}:${config.port}`);
console.log(`  Minecraft ${config.version}  |  offline auth  |  reconnect ${
  config.reconnect.enabled ? `up to ${config.reconnect.maxAttempts}x` : 'disabled'
}`);
console.log(
  `  \x1b[2msay "${config.chat.commandPrefix} help" in game; Ctrl-C or "${config.chat.commandPrefix} quit" to stop\x1b[0m`,
);
console.log('');

// The handler needs the session (for the `quit` kill switch) and the session
// needs the handler (to dispatch chat). Breaking the cycle with a getter rather
// than an assigned-later variable keeps it correct even if a future change makes
// the first spawn fire synchronously.
let session: BotSession | null = null;
const commands = createCommandHandler(config, log, () => {
  if (session === null) throw new Error('session used before connect() returned');
  return session;
});

session = connect(config, log, {
  onSpawn(bot) {
    // A reconnect produces a new Bot, and pathfinder loads per bot, so the
    // action surface is rebuilt here rather than once at startup.
    commands.reset(bot, createActions(bot, log));
  },
  onChat(bot, username, message) {
    commands.handle(bot, username, message);
  },
  onStopped(reason) {
    log.event('bot_disconnected', { reason, final: true });
    // Give queued chat and the socket close a moment to flush.
    setTimeout(() => process.exit(0), 250);
  },
});

function shutdown(signal: string): void {
  if (session === null || session.isStopping()) {
    process.exit(0);
    return;
  }
  console.log(`\n  ${signal} received -- disconnecting.`);
  session.stop(`${signal} from operator`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  session?.stop('uncaught exception');
  setTimeout(() => process.exit(1), 250);
});
