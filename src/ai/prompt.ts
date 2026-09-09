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
  observeGroundProfile,
  observeInventory,
  observePlaceableSpots,
  observeSelf,
} from '../bot/observations.ts';
import type { AgentIdentity } from '../agent/identity.ts';
import { toPromptFragment } from '../agent/identity.ts';
import type { HeardMessage } from '../agent/hearing.ts';
import { describeHearing } from '../agent/hearing.ts';
import type { Place } from '../agent/places.ts';
import { describePlaces } from '../agent/places.ts';
import type { Setback } from '../agent/setbacks.ts';
import { describeSetbacks } from '../agent/setbacks.ts';
import type { Order } from '../agent/orders.ts';
import { describeOrder } from '../agent/orders.ts';

/**
 * How many past cycles the model is reminded of.
 *
 * COUNTED IN TURNS, SPENT IN SECONDS -- and that gap is why coordination
 * kept failing. Six turns sounds generous; measured live it was 35-44
 * seconds of wall-clock memory, because turns had quietly sped up to a
 * median of six seconds each (chat woke agents constantly, and the no-op
 * fast retry shortened the rest).
 *
 * Everything these agents coordinate about takes longer than that. Walking
 * 200m takes over a minute. So an agent could agree to bring someone food
 * and have the turn where it agreed fall out of memory before it arrived --
 * not through poor reasoning, but because the commitment no longer existed
 * anywhere it could see. Then it re-asked, which produced more chat, which
 * woke everyone again, which made turns faster still.
 *
 * Raised, and the two changes that slow turns back down (only being
 * addressed wakes an agent; chat is rationed) widen it further in real time
 * without costing another token. The real fix for commitments that outlive
 * any window is durable shared state, which is Stage 7's job -- this is the
 * cheap part.
 */
export const HISTORY_WINDOW = 14;

const BLOCK_RADIUS = 12;
const ENTITY_RADIUS = 24;
const MAX_ENTITIES = 8;
const MAX_BLOCK_KINDS = 10;
/** A modest footprint -- about what one small structure needs, not a survey. */
const GROUND_RADIUS = 4;
/** Ground within this many blocks of level is "flat" rather than "sloped". */
const FLAT_TOLERANCE = 1;

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
    'It is shown back to you every turn, so setting the goal you already have',
    'does nothing and spends a turn you could have spent acting.',
    '',
    'You are told where you are, never where you have been. If you walk away',
    'from something without recording it, you have lost it: use remember_place',
    'for anything you will want to find again, and read the places you have',
    'recorded before deciding you are somewhere you are not.',
    '',
    'Actions can fail, and a failure tells you something true about the world.',
    'unreachable means no route; no_tool means you need a better tool first;',
    'insufficient_items means you lack materials. Repeating a failed action',
    'unchanged will fail the same way -- do something different.',
    '',
    'You are told whether the ground near you is level before you build.',
    'Placing a wall against sloped ground fails at every point the wall meets',
    'earth instead of air, which reads as random `blocked` results unless you',
    'already know the ground was not flat. On sloped ground, level a pad or',
    'move to flatter ground before placing a structure, rather than placing',
    'pieces one at a time and finding out from the failures.',
    '',
    'When you build, decide the whole shape BEFORE placing anything, and say it',
    'in your reason: where the corners are, how tall the walls are, which side',
    'the door is on. A structure is finished when it has all four walls at the',
    'same height, a roof, a doorway you can walk through, and light inside. Work',
    'to that standard:',
    '  - Pick the footprint first. A 5x5 or 6x6 square on level ground is enough',
    '    for one person and is far easier to finish than something ambitious.',
    '  - Use ONE material for the walls. A shelter patched from dirt, cobble and',
    '    planks in whatever order they came to hand looks like debris, and you',
    '    have to live in it.',
    '  - Leave the doorway as you build, rather than sealing yourself in and',
    '    mining back out. Two blocks tall, on one side, decided in advance.',
    '  - Finish the structure you started before beginning another one. Three',
    '    half-built shelters are worth less than one finished shelter.',
    '  - Build on the surface unless you mean to build underground. Digging a',
    '    hole is easier than raising walls and that is exactly why it happens by',
    '    accident -- if you find yourself underground without having chosen to',
    '    be, come back up.',
    '',
    'Other people and agents can talk to you, and you will see what they said.',
    'If someone speaks to you, answer them with send_chat. Being spoken to and',
    'saying nothing is rude, and it wastes the only way you have of learning',
    'things you cannot see for yourself. You can also speak first if you want',
    'something from someone.',
    '',
    'A promise to hand something over only becomes real through give_item, and',
    'that only reaches someone you are standing right next to -- it drops the',
    'item where you are, not where they are. Agreeing in chat to bring someone',
    'food and then not walking it to them and using give_item is the same as',
    'not helping at all. It drops the item nearby rather than placing it',
    'directly in their hands, so if you are told something was given to you,',
    'use collect_items to actually pick it up -- do not assume you already',
    'have it just because someone said so.',
    '',
    'You cannot fight, so animals are not a food source you can act on --',
    'there is no tool to hunt or kill one, only to mine blocks and harvest',
    'crops. If cattle or a hunt come up as the plan, that plan cannot work;',
    'look for berries, crops, or another farmable source instead.',
    '',
    'Sometimes a person will give you a standing order. It appears at the very',
    'top of your situation, it outranks your goal and your plans, and it stays',
    'until they lift it -- not until you decide it is finished. Follow it.',
    '',
    'Otherwise nobody is going to tell you what to do next. Decide.',
  ].join('\n');
}

/** Everything the observation needs beyond the bot itself and the turn number. */
export interface ObservationContext {
  heard?: HeardMessage[];
  goal?: string | null;
  places?: readonly Place[];
  /** Attempts already known not to work -- see agent/setbacks.ts. */
  setbacks?: readonly Setback[];
  /** How much of its chat allowance is left -- see agent/voice.ts. */
  voice?: readonly string[];
  /** A standing order from the operator, which outranks everything else. */
  order?: Order | null;
}

/** A compact, readable snapshot. JSON would cost more tokens and read worse. */
export function buildObservation(
  bot: Bot,
  cycle: number,
  context: ObservationContext = {},
): string {
  const {
    heard = [],
    goal = null,
    places = [],
    setbacks = [],
    voice = [],
    order = null,
  } = context;
  const self = observeSelf(bot);
  const inventory = observeInventory(bot);
  const entities = observeEntities(bot, ENTITY_RADIUS, MAX_ENTITIES);
  const blocks = observeBlocks(bot, BLOCK_RADIUS);

  const lines: string[] = [`--- turn ${cycle} ---`];

  // Before anything else, including the goal: an order that appeared after
  // three paragraphs of world state would be competing with them rather than
  // overriding them.
  lines.push(...describeOrder(order));

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

  // Without this an agent plots a rectangular building assuming flat ground,
  // collides with terrain on the columns that sit higher, and cannot tell
  // why -- which is very likely why builds end up dug into a hillside instead
  // of standing on the surface: every neighbour there is already solid, so
  // nothing collides. One line names the problem instead of leaving it to be
  // discovered as a string of unexplained `blocked` results.
  const ground = observeGroundProfile(bot, GROUND_RADIUS);
  if (ground.minY !== null && ground.maxY !== null) {
    const slope = ground.maxY - ground.minY;
    lines.push(
      slope <= FLAT_TOLERANCE
        ? `The ground within ${ground.radius} blocks is roughly level (around y${ground.minY}) -- a reasonable building spot.`
        : `The ground within ${ground.radius} blocks is NOT level -- it varies from y${ground.minY} to y${ground.maxY} ` +
            `(${slope} blocks of slope). A rectangular structure here will have some walls meet solid ground ` +
            `partway up and others hang in the air; level a pad first, terrace it, or find flatter ground.`,
    );
  }

  // Where it has been. An agent that has walked away from its shelter has no
  // other way to know that -- which is how one came to build a second shelter
  // two hundred blocks from the first while reporting it was finishing ours.
  lines.push(...describePlaces(places, self.position, self.dimension));

  // What was said to it. Without this an agent is woken by chat but cannot
  // hear a word of it, which is how it was until this was added.
  lines.push(...describeHearing(heard));

  // What it has already tried and failed. The history window is six turns, so
  // without this a failure from eight turns ago is simply gone -- which is how
  // one placement came to be attempted 110 times across seven runs.
  lines.push(...describeSetbacks(setbacks));
  lines.push(...voice);

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
      hasFood
        ? ''
        : 'You have nothing edible -- eating is not an option until you find food. ' +
            'A promise of food from someone else is not food: it only becomes real once ' +
            'you are standing next to them, they use give_item, and you collect_items to ' +
            'actually pick it up. Go to them, or go find your own, rather than waiting ' +
            'where you are.',
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
