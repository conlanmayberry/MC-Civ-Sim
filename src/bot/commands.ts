/**
 * Chat command handling.
 *
 * Dispatch is an exact-match lookup in a fixed table. There is no dynamic
 * dispatch on chat content and nothing resembling eval: chat arrives from the
 * world, and the world is untrusted input. Principle 16 of the project brief
 * draws this line, and it is cheapest to hold from the first commit.
 *
 * Since Stage 3, the world-changing commands are thin wrappers over the action
 * layer and print the ActionResult verbatim, error code included. That is
 * deliberate: the operator sees exactly what Stage 5's model will see, so a
 * command that behaves oddly in chat is a faithful preview of how the agent
 * will experience it.
 *
 * Outgoing chat is rate-limited because Minecraft kicks for spam, and a kick
 * triggers the reconnect path -- so an unthrottled reply loop would present as
 * a mysterious connection problem.
 */

import type { Bot } from 'mineflayer';

import type { Actions, ActionResult } from './actions/index.ts';
import { describeResult } from './actions/index.ts';
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

export interface CommandContext {
  bot: Bot;
  speaker: string;
  say: (message: string) => void;
  /** Everything after the command word. */
  args: string[];
  actions: Actions;
  report: (promise: Promise<ActionResult>) => void;
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
  /**
   * Rebind to a connection. Reconnecting builds a new Bot and a new action
   * surface (pathfinder loads per bot), so both arrive together.
   */
  reset: (bot: Bot, actions: Actions) => void;
}

/** Parses an integer argument, returning null rather than NaN. */
function intArg(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function createCommandHandler(
  config: BotConfig,
  log: Logger,
  /** A getter, not the session: the session and this handler refer to each other. */
  getSession: () => BotSession,
): CommandHandler {
  let boundActions: Actions | null = null;
  let say: (message: string) => void = () => {};

  /** Run an action and report its result -- failures included, with the code. */
  function report(promise: Promise<ActionResult>): void {
    promise
      .then((result) => {
        say(describeResult(result));
      })
      .catch((err: unknown) => {
        // runAction never throws, so reaching here is a bug rather than an
        // action failure. Say so plainly instead of dressing it up.
        log.error('command-action', err);
        say(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      });
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
        summary: 'walk to you',
        run: ({ speaker, actions, report: run }) => {
          run(actions.followPlayer(speaker, 2));
        },
      },
    ],
    [
      'follow',
      {
        summary: 'follow a player: follow [name]',
        run: ({ speaker, args, actions, report: run }) => {
          run(actions.followPlayer(args[0] ?? speaker, 3));
        },
      },
    ],
    [
      'goto',
      {
        summary: 'walk to coordinates: goto <x> <y> <z>',
        run: ({ args, say: reply, actions, report: run }) => {
          const x = intArg(args[0]);
          const y = intArg(args[1]);
          const z = intArg(args[2]);
          if (x === null || y === null || z === null) {
            reply('Usage: bot goto <x> <y> <z>');
            return;
          }
          run(actions.moveTo(x, y, z, 1));
        },
      },
    ],
    [
      'mine',
      {
        summary: 'mine blocks: mine <block> [count]',
        run: ({ args, say: reply, actions, report: run }) => {
          const block = args[0];
          if (block === undefined) {
            reply('Usage: bot mine <block> [count]');
            return;
          }
          run(actions.mineBlock(block, intArg(args[1]) ?? 1));
        },
      },
    ],
    [
      'craft',
      {
        summary: 'craft items: craft <item> [count]',
        run: ({ args, say: reply, actions, report: run }) => {
          const item = args[0];
          if (item === undefined) {
            reply('Usage: bot craft <item> [count]');
            return;
          }
          run(actions.craftItem(item, intArg(args[1]) ?? 1));
        },
      },
    ],
    [
      'place',
      {
        summary: 'place a block: place <item> [x y z]',
        run: ({ bot, args, say: reply, actions, report: run }) => {
          const item = args[0];
          if (item === undefined) {
            reply('Usage: bot place <item> [x y z]');
            return;
          }

          const x = intArg(args[1]);
          const y = intArg(args[2]);
          const z = intArg(args[3]);
          if (x !== null && y !== null && z !== null) {
            run(actions.placeBlock(item, x, y, z));
            return;
          }

          // No coordinates: place on the ground one block in front, which is
          // what someone standing there would mean.
          const yaw = bot.entity.yaw;
          const forward = bot.entity.position.offset(
            Math.round(-Math.sin(yaw)),
            0,
            Math.round(Math.cos(yaw)),
          );
          run(
            actions.placeBlock(
              item,
              Math.floor(forward.x),
              Math.floor(forward.y),
              Math.floor(forward.z),
            ),
          );
        },
      },
    ],
    [
      'eat',
      {
        summary: 'eat the best available food',
        run: ({ actions, report: run }) => {
          run(actions.eatFood());
        },
      },
    ],
    [
      'collect',
      {
        summary: 'pick up nearby dropped items',
        run: ({ args, actions, report: run }) => {
          run(actions.collectNearbyItems(intArg(args[0]) ?? 12));
        },
      },
    ],
    [
      'stop',
      {
        summary: 'stop moving',
        run: ({ actions, say: reply }) => {
          actions.stop();
          reply('Stopped.');
        },
      },
    ],
    [
      'quit',
      {
        summary: 'disconnect (kill switch)',
        run: ({ speaker, actions, say: reply }) => {
          reply('Disconnecting.');
          actions.stop();
          // Let the reply reach the server before the socket closes.
          setTimeout(() => getSession().stop(`quit requested by ${speaker}`), 500).unref();
        },
      },
    ],
  ]);

  commands.set('help', {
    summary: 'this list',
    run: ({ say: reply }) => {
      reply(`Commands: ${[...commands.keys()].join(', ')}`);
    },
  });

  const ALIASES = new Map<string, string>([
    ['inv', 'inventory'],
    ['pos', 'status'],
  ]);

  return {
    reset(bot, actions) {
      boundActions = actions;
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

      if (boundActions === null) {
        say('I am not ready yet.');
        return;
      }

      log.event('command_received', { from: speaker, command: name, args: words.slice(2) });

      try {
        command.run({ bot, speaker, say, args: words.slice(2), actions: boundActions, report });
      } catch (err) {
        log.error(`command:${name}`, err);
        say(`That failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
