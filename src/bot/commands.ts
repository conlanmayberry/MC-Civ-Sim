/**
 * Chat command handling.
 *
 * Dispatch is an exact-match lookup in a fixed table. There is no dynamic
 * dispatch on chat content and nothing resembling eval: chat arrives from the
 * world, and the world is untrusted input. Principle 16 of the project brief
 * draws this line, and it is cheapest to hold from the first commit.
 *
 * Outgoing chat is rate-limited because Minecraft kicks for spam, and a kick
 * triggers the reconnect path -- so an unthrottled reply loop would present as
 * a mysterious connection problem.
 */

import type { Bot } from 'mineflayer';

import type { BotConfig } from '../config.ts';
import type { Logger } from '../util/log.ts';
import type { BotSession } from './connection.ts';
import {
  observeBlocks,
  observeEntities,
  observeInventory,
  observeSelf,
} from './observations.ts';

/** Minecraft rejects chat over 256 characters; leave room for the server prefix. */
const MAX_CHAT_LENGTH = 240;

/** A `bot come` that never gives up would walk into a wall until nightfall. */
const FOLLOW_TIMEOUT_MS = 30_000;
const FOLLOW_TICK_MS = 250;
const FOLLOW_ARRIVAL_DISTANCE = 2.5;
/** Below this much movement in one tick, treat the bot as blocked. */
const STALL_DISTANCE = 0.15;
const STALL_TICKS_BEFORE_JUMP = 2;
/** ~3s at FOLLOW_TICK_MS: long enough to rule out a slow start. */
const NO_MOVEMENT_CHECK_TICKS = 12;

export interface CommandContext {
  bot: Bot;
  speaker: string;
  say: (message: string) => void;
}

interface Command {
  readonly summary: string;
  readonly run: (ctx: CommandContext) => void;
}

/** Queues outgoing chat so replies cannot trip the server's spam kick. */
function createChatSender(bot: Bot, config: BotConfig, log: Logger): (message: string) => void {
  const queue: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let lastSentAt = 0;

  const flush = (): void => {
    timer = null;
    const message = queue.shift();
    if (message === undefined) return;

    try {
      bot.chat(message);
      lastSentAt = Date.now();
      log.event('chat_sent', { message });
    } catch (err) {
      log.error('chat', err);
    }

    if (queue.length > 0) {
      timer = setTimeout(flush, config.chat.minIntervalMs);
      timer.unref();
    }
  };

  return (message: string): void => {
    const trimmed =
      message.length > MAX_CHAT_LENGTH ? `${message.slice(0, MAX_CHAT_LENGTH - 1)}...` : message;
    queue.push(trimmed);

    if (timer !== null) return;
    const wait = Math.max(0, config.chat.minIntervalMs - (Date.now() - lastSentAt));
    timer = setTimeout(flush, wait);
    timer.unref();
  };
}

export interface CommandHandler {
  handle: (bot: Bot, speaker: string, message: string) => void;
  /** Clears per-connection state. Call on every spawn. */
  reset: (bot: Bot) => void;
}

export function createCommandHandler(
  config: BotConfig,
  log: Logger,
  /** A getter, not the session: the session and this handler refer to each other. */
  getSession: () => BotSession,
): CommandHandler {
  let followTimer: NodeJS.Timeout | null = null;
  let followDeadline = 0;
  let senderBot: Bot | null = null;
  let say: (message: string) => void = () => {};

  function stopMoving(bot: Bot): void {
    if (followTimer !== null) {
      clearInterval(followTimer);
      followTimer = null;
    }
    bot.clearControlStates();
  }

  /**
   * Deliberately crude: face the target and walk forward. Real navigation is
   * Stage 3's job (mineflayer-pathfinder); this only needs to prove the movement
   * control path works end to end.
   *
   * Two details are load-bearing and were both found by watching it fail:
   *
   *   lookAt(..., true) forces the rotation to apply immediately. The default
   *   animates it over several ticks, so calling it on every tick of a control
   *   loop restarts the animation forever and the yaw never settles -- the bot
   *   shuffles in place because "forward" keeps changing direction.
   *
   *   Jump is pulsed on a detected stall, not held. Holding it makes the bot
   *   bunny-hop continuously, which is both slower and worse at climbing.
   */
  function follow(bot: Bot, targetName: string): void {
    stopMoving(bot);
    followDeadline = Date.now() + FOLLOW_TIMEOUT_MS;

    const origin = bot.entity.position.clone();
    let lastPosition = bot.entity.position.clone();
    let stalledTicks = 0;
    let ticks = 0;

    followTimer = setInterval(() => {
      ticks++;

      // Movement is currently blocked upstream (ADR-006): the server rejects
      // mineflayer's movement packets and teleports the bot back. Say so
      // quickly rather than shuffling in place until the 30s timeout -- a
      // silent no-op is the worst way to report a known blocker.
      if (ticks === NO_MOVEMENT_CHECK_TICKS && bot.entity.position.distanceTo(origin) < 1) {
        say('I cannot move -- the server is rejecting my movement. See docs/decisions.md ADR-006.');
        log.event('error', {
          where: 'follow',
          message: 'no movement after ' + String(NO_MOVEMENT_CHECK_TICKS) + ' ticks (ADR-006)',
        });
        stopMoving(bot);
        return;
      }

      const target = bot.players[targetName]?.entity;

      if (target === undefined || target === null) {
        say(`I lost track of ${targetName}.`);
        stopMoving(bot);
        return;
      }

      if (Date.now() > followDeadline) {
        say(`Giving up on reaching ${targetName}.`);
        stopMoving(bot);
        return;
      }

      const distance = bot.entity.position.distanceTo(target.position);
      if (distance <= FOLLOW_ARRIVAL_DISTANCE) {
        say(`Reached ${targetName}.`);
        stopMoving(bot);
        return;
      }

      void bot.lookAt(target.position.offset(0, target.height * 0.5, 0), true);
      bot.setControlState('forward', true);

      // Blocked by a step, a trunk, or a fence post: hop once and keep going.
      const movedSinceLastTick = bot.entity.position.distanceTo(lastPosition);
      stalledTicks = movedSinceLastTick < STALL_DISTANCE ? stalledTicks + 1 : 0;
      lastPosition = bot.entity.position.clone();

      const shouldJump = stalledTicks >= STALL_TICKS_BEFORE_JUMP && bot.entity.onGround;
      bot.setControlState('jump', shouldJump);
      if (shouldJump) stalledTicks = 0;
    }, FOLLOW_TICK_MS);

    followTimer.unref();
  }

  const commands = new Map<string, Command>([
    [
      'status',
      {
        summary: 'position, health and food',
        run: ({ bot, say: reply }) => {
          const self = observeSelf(bot);
          reply(
            `Position: x=${Math.round(self.position.x)} y=${Math.round(self.position.y)} ` +
              `z=${Math.round(self.position.z)} | Health: ${self.health} | Food: ${self.food}`,
          );
        },
      },
    ],
    [
      'inventory',
      {
        summary: 'what I am carrying',
        run: ({ bot, say: reply }) => {
          const inv = observeInventory(bot);
          if (inv.items.length === 0) {
            reply('Inventory is empty.');
            return;
          }
          const listed = inv.items.map((i) => `${i.name} x${i.count}`).join(', ');
          reply(`${inv.totalCount} items in ${inv.usedSlots} slots: ${listed}`);
        },
      },
    ],
    [
      'look',
      {
        summary: 'blocks nearby',
        run: ({ bot, say: reply }) => {
          const view = observeBlocks(bot, config.observation.blockRadius);
          if (view.blocks.length === 0) {
            reply('Nothing but air within reach.');
            return;
          }
          const top = view.blocks
            .slice(0, 8)
            .map((b) => `${b.name} x${b.count}`)
            .join(', ');
          reply(`Within ${view.radius} blocks: ${top}`);
        },
      },
    ],
    [
      'who',
      {
        summary: 'entities nearby',
        run: ({ bot, say: reply }) => {
          const view = observeEntities(
            bot,
            config.observation.entityRadius,
            config.observation.maxEntities,
          );
          if (view.entities.length === 0) {
            reply(`Nothing within ${view.radius} blocks.`);
            return;
          }
          const listed = view.entities
            .slice(0, 8)
            .map((e) => `${e.name} (${e.distance}m)`)
            .join(', ');
          reply(`Nearby: ${listed}`);
        },
      },
    ],
    [
      'come',
      {
        summary: 'walk towards you',
        run: ({ bot, speaker, say: reply }) => {
          const target = bot.players[speaker]?.entity;
          if (target === undefined || target === null) {
            reply(`I cannot see you, ${speaker}. Move closer.`);
            return;
          }
          reply(`Coming to you, ${speaker}.`);
          follow(bot, speaker);
        },
      },
    ],
    [
      'stop',
      {
        summary: 'stop moving',
        run: ({ bot, say: reply }) => {
          stopMoving(bot);
          reply('Stopped.');
        },
      },
    ],
    [
      'quit',
      {
        summary: 'disconnect (kill switch)',
        run: ({ bot, speaker, say: reply }) => {
          reply('Disconnecting.');
          stopMoving(bot);
          // Let the reply reach the server before the socket closes.
          setTimeout(() => getSession().stop(`quit requested by ${speaker}`), 500).unref();
        },
      },
    ],
  ]);

  commands.set('help', {
    summary: 'this list',
    run: ({ say: reply }) => {
      const names = [...commands.keys()].join(', ');
      reply(`Commands: ${names}`);
    },
  });

  const ALIASES = new Map<string, string>([
    ['inv', 'inventory'],
    ['pos', 'status'],
  ]);

  return {
    reset(bot) {
      if (senderBot !== null && senderBot !== bot && followTimer !== null) {
        clearInterval(followTimer);
        followTimer = null;
      }
      senderBot = bot;
      say = createChatSender(bot, config, log);
    },

    handle(bot, speaker, message) {
      const words = message.trim().split(/\s+/);
      const prefix = words[0];
      const rawName = words[1];

      if (prefix?.toLowerCase() !== config.chat.commandPrefix) return;

      if (rawName === undefined) {
        log.event('command_rejected', { from: speaker, reason: 'no command given' });
        say(`Say "${config.chat.commandPrefix} help" for the command list.`);
        return;
      }

      const name = ALIASES.get(rawName.toLowerCase()) ?? rawName.toLowerCase();
      const command = commands.get(name);

      if (command === undefined) {
        log.event('command_rejected', { from: speaker, command: rawName, reason: 'unknown' });
        say(`Unknown command "${rawName}". Try "${config.chat.commandPrefix} help".`);
        return;
      }

      log.event('command_received', { from: speaker, command: name });

      try {
        command.run({ bot, speaker, say });
      } catch (err) {
        log.error(`command:${name}`, err);
        say(`That failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
