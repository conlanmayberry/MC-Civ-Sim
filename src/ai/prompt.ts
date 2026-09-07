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
  observePlaceableSpots,
  observeSelf,
} from '../bot/observations.ts';
import type { AgentIdentity } from '../agent/identity.ts';
import { toPromptFragment } from '../agent/identity.ts';
import type { HeardMessage } from '../agent/hearing.ts';
import { describeHearing } from '../agent/hearing.ts';

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
    'Each turn you get your current situation. Call as many tools as the job',
    'needs -- placing eight blocks is one turn, not eight. Turns are slow and',
    'far apart, so doing one small thing per turn wastes most of your time.',
    'Call none only if waiting is genuinely better. Also write ONE short',
    'sentence saying why -- that sentence is recorded for research, so make it a',
    'real reason rather than a restatement of the action.',
    '',
    'Use set_goal to say what you are working on. It persists across turns and',
    'survives interruptions, so if something distracts you -- somebody talks to',
    'you, you get hurt -- you can deal with it and then carry on. Change the',
    'goal when you genuinely change your mind, not because you got sidetracked.',
    '',
    'Actions can fail, and a failure tells you something true about the world.',
    'unreachable means no route; no_tool means you need a better tool first;',
    'insufficient_items means you lack materials. Repeating a failed action',
    'unchanged will fail the same way -- do something different.',
    '',
    'Other people and agents can talk to you, and you will see what they said.',
    'If someone speaks to you, answer them with send_chat. Being spoken to and',
    'saying nothing is rude, and it wastes the only way you have of learning',
    'things you cannot see for yourself. You can also speak first if you want',
    'something from someone.',
    '',
    'Nobody is going to tell you what to do next. Decide.',
  ].join('\n');
}

/** A compact, readable snapshot. JSON would cost more tokens and read worse. */
export function buildObservation(
  bot: Bot,
  cycle: number,
  heard: HeardMessage[] = [],
  goal: string | null = null,
): string {
  const self = observeSelf(bot);
  const inventory = observeInventory(bot);
  const entities = observeEntities(bot, ENTITY_RADIUS, MAX_ENTITIES);
  const blocks = observeBlocks(bot, BLOCK_RADIUS);

  const lines: string[] = [`--- turn ${cycle} ---`];

  // Stated first: it is the thing most easily lost, and the reason an agent
  // that gets talked to mid-task never returns to it.
  if (goal !== null && goal !== '') {
    lines.push(`You are currently working on: ${goal}`);
  }

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

  // Without this the agent has to guess coordinates for place_block and gets
  // `blocked` every time -- it can see what is around it but not where there is
  // room. These are spots the action will actually accept.
  const spots = observePlaceableSpots(bot);
  if (spots.length > 0) {
    lines.push(
      `You could place a block at: ${spots
        .map((s) => `${s.position.x},${s.position.y},${s.position.z}`)
        .join(' or ')}.`,
    );
  }

  // What was said to it. Without this an agent is woken by chat but cannot
  // hear a word of it, which is how it was until this was added.
  lines.push(...describeHearing(heard));

  // Surface the pressures worth reacting to, without prescribing a reaction.
  const pressures: string[] = [];

  if (self.food <= 12) {
    // Saying "you are hungry" while it carries nothing edible produced twelve
    // consecutive eat_food attempts against an empty inventory. Being hungry
    // with no food is a different situation from being hungry, and the agent
    // could not tell them apart from the inventory list alone.
    const hasFood = inventory.items.some((i) => bot.registry.foodsByName[i.name] !== undefined);
    pressures.push(
      self.food <= 6 ? 'You are very hungry.' : 'You are getting hungry.',
      hasFood ? '' : 'You have nothing edible -- eating is not an option until you find food.',
    );
  }

  if (self.health <= 10) pressures.push('You are hurt.');
  if (!self.isDay) pressures.push('It is dark; hostile mobs spawn at night.');

  const text = pressures.filter((p) => p !== '').join(' ');
  if (text !== '') lines.push(text);

  return lines.join('\n');
}

/** Keeps the last N history entries, so prompt size stays flat over a long run. */
export function trimHistory(history: string[]): string[] {
  return history.slice(-HISTORY_WINDOW);
}
