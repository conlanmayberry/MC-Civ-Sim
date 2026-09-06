#!/usr/bin/env node
/**
 * Stage 3 Task 0 -- the pathfinder decision gate.
 *
 *     npm run bot:probe-path        (the Paper server must be running)
 *
 * Everything in Stage 3 stands on pathfinding: mine_block has to walk to the
 * block, collect_item has to walk to the drop. Before building eight actions on
 * that foundation, measure whether it holds on Minecraft 26.1.2.
 *
 * The specific worry is mineflayer-pathfinder#366 -- "GoalFollow is not working
 * as of >1.21.8, the bot gets stuck behind every 1-block obstacle, walking into
 * it instead of jumping", with 1.21.10, 1.21.11 and 26.2 reported broken and
 * 1.21.8 working. We are inside that range.
 *
 * WALK-ONLY vs DEFAULT is the point of this probe. Movements.canDig defaults to
 * true, so pathfinder is allowed to tunnel through anything in its way -- which
 * would hide a broken step-up behind a slower but successful route. Walk-only
 * (canDig = false) isolates navigation, which is what #366 is about. Default
 * measures what the bot will actually do in Stage 3.
 */

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import { loadConfig } from '../src/config.ts';

const { pathfinder, Movements, goals } = pathfinderPkg;

const GOTO_TIMEOUT_MS = 40_000;
const FOLLOW_TIMEOUT_MS = 30_000;
const DISTANCES = [10, 25, 40];

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const config = loadConfig();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  label: string;
  mode: 'walk-only' | 'default';
  requested: number;
  ok: boolean;
  elapsedMs: number;
  remaining: number;
  note: string;
}

/** First solid block with two air blocks above it, scanning down from the top. */
function groundAt(bot: Bot, x: number, z: number, fromY: number): Vec3 | null {
  for (let y = Math.floor(fromY) + 20; y > Math.floor(fromY) - 30; y--) {
    const here = bot.blockAt(new Vec3(x, y, z));
    const above1 = bot.blockAt(new Vec3(x, y + 1, z));
    const above2 = bot.blockAt(new Vec3(x, y + 2, z));
    if (here === null || above1 === null || above2 === null) continue;
    if (
      here.boundingBox === 'block' &&
      above1.boundingBox === 'empty' &&
      above2.boundingBox === 'empty'
    ) {
      return new Vec3(x, y + 1, z);
    }
  }
  return null;
}

/** A reachable-looking target at roughly `distance` blocks, or null. */
function pickTarget(bot: Bot, distance: number): Vec3 | null {
  const origin = bot.entity.position;
  // Sweep headings rather than guessing once: near spawn many directions are
  // unloaded or cliff faces, and a null target would look like a pathfinder
  // failure when it is really a bad question.
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const x = Math.round(origin.x + Math.cos(angle) * distance);
    const z = Math.round(origin.z + Math.sin(angle) * distance);
    const ground = groundAt(bot, x, z, origin.y);
    if (ground !== null) return ground;
  }
  return null;
}

async function tryGoto(
  bot: Bot,
  target: Vec3,
  mode: 'walk-only' | 'default',
  requested: number,
): Promise<Outcome> {
  const movements = new Movements(bot);
  if (mode === 'walk-only') {
    // Isolate navigation: no tunnelling, no scaffolding towers.
    movements.canDig = false;
    movements.allow1by1towers = false;
  }
  bot.pathfinder.setMovements(movements);

  const started = Date.now();
  let ok = false;
  let note = '';

  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)),
      sleep(GOTO_TIMEOUT_MS).then(() => {
        throw new Error('timeout');
      }),
    ]);
    ok = true;
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }

  bot.pathfinder.setGoal(null);
  await sleep(400);

  return {
    label: `goto ~${requested}m`,
    mode,
    requested,
    ok,
    elapsedMs: Date.now() - started,
    remaining: bot.entity.position.distanceTo(target),
    note,
  };
}

async function main(): Promise<void> {
  console.log('');
  console.log(`${BOLD}  Pathfinder gate${RESET}  Stage 3 Task 0 -- can we build on this?`);
  console.log(`  ${DIM}${config.host}:${config.port}, Minecraft ${config.version}${RESET}`);
  console.log('');

  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: 'PathProbe',
    version: config.version,
    auth: 'offline',
    logErrors: false,
  });

  bot.on('error', (err) => {
    console.error(`${RED}  connection error: ${err.message}${RESET}`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no spawn within 45s')), 45_000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  bot.loadPlugin(pathfinder);
  console.log(`  ${DIM}spawned; letting chunks settle ...${RESET}`);
  await sleep(5_000);

  // Get out of the spawn canopy so the benchmark measures navigation rather
  // than the leaf platform documented in ADR-006.
  if (bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name.includes('leaves') === true) {
    console.log(`  ${DIM}spawned in canopy; descending first ...${RESET}`);
    bot.setControlState('forward', true);
    const startY = bot.entity.position.y;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      if (bot.entity.position.y < startY - 5 && bot.entity.onGround) break;
    }
    bot.setControlState('forward', false);
    await sleep(1_500);
  }

  const standing = bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name ?? 'unknown';
  console.log(
    `  ${DIM}starting at y=${bot.entity.position.y.toFixed(0)} on ${standing}${RESET}`,
  );
  console.log('');

  const outcomes: Outcome[] = [];

  for (const mode of ['walk-only', 'default'] as const) {
    for (const distance of DISTANCES) {
      const target = pickTarget(bot, distance);
      if (target === null) {
        outcomes.push({
          label: `goto ~${distance}m`,
          mode,
          requested: distance,
          ok: false,
          elapsedMs: 0,
          remaining: Number.NaN,
          note: 'no reachable-looking target found (bad question, not a bad bot)',
        });
        continue;
      }
      const outcome = await tryGoto(bot, target, mode, distance);
      outcomes.push(outcome);
      const badge = outcome.ok ? `${GREEN}reached${RESET}` : `${RED}failed ${RESET}`;
      console.log(
        `  ${badge} ${outcome.label.padEnd(11)} ${outcome.mode.padEnd(10)} ` +
          `${(outcome.elapsedMs / 1000).toFixed(1)}s` +
          (outcome.ok ? '' : `  ${DIM}${outcome.remaining.toFixed(1)}m short -- ${outcome.note}${RESET}`),
      );
    }
  }
  console.log('');

  // --- the #366 scenario: follow a player that walks away -----------------
  console.log(`  ${DIM}follow test: a second bot walks away, this one follows${RESET}`);
  const runner = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: 'PathRunner',
    version: config.version,
    auth: 'offline',
    logErrors: false,
  });
  runner.on('error', () => {});

  let followOk = false;
  let followNote = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runner did not spawn')), 45_000);
      runner.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    runner.loadPlugin(pathfinder);
    await sleep(4_000);

    const target = bot.players['PathRunner']?.entity;
    if (target === undefined || target === null) {
      followNote = 'follower cannot see the runner';
    } else {
      const startDistance = bot.entity.position.distanceTo(target.position);

      // Runner walks off; follower chases with a dynamic goal.
      const away = pickTarget(runner, 20);
      if (away !== null) {
        void runner.pathfinder
          .goto(new goals.GoalNear(away.x, away.y, away.z, 2))
          .catch(() => {});
      }
      bot.pathfinder.setMovements(new Movements(bot));
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);

      await sleep(FOLLOW_TIMEOUT_MS);
      bot.pathfinder.setGoal(null);

      const endDistance = bot.entity.position.distanceTo(target.position);
      followOk = endDistance <= 6;
      followNote = `start ${startDistance.toFixed(1)}m -> end ${endDistance.toFixed(1)}m`;
    }
  } catch (err) {
    followNote = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      runner.quit('done');
    } catch {
      /* already gone */
    }
  }

  console.log(
    `  ${followOk ? `${GREEN}ok     ${RESET}` : `${RED}failed ${RESET}`} GoalFollow  ${DIM}${followNote}${RESET}`,
  );
  console.log('');

  // --- verdict ------------------------------------------------------------
  const attempted = outcomes.filter((o) => !o.note.startsWith('no reachable'));
  const walkOnly = attempted.filter((o) => o.mode === 'walk-only');
  const dflt = attempted.filter((o) => o.mode === 'default');
  const rate = (list: Outcome[]): string =>
    list.length === 0 ? 'n/a' : `${list.filter((o) => o.ok).length}/${list.length}`;

  console.log(`${BOLD}  Summary${RESET}`);
  console.log(`    walk-only (canDig=false)  ${rate(walkOnly)}   ${DIM}isolates navigation (#366)${RESET}`);
  console.log(`    default   (canDig=true)   ${rate(dflt)}   ${DIM}what Stage 3 will actually do${RESET}`);
  console.log(`    GoalFollow                ${followOk ? '1/1' : '0/1'}`);
  console.log('');

  const walkOk = walkOnly.filter((o) => o.ok).length;
  const dfltOk = dflt.filter((o) => o.ok).length;
  const goodEnough = dfltOk >= Math.max(1, dflt.length - 1) && (walkOk > 0 || followOk);

  if (goodEnough) {
    console.log(`  ${GREEN}${BOLD}GATE PASSED.${RESET} Pathfinding is a sound foundation for Stage 3.`);
    if (walkOk < walkOnly.length) {
      console.log(
        `  ${YELLOW}Note: walk-only is weaker than default, so some routes depend on digging.${RESET}`,
      );
    }
  } else {
    console.log(`  ${RED}${BOLD}GATE FAILED.${RESET} Do not build Stage 3 on this.`);
    console.log(`  This independently confirms mineflayer-pathfinder#366 for ${config.version}.`);
    console.log(`  Options: drop to Minecraft 1.21.8 (reported working), or add step-up`);
    console.log(`  assistance ourselves. Operator decision -- record these numbers in ADR-006.`);
  }
  console.log('');

  bot.quit('probe complete');
  process.exitCode = goodEnough ? 0 : 1;
  setTimeout(() => process.exit(goodEnough ? 0 : 1), 500);
}

await main();
