/**
 * Prompt assembly: identity + world state -> what the model actually reads.
 *
 * Two properties matter here and both come from earlier decisions.
 *
 * BOUNDED. The observations are already radius-limited (ADR-005), which is what
 * keeps a prompt from growing with the size of the world. This file adds the
 * second bound: history is a fixed-length window, not the whole run. Together
 * they mean cost per decision is roughly constant rather than creeping upward
 * over hours -- which is the difference between a $5 cap lasting an afternoon
 * and lasting twenty minutes.
 *
 * IMPERFECT INFORMATION. Everything here comes from what this agent could
 * observe. Nothing reads the server's world files, another agent's state, or a
 * conversation it was not part of. Principles 9-11 of the brief depend on that,
 * and this is the file where it would be easiest to accidentally cheat.
 */

import type { Bot } from 'mineflayer';

import {
  observeBlocks,
  observeEntities,
  observeInventory,
  observeSelf,
} from '../bot/observations.ts';
import type { AgentIdentity } from '../agent/identity.ts';
import { toPromptFragment } from '../agent/identity.ts';

/** How many past cycles the model is reminded of. */
export const HISTORY_WINDOW = 6;

const BLOCK_RADIUS = 12;
const ENTITY_RADIUS = 24;
const MAX_ENTITIES = 8;
const MAX_BLOCK_KINDS = 10;

/**
 * The standing instructions. Deliberately short: long rulebooks produce
 * rule-following, and the brief wants behaviour that emerges rather than
 * behaviour that was specified.
 */
export function buildSystemPrompt(identity: AgentIdentity): string {
  return [
    toPromptFragment(identity),
    '',
    'You are playing Minecraft in survival mode. You act through the tools you',
    'have been given, and those are the only things you can do.',
    '',
    'Each turn you get your current situation. Call one or two tools to act, or',
    'none if waiting is genuinely better. Also write ONE short sentence saying',
    'why -- that sentence is recorded for research, so make it a real reason',
    'rather than a restatement of the action.',
    '',
    'Actions can fail, and a failure tells you something true about the world.',
    'unreachable means no route; no_tool means you need a better tool first;',
    'insufficient_items means you lack materials. Repeating a failed action',
    'unchanged will fail the same way -- do something different.',
    '',
    'Nobody is going to tell you what to do next. Decide.',
  ].join('\n');
}

/** A compact, readable snapshot. JSON would cost more tokens and read worse. */
export function buildObservation(bot: Bot, cycle: number): string {
  const self = observeSelf(bot);
  const inventory = observeInventory(bot);
  const entities = observeEntities(bot, ENTITY_RADIUS, MAX_ENTITIES);
  const blocks = observeBlocks(bot, BLOCK_RADIUS);

  const lines: string[] = [`--- turn ${cycle} ---`];

  lines.push(
    `You are at ${self.position.x}, ${self.position.y}, ${self.position.z} ` +
      `in the ${self.dimension}. Health ${self.health}/20, food ${self.food}/20. ` +
      `It is ${self.isDay ? 'day' : 'NIGHT'}.`,
  );

  lines.push(
    inventory.items.length === 0
      ? 'You are carrying nothing.'
      : `You are carrying: ${inventory.items.map((i) => `${i.count}x ${i.name}`).join(', ')}.`,
  );

  const nearby = blocks.blocks.slice(0, MAX_BLOCK_KINDS);
  lines.push(
    nearby.length === 0
      ? `Nothing but air within ${blocks.radius} blocks.`
      : `Blocks within ${blocks.radius}: ${nearby
          .map((b) => `${b.name} (${b.count}, nearest ${b.nearest.x},${b.nearest.y},${b.nearest.z})`)
          .join('; ')}.`,
  );

  if (entities.entities.length > 0) {
    lines.push(
      `Nearby: ${entities.entities.map((e) => `${e.name} at ${e.distance}m`).join(', ')}.`,
    );
  }

  // Surface the pressures worth reacting to, without prescribing a reaction.
  const pressures: string[] = [];
  if (self.food <= 6) pressures.push('You are very hungry.');
  if (self.health <= 10) pressures.push('You are hurt.');
  if (!self.isDay) pressures.push('It is dark; hostile mobs spawn at night.');
  if (pressures.length > 0) lines.push(pressures.join(' '));

  return lines.join('\n');
}

/** Keeps the last N history entries, so prompt size stays flat over a long run. */
export function trimHistory(history: string[]): string[] {
  return history.slice(-HISTORY_WINDOW);
}
