#!/usr/bin/env node
/**
 * Run the scenario tests against the local server.
 *
 *     npm run scenarios                         every free action scenario
 *     npm run scenarios -- --only move_around_wall,handover_walks
 *     npm run scenarios -- --live               also the live agent scenarios (a few cents)
 *     npm run scenarios -- --list               what exists, and nothing else
 *     npm run scenarios -- --cleanup            remove the arena from the world
 *
 * Needs the server running with RCON enabled: `npm run minecraft:enable-rcon`
 * once, then restart the server. Safe to run while agents are playing -- the
 * arena is 25,000 blocks away and scenario agents talk only to each other.
 *
 * Every result is kept, so a scenario that passed last time and fails now is
 * reported as a regression rather than just as a failure.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT, loadEnvFile } from '../config.ts';
import { createOpenAiProvider } from '../ai/openai.ts';
import { MODEL } from '../ai/pricing.ts';
import type { AiProvider } from '../ai/provider.ts';
import { DEFAULT_DB_PATH } from '../telemetry/index.ts';
import { readGitState } from '../telemetry/manifest.ts';
import { openStore } from '../telemetry/store.ts';
import { createArena } from './arena.ts';
import { connectRcon, readRconSettings } from './rcon.ts';
import type { Outcome, Verdict } from './scenarios.ts';
import { SCENARIOS, describeChange } from './scenarios.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const has = (name: string): boolean => process.argv.includes(`--${name}`);
function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function fail(message: string, ...hints: string[]): never {
  console.error(`\n  ${RED}${message}${RESET}`);
  for (const hint of hints) console.error(`  ${DIM}${hint}${RESET}`);
  console.error('');
  process.exit(1);
}

const live = has('live');
const only = flag('only')?.split(',').map((s) => s.trim()).filter((s) => s !== '') ?? null;

if (has('list')) {
  console.log('');
  for (const s of SCENARIOS) {
    console.log(`  ${s.id.padEnd(28)} ${s.live ? `${YELLOW}live${RESET}  ` : `${DIM}free${RESET}  `}${s.title}`);
  }
  console.log('');
  process.exit(0);
}

if (only !== null) {
  const unknown = only.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0) fail(`no such scenario: ${unknown.join(', ')}`, 'npm run scenarios -- --list');
}

// --- connect -------------------------------------------------------------------

const settings = readRconSettings(path.join(ROOT, 'minecraft', 'server', 'server.properties'));
if (!settings.enabled || settings.password === '') {
  fail(
    'RCON is not enabled on the server',
    'scenarios drive the arena through RCON. Enable it once, then restart the server:',
    '    npm run minecraft:enable-rcon',
  );
}

let rcon;
try {
  rcon = await connectRcon(settings);
} catch (err) {
  fail(
    `could not connect to RCON: ${err instanceof Error ? err.message : String(err)}`,
    'is the server running? (start-server.bat)',
    'if RCON was only just enabled, the server needs a restart to pick it up',
  );
}

const arena = await createArena(rcon);

if (has('cleanup')) {
  await arena.cleanup();
  rcon.close();
  console.log(`\n  ${GREEN}arena removed${RESET}\n`);
  process.exit(0);
}

// --- provider, for live scenarios only -------------------------------------------

let provider: AiProvider | null = null;
if (live) {
  const env = { ...loadEnvFile(), ...process.env };
  const apiKey = env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    fail('--live needs OPENAI_API_KEY in .env');
  }
  provider = createOpenAiProvider({ apiKey, model: MODEL });
}

// --- run -----------------------------------------------------------------------

const git = readGitState(ROOT);
const store = openStore(process.env['TELEMETRY_DB'] ?? DEFAULT_DB_PATH);
const batchId = new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');

const selected = SCENARIOS.filter((s) => (only === null ? true : only.includes(s.id)));

function previousVerdict(id: string): Verdict | null {
  try {
    const row = store
      .raw()
      .prepare(`SELECT verdict FROM scenario_results WHERE scenario_id = ? AND verdict != 'skip' ORDER BY id DESC LIMIT 1`)
      .get(id) as { verdict?: string } | undefined;
    return (row?.verdict as Verdict | undefined) ?? null;
  } catch {
    return null;
  }
}

console.log('');
console.log(
  `${BOLD}  Scenarios${RESET} ${DIM}${selected.length} selected, ${live ? 'live included' : 'free only -- add --live for agent scenarios'}${RESET}`,
);
console.log(`  ${DIM}code ${git.commit?.slice(0, 7) ?? 'unknown'}${git.dirty === true ? ' + uncommitted changes' : ''}${RESET}`);
console.log('');

interface Row {
  id: string;
  verdict: Verdict;
  detail: string;
  durationMs: number;
  change: string | null;
}
const results: Row[] = [];

for (const scenario of selected) {
  if (scenario.live && !live) {
    results.push({ id: scenario.id, verdict: 'skip', detail: 'live scenario -- run with --live', durationMs: 0, change: null });
    continue;
  }

  process.stdout.write(`  ${DIM}running${RESET} ${scenario.id} ...`);
  const started = Date.now();
  let outcome: Outcome;

  try {
    await arena.reset();
    outcome = await Promise.race([
      scenario.run({ arena, provider }),
      new Promise<Outcome>((resolve) =>
        setTimeout(
          () => resolve({ verdict: 'fail', detail: `timed out after ${scenario.timeoutMs / 1000}s` }),
          scenario.timeoutMs,
        ).unref(),
      ),
    ]);
  } catch (err) {
    outcome = { verdict: 'fail', detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // A failed scenario can leave a bot mid-action holding its own action lock.
  // Fresh bots for the next one, so one failure cannot cause another.
  if (outcome.verdict === 'fail') await arena.releaseBots();

  const durationMs = Date.now() - started;
  const change = outcome.verdict === 'skip' ? null : describeChange(previousVerdict(scenario.id), outcome.verdict);
  results.push({ id: scenario.id, ...outcome, durationMs, change });

  if (outcome.verdict !== 'skip') {
    store.saveScenarioResult({
      batchId,
      runAt: new Date().toISOString(),
      scenarioId: scenario.id,
      verdict: outcome.verdict,
      detail: outcome.detail,
      durationMs,
      gitCommit: git.commit,
      gitDirty: git.dirty,
    });
  }

  const badge =
    outcome.verdict === 'pass' ? `${GREEN}PASS${RESET}` : outcome.verdict === 'skip' ? `${YELLOW}SKIP${RESET}` : `${RED}FAIL${RESET}`;
  const flagged = change === 'REGRESSED' ? ` ${RED}${BOLD}REGRESSED${RESET}` : change === 'fixed' ? ` ${GREEN}fixed${RESET}` : '';
  process.stdout.write(`\r  ${badge}  ${scenario.id.padEnd(28)} ${DIM}${(durationMs / 1000).toFixed(1)}s${RESET}${flagged}\n`);
  console.log(`        ${DIM}${outcome.detail}${RESET}`);
}

await arena.releaseBots();
rcon.close();
store.close();

// --- summary --------------------------------------------------------------------

const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
const regressed = results.filter((r) => r.change === 'REGRESSED');

console.log('');
console.log(
  `  ${GREEN}${count('pass')} passed${RESET}, ${count('fail') > 0 ? RED : DIM}${count('fail')} failed${RESET}, ${DIM}${count('skip')} skipped${RESET}` +
    (regressed.length > 0 ? `  ${RED}${BOLD}${regressed.length} regressed: ${regressed.map((r) => r.id).join(', ')}${RESET}` : ''),
);

const outDir = path.join(ROOT, 'data', 'scenarios');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, `${batchId}.json`),
  JSON.stringify({ batchId, git, live, results }, null, 2),
);
console.log(`  ${DIM}results: data/scenarios/${batchId}.json${RESET}`);
console.log('');

process.exit(count('fail') > 0 ? 1 : 0);
