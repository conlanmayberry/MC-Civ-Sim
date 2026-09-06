#!/usr/bin/env node
/**
 * Stage 1 setup: prepare minecraft/server/ so `npm run minecraft` can start.
 *
 *   1. verify the installed JDK meets Paper's minimum
 *   2. download the pinned Paper jar and verify its SHA-256
 *   3. install server.properties from the tracked template
 *   4. obtain the operator's explicit EULA acceptance
 *
 * `--check-latest` skips all of that and just reports whether PaperMC has
 * published a newer build than the pin. Upgrading is always a deliberate edit
 * to minecraft/config/paper-version.json, never something this script does.
 *
 * No dependencies: Node's built-in fetch, crypto and readline only.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(ROOT, 'minecraft', 'config');
const SERVER_DIR = path.join(ROOT, 'minecraft', 'server');
const PIN_FILE = path.join(CONFIG_DIR, 'paper-version.json');
const PROPS_TEMPLATE = path.join(CONFIG_DIR, 'server.properties.template');

const FILL_API = 'https://fill.papermc.io/v3/projects/paper';
const EULA_URL = 'https://aka.ms/MinecraftEULA';

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const ok = (msg) => console.log(`${c.green('  OK')}  ${msg}`);
const info = (msg) => console.log(`${c.dim('  ..')}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow('  !!')}  ${msg}`);

/** Abort with an actionable message rather than a stack trace. */
function fail(headline, ...remedy) {
  console.error(`\n${c.red('FAILED')}  ${headline}`);
  for (const line of remedy) console.error(`        ${line}`);
  console.error('');
  process.exit(1);
}

async function readPin() {
  try {
    return JSON.parse(await fs.readFile(PIN_FILE, 'utf8'));
  } catch (err) {
    fail(
      `Could not read the version pin at minecraft/config/paper-version.json`,
      err.message,
    );
  }
}

// --- 1. Java ---------------------------------------------------------------

/**
 * `java -version` writes to stderr, and the first line looks like:
 *   openjdk version "25.0.4" 2026-07-15
 * Old JDKs used a 1.x.y scheme; we only care about modern ones, so a leading
 * integer is enough.
 */
function checkJava(minimum) {
  const res = spawnSync('java', ['-version'], { encoding: 'utf8' });

  if (res.error) {
    fail(
      'No Java runtime found on PATH.',
      `Java ${minimum}+ is required. Install it with:`,
      '',
      '    winget install --id EclipseAdoptium.Temurin.25.JDK -e',
      '',
      'Then open a NEW terminal so the updated PATH is picked up.',
    );
  }

  const output = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  const match = output.match(/version "(\d+)(?:\.(\d+))?/);

  if (!match) {
    fail(
      'Found a `java` executable but could not parse its version.',
      'Raw output:',
      ...output.trim().split('\n').map((l) => `  ${l}`),
    );
  }

  const major = Number(match[1]);
  if (major < minimum) {
    fail(
      `Java ${major} is installed, but Paper requires Java ${minimum} or newer.`,
      'Install a newer JDK with:',
      '',
      '    winget install --id EclipseAdoptium.Temurin.25.JDK -e',
      '',
      'If multiple JDKs are installed, make sure the newer one comes first on PATH.',
    );
  }

  ok(`Java ${major} detected (Paper requires ${minimum}+)`);
}

// --- 2. Paper jar ----------------------------------------------------------

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * PaperMC's fill CDN is content-addressed: the object path IS the SHA-256 of
 * the jar. We still hash the downloaded bytes ourselves and compare against the
 * pin, because this is an unattended binary download and the pin is the thing a
 * human actually reviewed.
 */
async function ensurePaperJar(pin) {
  const dest = path.join(SERVER_DIR, pin.jarName);

  if (await exists(dest)) {
    const digest = await sha256(dest);
    if (digest === pin.sha256) {
      ok(`${pin.jarName} already present, checksum matches`);
      return dest;
    }
    warn(`${pin.jarName} exists but its checksum does not match the pin -- re-downloading`);
    await fs.rm(dest);
  }

  const url = `https://fill-data.papermc.io/v1/objects/${pin.sha256}/${pin.jarName}`;
  info(`downloading ${pin.jarName} ...`);

  const res = await fetch(url);
  if (!res.ok) {
    fail(
      `Download failed: HTTP ${res.status} ${res.statusText}`,
      `URL: ${url}`,
      'Check your network connection, then re-run `npm run minecraft:setup`.',
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');

  if (digest !== pin.sha256) {
    fail(
      'SHA-256 mismatch -- the downloaded file was NOT written to disk.',
      `expected: ${pin.sha256}`,
      `actual:   ${digest}`,
      '',
      'Do not work around this. Either the pin is wrong or the download was',
      'corrupted/tampered with. Re-run once; if it persists, verify the pin',
      'against https://fill.papermc.io/v3/projects/paper before proceeding.',
    );
  }

  await fs.writeFile(dest, bytes);
  ok(`${pin.jarName} downloaded and verified (${(bytes.length / 1e6).toFixed(1)} MB)`);
  return dest;
}

// --- 3. server.properties --------------------------------------------------

/**
 * Paper rewrites server.properties at runtime (normalising order, appending
 * defaults), so an existing file is the live config and we must not clobber the
 * operator's runtime tweaks without saying so.
 */
async function installProperties() {
  const dest = path.join(SERVER_DIR, 'server.properties');
  const template = await fs.readFile(PROPS_TEMPLATE, 'utf8');

  if (await exists(dest)) {
    warn('server.properties already exists -- leaving it untouched');
    info('delete minecraft/server/server.properties and re-run to reset it from the template');
    return;
  }

  await fs.writeFile(dest, template);
  ok('server.properties written from template (loopback bind, offline mode)');
}

// --- 4. EULA ---------------------------------------------------------------

/**
 * Never auto-accepted. Minecraft's EULA is an agreement between Mojang and the
 * human operating this machine; the flag gets set by their keystroke or not at
 * all. Non-interactive runs stop here on purpose.
 */
async function acceptEula() {
  const dest = path.join(SERVER_DIR, 'eula.txt');

  if (await exists(dest)) {
    const current = await fs.readFile(dest, 'utf8');
    if (/^\s*eula\s*=\s*true/im.test(current)) {
      ok('EULA already accepted');
      return true;
    }
  }

  console.log('');
  console.log(c.bold('  Minecraft End User Licence Agreement'));
  console.log(`  Running a Minecraft server requires you to agree to Mojang's EULA:`);
  console.log(`  ${c.bold(EULA_URL)}`);
  console.log('');

  if (!process.stdin.isTTY) {
    warn('Not an interactive terminal -- cannot ask for EULA acceptance.');
    info('Re-run `npm run minecraft:setup` from a normal terminal.');
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('  Do you accept the Minecraft EULA? (y/N) ')).trim().toLowerCase();
  rl.close();

  if (answer !== 'y' && answer !== 'yes') {
    console.log('');
    warn('EULA not accepted. The server will refuse to start.');
    info('Nothing else was changed. Re-run setup when you are ready to accept.');
    return false;
  }

  await fs.writeFile(
    dest,
    [
      '# Accepted interactively via `npm run minecraft:setup`.',
      `# ${EULA_URL}`,
      `# ${new Date().toISOString()}`,
      'eula=true',
      '',
    ].join('\n'),
  );
  ok('EULA accepted');
  return true;
}

// --- --check-latest --------------------------------------------------------

async function checkLatest(pin) {
  console.log(c.bold(`\n  Pinned: Minecraft ${pin.minecraftVersion}, Paper build ${pin.paperBuild}\n`));

  const versionsRes = await fetch(FILL_API);
  if (!versionsRes.ok) fail(`PaperMC API returned HTTP ${versionsRes.status}`);
  const { versions } = await versionsRes.json();

  const known = Object.values(versions).flat();
  if (!known.includes(pin.minecraftVersion)) {
    warn(`PaperMC no longer lists ${pin.minecraftVersion}.`);
  }

  const metaRes = await fetch(`${FILL_API}/versions/${pin.minecraftVersion}`);
  if (metaRes.ok) {
    const { version } = await metaRes.json();
    const status = version.support?.status ?? 'UNKNOWN';
    const line = `support status: ${status}${version.support?.end ? ` (ended ${version.support.end})` : ''}`;
    status === 'SUPPORTED' ? ok(line) : warn(line);
    info(`java minimum: ${version.java?.version?.minimum}`);
  }

  const buildRes = await fetch(`${FILL_API}/versions/${pin.minecraftVersion}/builds/latest`);
  if (!buildRes.ok) fail(`Could not read latest build: HTTP ${buildRes.status}`);
  const build = await buildRes.json();

  if (build.id > pin.paperBuild) {
    warn(`A newer Paper build exists: #${build.id} (${build.channel}, ${build.time})`);
    info('To upgrade, edit minecraft/config/paper-version.json with the new');
    info('build number, jar name and sha256, then re-run `npm run minecraft:setup`.');
    info(`  sha256: ${build.downloads?.['server:default']?.checksums?.sha256}`);
    info(`  jar:    ${build.downloads?.['server:default']?.name}`);
  } else {
    ok(`Pin is current -- #${pin.paperBuild} is the latest build`);
  }

  // Flag newer Minecraft versions, but do not imply they are usable: Mineflayer
  // and minecraft-data gate that decision, not Paper.
  const newer = known
    .filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v) && v > pin.minecraftVersion)
    .slice(0, 5);
  if (newer.length) {
    console.log('');
    info(`Paper also supports newer Minecraft versions: ${newer.join(', ')}`);
    info('Before targeting one, confirm Mineflayer supports it -- check');
    info('PrismarineJS/mineflayer lib/version.js AND minecraft-data dataPaths.json.');
    info('See docs/decisions.md ADR-001.');
  }
  console.log('');
}

// --- main ------------------------------------------------------------------

const pin = await readPin();

if (process.argv.includes('--check-latest')) {
  await checkLatest(pin);
  process.exit(0);
}

console.log(c.bold(`\n  MC-Civ-Sim setup -- Minecraft ${pin.minecraftVersion} / Paper build ${pin.paperBuild}\n`));

await fs.mkdir(SERVER_DIR, { recursive: true });
checkJava(pin.javaMinimum);
await ensurePaperJar(pin);
await installProperties();
const eulaAccepted = await acceptEula();

console.log('');
if (eulaAccepted) {
  console.log(c.green(c.bold('  Setup complete.')));
  console.log(`  Start the server with:  ${c.bold('npm run minecraft')}`);
  console.log(`  Then join from the Minecraft Java client at ${c.bold('127.0.0.1:25565')}`);
} else {
  console.log(c.yellow(c.bold('  Setup incomplete -- EULA not accepted.')));
}
console.log('');
