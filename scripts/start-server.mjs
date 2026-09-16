#!/usr/bin/env node
/**
 * Stage 1: launch the local Paper server.
 *
 * Two things here matter beyond "spawn java":
 *
 *   - stdin is forwarded to the JVM so the operator can type server commands
 *     (`stop`, `save-all`, `list`) exactly as they would with a plain jar.
 *   - Ctrl-C is intercepted and turned into a `stop` command instead of a kill.
 *     A hard kill can lose unsaved chunks, and losing world state mid-experiment
 *     would invalidate a run. This is the first piece of the graceful-shutdown
 *     machinery the later stages depend on.
 *
 * No dependencies.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

// Node 26 runs TypeScript natively, so this .mjs infrastructure script can share
// the application's env reader rather than keeping a second copy in sync.
// See docs/decisions.md ADR-004.
import { loadEnvFile } from '../src/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'minecraft', 'server');
const PIN_FILE = path.join(ROOT, 'minecraft', 'config', 'paper-version.json');

// Paper's own recommended G1GC flags for this version, from
// https://fill.papermc.io/v3/projects/paper/versions/26.1.2 (verified 2026-09-06).
const PAPER_FLAGS = [
  '-XX:+AlwaysPreTouch',
  '-XX:+DisableExplicitGC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:+PerfDisableSharedMem',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1NewSizePercent=30',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:G1ReservePercent=20',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:MaxGCPauseMillis=200',
  '-XX:MaxTenuringThreshold=1',
  '-XX:SurvivorRatio=32',
];

const SHUTDOWN_GRACE_MS = 30_000;

function fail(headline, ...remedy) {
  console.error(`\n\x1b[31mFAILED\x1b[0m  ${headline}`);
  for (const line of remedy) console.error(`        ${line}`);
  console.error('');
  process.exit(1);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const pin = JSON.parse(await fs.readFile(PIN_FILE, 'utf8'));
const env = { ...loadEnvFile(ROOT), ...process.env };

const jar = path.join(SERVER_DIR, pin.jarName);
const eula = path.join(SERVER_DIR, 'eula.txt');

if (!(await exists(jar))) {
  fail(
    `Paper jar not found: minecraft/server/${pin.jarName}`,
    'Run setup first:',
    '',
    '    npm run minecraft:setup',
  );
}

if (!(await exists(eula)) || !/^\s*eula\s*=\s*true/im.test(await fs.readFile(eula, 'utf8'))) {
  fail(
    'The Minecraft EULA has not been accepted.',
    'Run `npm run minecraft:setup` and answer the EULA prompt.',
  );
}

/**
 * Read the Minecraft version a world was last saved by, from level.dat.
 *
 * level.dat is gzipped NBT. Rather than take an NBT dependency for one string,
 * this scans the decompressed bytes for a version-shaped token -- enough for a
 * guard, and it fails open: an unreadable world returns null and the server
 * starts as normal, because a version check must never be the thing that stops
 * you playing.
 */
async function worldVersion(worldDir) {
  try {
    const raw = zlib.gunzipSync(await fs.readFile(path.join(worldDir, 'level.dat'))).toString('latin1');
    const matches = [...raw.matchAll(/(?:1\.\d{1,2}(?:\.\d{1,2})?|\d{2}\.\d{1,2}(?:\.\d{1,2})?)/g)].map((m) => m[0]);
    return matches.length > 0 ? matches[0] : null;
  } catch {
    return null;
  }
}

// Minecraft upgrades worlds silently and never downgrades them. Opening a
// newer world with an older server corrupts it, and the damage is not obvious
// until much later -- exactly the kind of loss that would invalidate an
// experiment. Refuse rather than risk it.
const worldName = env.LEVEL_NAME ?? 'civ-sim-world';
const worldDir = path.join(SERVER_DIR, worldName);

if (await exists(worldDir)) {
  const existing = await worldVersion(worldDir);
  if (existing !== null && existing !== pin.minecraftVersion) {
    fail(
      `World "${worldName}" was created by Minecraft ${existing}, but the server is pinned to ${pin.minecraftVersion}.`,
      '',
      'Minecraft never downgrades a world; opening this one would corrupt it.',
      'Move it aside and let the server generate a fresh world:',
      '',
      `    mv minecraft/server/${worldName} minecraft/server/${worldName}.${existing}-archived`,
      '',
      'Or change minecraftVersion in minecraft/config/paper-version.json back',
      `to ${existing}.`,
    );
  }
}

const xms = env.SERVER_MEMORY_MIN ?? '2G';
const xmx = env.SERVER_MEMORY_MAX ?? '4G';

const args = [`-Xms${xms}`, `-Xmx${xmx}`, ...PAPER_FLAGS, '-jar', pin.jarName, '--nogui'];

console.log('');
console.log(`\x1b[1m  MC-Civ-Sim\x1b[0m  Minecraft ${pin.minecraftVersion} / Paper build ${pin.paperBuild}`);
console.log(`  heap ${xms}-${xmx}  |  listening on 127.0.0.1:${env.MC_PORT ?? '25565'} (loopback only)`);
console.log(`  \x1b[2mtype server commands directly; Ctrl-C performs a graceful save + stop\x1b[0m`);
console.log('');

const server = spawn('java', args, {
  cwd: SERVER_DIR,
  // stdin piped so we can inject `stop`; stdout/stderr inherited so Paper's
  // console output reaches the operator unmodified.
  stdio: ['pipe', 'inherit', 'inherit'],
});

process.stdin.pipe(server.stdin);

let stopping = false;

function gracefulStop(signal) {
  if (stopping) {
    // Second Ctrl-C: the operator is insisting. Honour it.
    console.log('\n  Forcing shutdown.');
    server.kill('SIGKILL');
    return;
  }
  stopping = true;

  console.log(`\n  ${signal} received -- saving and stopping the server ...`);
  console.log('  \x1b[2m(press Ctrl-C again to force-kill, at the risk of losing unsaved chunks)\x1b[0m');

  // Paper's own `stop` flushes the world to disk; that is the whole point of
  // not sending a signal here.
  server.stdin.write('stop\n');

  setTimeout(() => {
    if (!server.killed) {
      console.log('  Graceful stop timed out -- terminating.');
      server.kill('SIGKILL');
    }
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on('SIGINT', () => gracefulStop('SIGINT'));
process.on('SIGTERM', () => gracefulStop('SIGTERM'));

server.on('error', (err) => {
  fail('Could not start the Java process.', err.message);
});

server.on('exit', (code, signal) => {
  // Optional call: only a TTY has unref. Launched from a script -- as the
  // scenario harness does -- stdin is a pipe, and this line crashed the
  // shutdown with a TypeError after the world had already saved.
  process.stdin.unref?.();
  console.log(`\n  Server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).`);
  process.exit(code ?? 0);
});
