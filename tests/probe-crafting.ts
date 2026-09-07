#!/usr/bin/env node
/**
 * Why do 2x2 stick crafts fail while 2x2 table crafts succeed?
 *
 *     npm run bot:probe-craft        (the Paper server must be running)
 *
 * From a live run: asking for 8 sticks consumed 2 planks, produced no sticks,
 * and failed with "Event updateSlot:0 did not fire" -- twice. Ten minutes later
 * a crafting table (also a 2x2 in-inventory recipe, also from planks) crafted
 * without complaint. Both use the player's own crafting grid, so "2x2 is
 * broken" cannot be the explanation.
 *
 * The difference worth testing is REPETITIONS. A stick recipe yields 4 per
 * craft, so 8 sticks is two repetitions; a crafting table yields 1, so it is
 * always exactly one. If multi-repetition crafts are what break, that is a
 * bounded problem with an obvious fix, and it would also explain where the
 * planks went: ingredients left in the 2x2 grid are dropped on the floor when
 * the inventory closes, which looks exactly like materials being destroyed.
 *
 * This probe joins as its own player, gives itself known materials through
 * observation only (it mines its own wood), and reports what actually happens.
 * It changes nothing that another agent depends on.
 */

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';

import { loadConfig } from '../src/config.ts';
import { createActions } from '../src/bot/actions/index.ts';
import { createLogger, consoleSink } from '../src/util/log.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const config = loadConfig();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

interface Attempt {
  label: string;
  want: string;
  repetitions: number;
  ok: boolean;
  /** No materials left to run this case -- not evidence either way. */
  skipped: boolean;
  gained: number;
  consumed: number;
  elapsedMs: number;
  note: string;
}

/** One craft, measured by what the inventory says rather than what craft() says. */
async function attempt(
  bot: Bot,
  label: string,
  want: string,
  repetitions: number,
  ingredient: string,
): Promise<Attempt> {
  const item = bot.registry.itemsByName[want];
  if (item === undefined) {
    return {
      label,
      want,
      repetitions,
      ok: false,
      skipped: true,
      gained: 0,
      consumed: 0,
      elapsedMs: 0,
      note: 'no such item',
    };
  }

  const before = count(bot, want);
  const beforeIngredient = count(bot, ingredient);
  const started = Date.now();

  // minResultCount of 1: we are choosing the repetition count ourselves, which
  // is the variable under test.
  const recipe = bot.recipesFor(item.id, null, 1, null)[0];
  if (recipe === undefined) {
    return {
      label,
      want,
      repetitions,
      ok: false,
      // Distinguished from a failure on purpose: an earlier case in this
      // sequence ate the materials, so this one was never actually tested.
      skipped: true,
      gained: 0,
      consumed: 0,
      elapsedMs: 0,
      note: `skipped -- only ${beforeIngredient} ${ingredient} left to work with`,
    };
  }

  let note = `yields ${recipe.result?.count ?? 1} per craft`;
  try {
    await bot.craft(recipe, repetitions, undefined);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }

  // Let the inventory settle before judging, the same way craft.ts does.
  let gained = 0;
  for (let i = 0; i < 8; i++) {
    await sleep(150);
    gained = count(bot, want) - before;
    if (gained > 0) break;
  }

  return {
    label,
    want,
    repetitions,
    ok: gained > 0,
    skipped: false,
    gained,
    consumed: beforeIngredient - count(bot, ingredient),
    elapsedMs: Date.now() - started,
    note,
  };
}

async function main(): Promise<void> {
  console.log('');
  console.log(`${BOLD}  Crafting probe${RESET}  do multi-repetition 2x2 crafts break?`);
  console.log(`  ${DIM}${config.host}:${config.port}, Minecraft ${config.version}${RESET}`);
  console.log('');

  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: 'CraftProbe',
    version: config.version,
    auth: 'offline',
    logErrors: false,
  });

  bot.on('error', (err) => {
    console.error(`${RED}  connection error: ${err.message}${RESET}`);
    process.exitCode = 1;
  });

  await new Promise<void>((resolve) => bot.once('spawn', () => resolve()));
  await sleep(1_500);

  const results: Attempt[] = [];

  try {
    // Materials, gathered rather than granted: /give would need operator, and
    // the point is to reproduce what an agent actually does.
    let logName = bot.inventory
      .items()
      .map((i) => i.name)
      .find((n) => n.endsWith('_log'));

    if (logName === undefined) {
      // Mine its own, through the project's own action layer -- so the probe
      // needs nothing granted to it and exercises the same code the agent does.
      const actions = createActions(bot, createLogger('craft-probe', consoleSink));
      const kinds = ['spruce_log', 'oak_log', 'birch_log', 'dark_oak_log', 'jungle_log'];
      const found = kinds.find(
        (k) =>
          bot.findBlock({
            matching: bot.registry.blocksByName[k]?.id ?? -1,
            maxDistance: 48,
          }) !== null,
      );

      if (found === undefined) {
        console.log(`  ${DIM}No trees within 48 blocks and nothing in the inventory.${RESET}`);
        console.log(`  ${DIM}From the server console: give CraftProbe spruce_log 16${RESET}`);
        console.log('');
        bot.quit();
        return;
      }

      console.log(`  ${DIM}gathering ${found} to work with...${RESET}`);
      await actions.mineBlock(found, 4, 48);
      await actions.collectNearbyItems(12);
      await sleep(500);
      logName = bot.inventory
        .items()
        .map((i) => i.name)
        .find((n) => n.endsWith('_log'));
    }

    if (logName === undefined) {
      console.log(`  ${DIM}Could not gather any wood; nothing to craft with.${RESET}`);
      console.log('');
      bot.quit();
      return;
    }

    const plank = logName.replace('_log', '_planks');

    // One repetition, result count 4: the shape that failed in the live run.
    results.push(await attempt(bot, 'planks x1 rep', plank, 1, logName));
    results.push(await attempt(bot, 'sticks x1 rep', 'stick', 1, plank));
    results.push(await attempt(bot, 'sticks x2 reps', 'stick', 2, plank));
    results.push(await attempt(bot, 'table x1 rep', 'crafting_table', 1, plank));

    // Phase 2: the same shapes through the project's own craftItem, which is
    // what the agent actually calls. The interesting case is asking for more
    // than the materials allow -- that is what happened live.
    const actions = createActions(bot, createLogger('craft-probe', () => {}));
    console.log('');
    console.log(`${BOLD}  Through craftItem (what the agent calls)${RESET}`);
    for (const [want, howMany] of [
      [plank, 8],
      ['stick', 8],
      ['stick', 64],
    ] as Array<[string, number]>) {
      const result = await actions.craftItem(want, howMany);
      const detail = result.detail as Record<string, unknown>;
      console.log(
        `  ${(want + ' x' + howMany).padEnd(20)} ${result.ok ? `${GREEN}ok${RESET}    ` : `${RED}FAILED${RESET}`} ` +
          `gained=${String(detail['gained'] ?? 0).padEnd(4)} ` +
          `${String(detail['note'] ?? result.error?.message ?? '').slice(0, 60)}`,
      );
    }
    console.log('');

    console.log(`${BOLD}  attempt          reps  result   gained  used  ms     note${RESET}`);
    console.log(`  ${DIM}${'-'.repeat(86)}${RESET}`);
    for (const r of results) {
      const verdict = r.skipped
        ? `${DIM}skip  ${RESET}`
        : r.ok
          ? `${GREEN}ok    ${RESET}`
          : `${RED}FAILED${RESET}`;
      console.log(
        `  ${r.label.padEnd(16)} ${String(r.repetitions).padEnd(5)} ${verdict}  ` +
          `${String(r.gained).padEnd(7)} ${String(r.consumed).padEnd(5)} ` +
          `${String(r.elapsedMs).padEnd(6)} ${r.note.slice(0, 40)}`,
      );
    }

    console.log('');
    const tested = results.filter((r) => !r.skipped);
    const singles = tested.filter((r) => r.repetitions === 1);
    const multis = tested.filter((r) => r.repetitions > 1);
    const singlesOk = singles.every((r) => r.ok);
    const multisOk = multis.every((r) => r.ok);

    // The finding is not "multi-rep fails" but something narrower and worse: a
    // call that partly succeeded still comes back as an exception, so a caller
    // trusting the exception throws away what it just made.
    const lied = tested.filter((r) => r.gained > 0 && /error|did not fire|missing/i.test(r.note));

    if (tested.length === 0) {
      console.log(`  ${BOLD}Nothing was tested${RESET} -- there were no materials to work with.`);
    } else if (lied.length > 0) {
      console.log(
        `  ${BOLD}Confirmed:${RESET} ${lied.map((r) => r.label).join(', ')} threw an exception ` +
          `while
  actually producing items. bot.craft(recipe, n) does not check it can afford`,
      );
      console.log(
        `  n repetitions -- it performs what it can and throws on the one it cannot,`,
      );
      console.log(`  so a caller that trusts the exception discards real work.`);
      console.log(
        `  ${DIM}craft.ts therefore does one repetition at a time and counts the inventory.${RESET}`,
      );
    } else if (singlesOk && !multisOk) {
      console.log(
        `  ${BOLD}Confirmed:${RESET} single repetitions work, multiple do not. ` +
          `Craft one repetition at a time.`,
      );
    } else if (singlesOk && multisOk) {
      console.log(`  ${BOLD}Not reproduced:${RESET} both shapes worked here. The live failure`);
      console.log(`  had another cause -- inventory state or timing, not repetitions.`);
    } else {
      console.log(`  ${BOLD}Something broader is wrong:${RESET} even single repetitions failed.`);
    }

    const lost = results.filter((r) => !r.ok && r.consumed > 0);
    if (lost.length > 0) {
      console.log('');
      console.log(
        `  ${RED}Materials went missing${RESET} on: ${lost.map((r) => r.label).join(', ')}.`,
      );
      console.log(
        `  ${DIM}Ingredients left in the 2x2 grid are dropped on the floor when the`,
      );
      console.log(`  inventory closes -- check the ground under the probe.${RESET}`);
    }
  } finally {
    console.log('');
    bot.quit();
  }
}

void main();
