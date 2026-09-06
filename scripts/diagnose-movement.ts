#!/usr/bin/env node
/**
 * ADR-006 movement diagnosis: vanilla vs Paper, controlled.
 *
 *     npm run diagnose:movement
 *
 * Stage 2 established that a Mineflayer bot cannot walk on our Paper 26.1.2
 * server: the server issues ~17 position corrections per second while the bot
 * walks, and none while it stands still. The open question is whether Paper's
 * movement validation is responsible, or whether this is Mojang-side.
 *
 * This script answers that by running the SAME movement test against a vanilla
 * Mojang server and against Paper, on two freshly generated **superflat** worlds
 * so that terrain, world seed and spawn position cannot explain a difference.
 * Everything else -- Minecraft version, Java, mineflayer, our config -- is held
 * constant.
 *
 * Both servers are temporary, bound to loopback, on their own ports, and are
 * deleted afterwards. Nothing touches the real civ-sim-world.
 *
 * The EULA is prompted for once, interactively, and never auto-accepted --
 * same rule as `npm run minecraft:setup` (ADR-002 neighbours).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';

import { ROOT } from '../src/config.ts';

const WORK_DIR = path.join(ROOT, '.diagnose');
const PAPER_JAR = path.join(ROOT, 'minecraft', 'server', 'paper-26.1.2-74.jar');

const VANILLA = {
  url: 'https://piston-data.mojang.com/v1/objects/97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51/server.jar',
  sha1: '97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51',
  // From Mojang's own version manifest for 26.1.2, fetched 2026-09-06.
};

/**
 * `--live` measures the ALREADY-RUNNING civ-sim-world server instead of
 * creating temporary ones. Nothing is downloaded, no server is started or
 * stopped, and no EULA prompt is needed -- so it is safe to run at any time.
 */
const LIVE_ONLY = process.argv.includes('--live');
const LIVE_PORT = Number(process.env['MC_PORT'] ?? 25565);

const BOOT_TIMEOUT_MS = 180_000;
const WALK_SECONDS = 5;
const MC_VERSION = '26.1.2';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

interface Target {
  name: string;
  jar: string;
  port: number;
  dir: string;
}

interface Result {
  target: string;
  spawned: boolean;
  movedBlocks: number;
  correctionsWalking: number;
  correctionsIdle: number;
  physicsTicks: number;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sha1Of(file: string): Promise<string> {
  const hash = createHash('sha1');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

async function ensureVanillaJar(): Promise<string> {
  const jar = path.join(WORK_DIR, 'vanilla-26.1.2.jar');

  try {
    if ((await sha1Of(jar)) === VANILLA.sha1) {
      console.log(`  ${DIM}vanilla jar already present and verified${RESET}`);
      return jar;
    }
  } catch {
    // Not downloaded yet.
  }

  console.log(`  downloading the vanilla 26.1.2 server from Mojang ...`);
  const res = await fetch(VANILLA.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await fs.writeFile(jar, Buffer.from(await res.arrayBuffer()));

  const actual = await sha1Of(jar);
  if (actual !== VANILLA.sha1) {
    await fs.rm(jar, { force: true });
    throw new Error(`SHA-1 mismatch: expected ${VANILLA.sha1}, got ${actual}`);
  }
  console.log(`  ${GREEN}verified${RESET} ${DIM}SHA-1 ${actual}${RESET}`);
  return jar;
}

/**
 * Superflat, no structures, no mobs, loopback only. A flat world removes
 * terrain as an explanation for a bot that will not move.
 */
async function writeServerConfig(dir: string, port: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'server.properties'),
    [
      `server-ip=127.0.0.1`,
      `server-port=${port}`,
      `online-mode=false`,
      `level-type=minecraft:flat`,
      `level-name=diagnose-world`,
      `level-seed=1`,
      `gamemode=survival`,
      `difficulty=peaceful`,
      `spawn-monsters=false`,
      `spawn-animals=false`,
      `generate-structures=false`,
      `spawn-protection=0`,
      `view-distance=6`,
      `simulation-distance=6`,
      `max-players=5`,
      `sync-chunk-writes=false`,
      `motd=movement diagnosis`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'eula.txt'),
    `# Accepted interactively via npm run diagnose:movement\n# https://aka.ms/MinecraftEULA\n# ${new Date().toISOString()}\neula=true\n`,
    'utf8',
  );
}

function startServer(target: Target): { proc: ChildProcess; ready: Promise<void> } {
  const proc = spawn(
    'java',
    ['-Xms1G', '-Xmx2G', '-XX:+UseG1GC', '-jar', target.jar, '--nogui'],
    { cwd: target.dir, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${target.name} did not finish booting in ${BOOT_TIMEOUT_MS / 1000}s`)),
      BOOT_TIMEOUT_MS,
    );

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (text.includes('For help, type "help"')) {
        clearTimeout(timer);
        resolve();
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${target.name} exited during boot (code ${String(code)})`));
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

/** Connect, stand still, then walk. Count corrections in each phase. */
async function measureMovement(target: Target): Promise<Result> {
  const result: Result = {
    target: target.name,
    spawned: false,
    movedBlocks: 0,
    correctionsWalking: 0,
    correctionsIdle: 0,
    physicsTicks: 0,
  };

  const bot: Bot = mineflayer.createBot({
    host: '127.0.0.1',
    port: target.port,
    username: 'MoveDiag',
    version: MC_VERSION,
    auth: 'offline',
    logErrors: false,
  });

  let corrections = 0;
  let ticks = 0;

  // minecraft-protocol types _client.on for a fixed event union, so the raw
  // packet name needs a narrow structural cast rather than `any`.
  const client = bot._client as unknown as {
    on: (event: string, listener: () => void) => void;
  };
  client.on('position', () => {
    corrections++;
  });
  bot.on('physicsTick', () => {
    ticks++;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no spawn within 45s')), 45_000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      bot.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    result.spawned = true;

    // Let chunks settle and the bot come to rest on the flat ground.
    await sleep(4_000);

    corrections = 0;
    await sleep(WALK_SECONDS * 1000);
    result.correctionsIdle = corrections;

    await bot.look(0, 0, true);
    corrections = 0;
    ticks = 0;
    const start = bot.entity.position.clone();

    bot.setControlState('forward', true);
    await sleep(WALK_SECONDS * 1000);
    bot.setControlState('forward', false);

    result.correctionsWalking = corrections;
    result.physicsTicks = ticks;
    result.movedBlocks = start.distanceTo(bot.entity.position);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      bot.quit('diagnosis complete');
    } catch {
      // Already gone.
    }
    await sleep(500);
  }

  return result;
}

async function run(target: Target): Promise<Result> {
  console.log(`${BOLD}  ${target.name}${RESET} ${DIM}(port ${target.port}, superflat)${RESET}`);
  await writeServerConfig(target.dir, target.port);

  const { proc, ready } = startServer(target);
  try {
    console.log(`  ${DIM}booting ...${RESET}`);
    await ready;
    console.log(`  ${DIM}up; measuring ...${RESET}`);
    const result = await measureMovement(target);
    return result;
  } finally {
    await stopServer(proc);
    console.log(`  ${DIM}stopped${RESET}`);
    console.log('');
  }
}

// --- main ---------------------------------------------------------------

console.log('');

if (LIVE_ONLY) {
  console.log(`${BOLD}  ADR-006 movement diagnosis${RESET}  live civ-sim-world server`);
  console.log(`  ${DIM}measuring 127.0.0.1:${LIVE_PORT} -- nothing is created or changed${RESET}`);
  console.log('');

  const live = await measureMovement({
    name: 'civ-sim-world',
    jar: '',
    port: LIVE_PORT,
    dir: '',
  });

  if (live.error !== undefined) {
    console.log(`  ${RED}failed: ${live.error}${RESET}`);
    console.log(`  ${DIM}is the server running? npm run minecraft${RESET}`);
    console.log('');
    process.exit(1);
  }

  const walks = live.movedBlocks > 3;
  console.log(`  moved            ${(walks ? GREEN : RED)}${live.movedBlocks.toFixed(2)}m${RESET} in ${WALK_SECONDS}s`);
  console.log(`  corrections      ${live.correctionsWalking} while walking, ${live.correctionsIdle} while idle`);
  console.log(`  physics ticks    ${live.physicsTicks} ${DIM}(expect ~${WALK_SECONDS * 20})${RESET}`);
  console.log('');
  console.log(
    walks
      ? `  ${GREEN}${BOLD}The bot walks here.${RESET} Compare against the superflat baseline.`
      : `  ${RED}${BOLD}The bot cannot walk here${RESET}, but it can on a superflat world --
  so this is specific to this world, not to mineflayer or Paper.`,
  );
  console.log('');
  process.exit(walks ? 0 : 1);
}

console.log(`${BOLD}  ADR-006 movement diagnosis${RESET}  vanilla vs Paper, identical superflat worlds`);
console.log('');

if (!process.stdin.isTTY) {
  console.error(`${RED}  This script needs an interactive terminal for the EULA prompt.${RESET}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`  This creates two TEMPORARY local Minecraft servers (loopback only,`);
console.log(`  ports 25577 and 25578) and deletes them afterwards.`);
console.log('');
console.log(`  Minecraft EULA: ${BOLD}https://aka.ms/MinecraftEULA${RESET}`);
const answer = (await rl.question('  Do you accept the Minecraft EULA for these test servers? [y/N] ')).trim();
rl.close();
console.log('');

if (answer.toLowerCase() !== 'y') {
  console.log(`  ${YELLOW}Not accepted -- nothing was created.${RESET}`);
  console.log('');
  process.exit(1);
}

await fs.mkdir(WORK_DIR, { recursive: true });

let results: Result[] = [];
try {
  const vanillaJar = await ensureVanillaJar();
  console.log('');

  try {
    await fs.access(PAPER_JAR);
  } catch {
    console.error(`${RED}  Paper jar not found. Run npm run minecraft:setup first.${RESET}`);
    process.exit(1);
  }

  results = [
    await run({
      name: 'Vanilla 26.1.2',
      jar: vanillaJar,
      port: 25577,
      dir: path.join(WORK_DIR, 'vanilla'),
    }),
    await run({
      name: 'Paper 26.1.2-74',
      jar: PAPER_JAR,
      port: 25578,
      dir: path.join(WORK_DIR, 'paper'),
    }),
  ];
} finally {
  // Temporary worlds; keep the verified jar so a re-run skips the download.
  for (const sub of ['vanilla', 'paper']) {
    await fs.rm(path.join(WORK_DIR, sub), { recursive: true, force: true });
  }
}

console.log(`${BOLD}  Results${RESET}  ${DIM}(walking forward for ${WALK_SECONDS}s on flat ground)${RESET}`);
console.log('');
console.log(
  `  ${'server'.padEnd(18)} ${'moved'.padEnd(10)} ${'corrections'.padEnd(13)} ${'idle corr.'.padEnd(11)} physics`,
);
console.log(`  ${'-'.repeat(66)}`);

for (const r of results) {
  if (r.error !== undefined) {
    console.log(`  ${r.target.padEnd(18)} ${RED}failed: ${r.error}${RESET}`);
    continue;
  }
  const moved = `${r.movedBlocks.toFixed(2)}m`;
  const walks = r.movedBlocks > 3;
  console.log(
    `  ${r.target.padEnd(18)} ${(walks ? GREEN : RED) + moved.padEnd(10) + RESET} ` +
      `${String(r.correctionsWalking).padEnd(13)} ${String(r.correctionsIdle).padEnd(11)} ${r.physicsTicks}`,
  );
}
console.log('');

const vanillaOk = results[0] !== undefined && results[0].error === undefined && results[0].movedBlocks > 3;
const paperOk = results[1] !== undefined && results[1].error === undefined && results[1].movedBlocks > 3;

if (vanillaOk && !paperOk) {
  console.log(`  ${YELLOW}${BOLD}Paper is responsible.${RESET} Vanilla accepts the bot's movement and Paper`);
  console.log(`  does not. Next: look for a Paper movement/anti-cheat setting, or run the`);
  console.log(`  simulation on vanilla. Update ADR-006.`);
} else if (!vanillaOk && !paperOk) {
  console.log(`  ${YELLOW}${BOLD}Not Paper.${RESET} Both servers reject the bot's movement, so this is`);
  console.log(`  mineflayer vs Minecraft ${MC_VERSION} itself. Next: test an older Minecraft`);
  console.log(`  version, and report upstream to PrismarineJS. Update ADR-006.`);
} else if (vanillaOk && paperOk) {
  console.log(`  ${GREEN}${BOLD}Both servers work on flat ground.${RESET} Movement is not broken in general,`);
  console.log(`  so the original failure is specific to the civ-sim-world spawn area.`);
  console.log(`  Next: re-test there and compare. Update ADR-006.`);
} else {
  console.log(`  ${YELLOW}Unexpected: Paper works and vanilla does not. Re-run before concluding.${RESET}`);
}
console.log('');
