#!/usr/bin/env node
/**
 * Stage 3 gate follow-up: is pathfinding broken by the VERSION or by the TERRAIN?
 *
 *     npm run diagnose:pathfinder
 *
 * `npm run bot:probe-path` failed 0/7 on our live 26.1.2 world. Pathfinder
 * computes a route fine (9 moves in 43 ms) and then wedges partway through it:
 * the bot stops moving while `isMoving()` still reports true, so `goto` never
 * settles. That matches mineflayer-pathfinder#366, which reports 1.21.10,
 * 1.21.11 and 26.2 broken and 1.21.8 working.
 *
 * Two explanations remain, and they have very different costs:
 *
 *   VERSION  -- 26.1.2 is inside the broken range. Fix: drop to 1.21.8, which
 *               means a new jar, a regenerated world, re-verifying Stages 1-2
 *               and revising ADR-001.
 *   TERRAIN  -- our spawn is dense spruce forest, already shown in ADR-006 to be
 *               unusually hostile. Fix: nothing structural.
 *
 * This runs the same pathfinder benchmark across a 2x2 matrix -- {26.1.2,
 * 1.21.8} x {superflat, normal terrain} -- on temporary loopback-only servers
 * that are deleted afterwards. The real civ-sim-world is untouched.
 *
 * Takes roughly 8 minutes: four server boots plus four benchmarks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import { ROOT } from '../src/config.ts';

const { pathfinder, Movements, goals } = pathfinderPkg;

const WORK_DIR = path.join(ROOT, '.diagnose');

/** Verified 2026-09-06 against fill.papermc.io. */
const BUILDS = {
  '26.1.2': {
    jar: path.join(ROOT, 'minecraft', 'server', 'paper-26.1.2-74.jar'),
    url: null as string | null,
    sha256: '1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7',
  },
  '1.21.8': {
    jar: path.join(WORK_DIR, 'paper-1.21.8-60.jar'),
    url: 'https://fill-data.papermc.io/v1/objects/8de7c52c3b02403503d16fac58003f1efef7dd7a0256786843927fa92ee57f1e/paper-1.21.8-60.jar',
    sha256: '8de7c52c3b02403503d16fac58003f1efef7dd7a0256786843927fa92ee57f1e',
  },
};

const BOOT_TIMEOUT_MS = 240_000;
const GOTO_TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;
const TARGET_DISTANCE = 15;
const BASE_PORT = 25581;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

type WorldKind = 'superflat' | 'normal';

interface Combo {
  version: keyof typeof BUILDS;
  world: WorldKind;
  port: number;
}

interface Outcome {
  version: string;
  world: WorldKind;
  reached: number;
  attempted: number;
  wedged: number;
  note: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sha256Of(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

async function ensureJar(version: keyof typeof BUILDS): Promise<string> {
  const spec = BUILDS[version];
  try {
    if ((await sha256Of(spec.jar)) === spec.sha256) return spec.jar;
  } catch {
    /* not present */
  }
  if (spec.url === null) {
    throw new Error(`${version} jar missing at ${spec.jar} -- run npm run minecraft:setup`);
  }
  console.log(`  downloading Paper ${version} ...`);
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await fs.writeFile(spec.jar, Buffer.from(await res.arrayBuffer()));
  const actual = await sha256Of(spec.jar);
  if (actual !== spec.sha256) {
    await fs.rm(spec.jar, { force: true });
    throw new Error(`SHA-256 mismatch for ${version}`);
  }
  console.log(`  ${GREEN}verified${RESET} ${DIM}Paper ${version}${RESET}`);
  return spec.jar;
}

async function writeConfig(dir: string, port: number, world: WorldKind): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    'server-ip=127.0.0.1',
    `server-port=${port}`,
    'online-mode=false',
    `level-type=${world === 'superflat' ? 'minecraft:flat' : 'minecraft:normal'}`,
    'level-name=pf-world',
    // A fixed seed keeps the two versions' "normal" worlds comparable in
    // character, even though generation differs between versions.
    'level-seed=424242',
    'gamemode=survival',
    'difficulty=peaceful',
    'spawn-monsters=false',
    'spawn-animals=false',
    'spawn-protection=0',
    'view-distance=8',
    'simulation-distance=8',
    'max-players=5',
    'motd=pathfinder diagnosis',
    '',
  ];
  await fs.writeFile(path.join(dir, 'server.properties'), lines.join('\n'), 'utf8');
  await fs.writeFile(
    path.join(dir, 'eula.txt'),
    `# Accepted interactively via npm run diagnose:pathfinder\n# https://aka.ms/MinecraftEULA\n# ${new Date().toISOString()}\neula=true\n`,
    'utf8',
  );
}

function startServer(jar: string, dir: string, label: string): { proc: ChildProcess; ready: Promise<void> } {
  const proc = spawn('java', ['-Xms1G', '-Xmx2G', '-XX:+UseG1GC', '-jar', jar, '--nogui'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} boot timed out`)), BOOT_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes('For help, type "help"')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited during boot (code ${String(code)})`));
    });
  });
  return { proc, ready };
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.stdin?.write('stop\n');
  await Promise.race([
    new Promise<void>((r) => proc.once('exit', () => r())),
    sleep(30_000).then(() => {
      proc.kill();
    }),
  ]);
}

/** First solid block with two air blocks above, scanning down. */
function groundAt(bot: Bot, x: number, z: number, fromY: number): Vec3 | null {
  for (let y = Math.floor(fromY) + 10; y > Math.floor(fromY) - 20; y--) {
    const here = bot.blockAt(new Vec3(x, y, z));
    const a1 = bot.blockAt(new Vec3(x, y + 1, z));
    const a2 = bot.blockAt(new Vec3(x, y + 2, z));
    if (here === null || a1 === null || a2 === null) continue;
    if (here.boundingBox === 'block' && a1.boundingBox === 'empty' && a2.boundingBox === 'empty') {
      return new Vec3(x, y + 1, z);
    }
  }
  return null;
}

async function benchmark(version: string, world: WorldKind, port: number): Promise<Outcome> {
  const outcome: Outcome = { version, world, reached: 0, attempted: 0, wedged: 0, note: '' };

  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    username: 'PathBench',
    version,
    auth: 'offline',
    logErrors: false,
  });
  bot.on('error', () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no spawn within 45s')), 45_000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      bot.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    bot.loadPlugin(pathfinder);
    await sleep(5_000);

    // Get off any leaf canopy first -- ADR-006 showed that is its own problem.
    if ((bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name ?? '').includes('leaves')) {
      bot.setControlState('forward', true);
      const y0 = bot.entity.position.y;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        if (bot.entity.position.y < y0 - 5 && bot.entity.onGround) break;
      }
      bot.setControlState('forward', false);
      await sleep(1_500);
    }

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const origin = bot.entity.position.clone();
      let target: Vec3 | null = null;
      for (let i = 0; i < 12 && target === null; i++) {
        const angle = (i / 12) * Math.PI * 2 + attempt;
        target = groundAt(
          bot,
          Math.round(origin.x + Math.cos(angle) * TARGET_DISTANCE),
          Math.round(origin.z + Math.sin(angle) * TARGET_DISTANCE),
          origin.y,
        );
      }
      if (target === null) continue;

      outcome.attempted++;
      bot.pathfinder.setMovements(new Movements(bot));

      let settled = false;
      void bot.pathfinder
        .goto(new goals.GoalNear(target.x, target.y, target.z, 2))
        .then(() => {
          settled = true;
        })
        .catch(() => {
          settled = true;
        });

      // Poll for a wedge: still "moving" but the position has not changed.
      let last = bot.entity.position.clone();
      let still = 0;
      const deadline = Date.now() + GOTO_TIMEOUT_MS;
      while (Date.now() < deadline && !settled) {
        await sleep(500);
        const now = bot.entity.position;
        if (now.distanceTo(last) < 0.1 && bot.pathfinder.isMoving()) still++;
        else still = 0;
        last = now.clone();
      }

      const reached = bot.entity.position.distanceTo(target) <= 3;
      if (reached) outcome.reached++;
      else if (still >= 4) outcome.wedged++;

      bot.pathfinder.setGoal(null);
      await sleep(800);
    }
  } catch (err) {
    outcome.note = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      bot.quit('bench done');
    } catch {
      /* gone */
    }
    await sleep(600);
  }

  return outcome;
}

// --- main ---------------------------------------------------------------

console.log('');
console.log(`${BOLD}  Pathfinder diagnosis${RESET}  version vs terrain, 2x2 matrix`);
console.log('');

if (!process.stdin.isTTY) {
  console.error(`${RED}  Needs an interactive terminal for the EULA prompt.${RESET}`);
  process.exit(1);
}

console.log(`  Creates four TEMPORARY loopback-only servers (ports ${BASE_PORT}-${BASE_PORT + 3}),`);
console.log(`  benchmarks pathfinding on each, then deletes them. Takes ~8 minutes.`);
console.log(`  civ-sim-world is not touched.`);
console.log('');
console.log(`  Minecraft EULA: ${BOLD}https://aka.ms/MinecraftEULA${RESET}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('  Accept the Minecraft EULA for these test servers? [y/N] ')).trim();
rl.close();
console.log('');

if (answer.toLowerCase() !== 'y') {
  console.log(`  ${YELLOW}Not accepted -- nothing was created.${RESET}\n`);
  process.exit(1);
}

await fs.mkdir(WORK_DIR, { recursive: true });

const combos: Combo[] = [
  { version: '26.1.2', world: 'superflat', port: BASE_PORT },
  { version: '26.1.2', world: 'normal', port: BASE_PORT + 1 },
  { version: '1.21.8', world: 'superflat', port: BASE_PORT + 2 },
  { version: '1.21.8', world: 'normal', port: BASE_PORT + 3 },
];

const results: Outcome[] = [];

try {
  for (const version of ['26.1.2', '1.21.8'] as const) await ensureJar(version);
  console.log('');

  for (const combo of combos) {
    const label = `${combo.version} / ${combo.world}`;
    const dir = path.join(WORK_DIR, `pf-${combo.version}-${combo.world}`);
    console.log(`${BOLD}  ${label}${RESET} ${DIM}(port ${combo.port})${RESET}`);
    await writeConfig(dir, combo.port, combo.world);

    const { proc, ready } = startServer(BUILDS[combo.version].jar, dir, label);
    try {
      await ready;
      console.log(`  ${DIM}up; benchmarking ${ATTEMPTS} goto attempts at ~${TARGET_DISTANCE}m ...${RESET}`);
      const outcome = await benchmark(combo.version, combo.world, combo.port);
      results.push(outcome);
      const good = outcome.attempted > 0 && outcome.reached === outcome.attempted;
      console.log(
        `  ${good ? GREEN : RED}${outcome.reached}/${outcome.attempted} reached${RESET}` +
          (outcome.wedged > 0 ? ` ${DIM}(${outcome.wedged} wedged mid-path)${RESET}` : '') +
          (outcome.note !== '' ? ` ${DIM}${outcome.note}${RESET}` : ''),
      );
    } catch (err) {
      console.log(`  ${RED}failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      results.push({
        version: combo.version,
        world: combo.world,
        reached: 0,
        attempted: 0,
        wedged: 0,
        note: 'server failed',
      });
    } finally {
      await stopServer(proc);
      await fs.rm(dir, { recursive: true, force: true });
      console.log('');
    }
  }
} finally {
  // Worlds are removed above; jars stay so a re-run skips the download.
}

console.log(`${BOLD}  Results${RESET}`);
console.log('');
console.log(`  ${'version'.padEnd(10)} ${'world'.padEnd(11)} reached   wedged`);
console.log(`  ${'-'.repeat(44)}`);
for (const r of results) {
  const good = r.attempted > 0 && r.reached === r.attempted;
  console.log(
    `  ${r.version.padEnd(10)} ${r.world.padEnd(11)} ` +
      `${(good ? GREEN : RED)}${r.reached}/${r.attempted}${RESET}       ${r.wedged}`,
  );
}
console.log('');

const find = (v: string, w: WorldKind): Outcome | undefined =>
  results.find((x) => x.version === v && x.world === w);
const allReached = (o: Outcome | undefined): boolean =>
  o !== undefined && o.attempted > 0 && o.reached === o.attempted;

const newFlat = find('26.1.2', 'superflat');
const newNormal = find('26.1.2', 'normal');
const oldNormal = find('1.21.8', 'normal');

// Distinguish WEDGING (hangs forever, unrecoverable) from FAILING (returns, and
// a caller can react). They look similar in a success rate and are completely
// different to build on, so the verdict has to read the wedged column.
const newWedges = (newNormal?.wedged ?? 0) > 0;
const oldWedges = (oldNormal?.wedged ?? 0) > 0;
const terrainHardForBoth =
  (newNormal?.reached ?? 0) < (newNormal?.attempted ?? 0) &&
  (oldNormal?.reached ?? 0) < (oldNormal?.attempted ?? 0);

if (allReached(newFlat) && newWedges && !oldWedges) {
  console.log(`  ${YELLOW}${BOLD}BOTH -- and the difference that matters is HOW they fail.${RESET}`);
  console.log('');
  console.log(`  Pathfinding works on 26.1.2 (${newFlat?.reached}/${newFlat?.attempted} on superflat), so the version is`);
  console.log(`  not fundamentally broken. But on normal terrain 26.1.2 WEDGES`);
  console.log(`  (${newNormal?.wedged}/${newNormal?.attempted}) while 1.21.8 does not (${oldNormal?.wedged}/${oldNormal?.attempted}) -- that is #366, isolated.`);
  console.log('');
  console.log(`  A wedge hangs forever and cannot be recovered from. A failure returns`);
  console.log(`  and the caller can react. Terrain is hard for both versions`);
  console.log(`  (1.21.8 managed only ${oldNormal?.reached}/${oldNormal?.attempted}), so downgrading trades a hang for a`);
  console.log(`  failure without making the terrain easier.`);
  console.log('');
  console.log(`  ${GREEN}Recommended: keep 26.1.2 and detect the wedge in our own movement${RESET}`);
  console.log(`  ${GREEN}action -- abort the goal and return a typed 'unreachable' result.${RESET}`);
} else if (!allReached(newFlat) && allReached(find('1.21.8', 'superflat'))) {
  console.log(`  ${YELLOW}${BOLD}VERSION.${RESET} 26.1.2 fails even on superflat while 1.21.8 does not.`);
  console.log(`  Downgrading is justified: new pin, regenerated world, re-verify Stages 1-2,`);
  console.log(`  revise ADR-001. Paper 1.21.8 is EOL (support ended 2025-11-14).`);
} else if (allReached(newFlat) && !newWedges && terrainHardForBoth) {
  console.log(`  ${GREEN}${BOLD}TERRAIN.${RESET} No wedging on either version; complex terrain is simply hard.`);
  console.log(`  Keep the version. Improve the operating area or accept a lower success rate.`);
} else if (!allReached(newFlat) && !allReached(find('1.21.8', 'superflat'))) {
  console.log(`  ${RED}${BOLD}NEITHER VERSION WORKS, even on flat ground.${RESET} A downgrade will not help.`);
  console.log(`  Report upstream and consider driving movement without pathfinder.`);
} else {
  console.log(`  ${YELLOW}Mixed result -- read the wedged column above before concluding.${RESET}`);
}
console.log('');
