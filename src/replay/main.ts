#!/usr/bin/env node
/**
 * Replay recorded decisions under a different prompt or model.
 *
 *     npm run replay -- --dry-run                  what it would cost, nothing spent
 *     npm run replay                               latest session, current prompt, same models
 *     npm run replay -- --model gpt-5.6-terra      would a stronger model have chosen differently?
 *     npm run replay -- --agent bob --limit 80
 *     npm run replay -- --filter "STANDING ORDER"  only situations under an operator order
 *     npm run replay -- --trigger "addressed you"  only turns where someone spoke to them
 *     npm run replay -- --prompt recorded          the prompt the run actually used
 *     npm run replay -- --stub                     check the pipeline for $0 (results meaningless)
 *
 * The default prompt is the CURRENT code's, on purpose: the usual question is
 * "I changed the prompt -- would that have helped last session?". To isolate a
 * model change instead, pass `--prompt recorded` so only the model differs.
 *
 * Spends real money unless --dry-run or --stub. There is a hard cap (--max-usd,
 * default $1.00) and an estimate is printed before anything is sent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ROOT, loadEnvFile } from '../config.ts';
import { loadIdentityById } from '../agent/identity.ts';
import { createOpenAiProvider } from '../ai/openai.ts';
import { MODEL, PRICES, formatUsd } from '../ai/pricing.ts';
import { buildSystemPrompt } from '../ai/prompt.ts';
import type { AiProvider } from '../ai/provider.ts';
import { createStubProvider } from '../ai/provider.ts';
import { TOOL_SCHEMAS } from '../ai/tools.ts';
import { DEFAULT_DB_PATH } from '../telemetry/index.ts';
import { resolveRuns } from '../telemetry/sessions.ts';
import { formatCalls, toolShift } from './compare.ts';
import type { ReplayResult } from './replay.ts';
import { estimateCost, loadRecorded, runReplay, sampleEvenly } from './replay.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function fail(message: string, hint?: string): never {
  console.error(`\n  ${RED}${message}${RESET}`);
  if (hint !== undefined) console.error(`  ${DIM}${hint}${RESET}`);
  console.error('');
  process.exit(1);
}

function regex(value: string | null): RegExp | undefined {
  if (value === null) return undefined;
  try {
    return new RegExp(value, 'i');
  } catch {
    fail(`not a valid pattern: ${value}`);
  }
}

const env = { ...loadEnvFile(), ...process.env };
const dbPath = env['TELEMETRY_DB'] ?? DEFAULT_DB_PATH;
if (!fs.existsSync(dbPath)) fail(`no telemetry database at ${dbPath}`, 'run the agents first');

const db = new DatabaseSync(dbPath, { readOnly: true });

const sessionSpec = flag('session') ?? 'latest';
const agent = flag('agent') ?? undefined;
const limit = Math.max(1, Number(flag('limit') ?? '40') || 40);
const maxUsd = Math.max(0, Number(flag('max-usd') ?? '1') || 1);
const concurrency = Math.max(1, Math.min(8, Number(flag('concurrency') ?? '4') || 4));
const promptMode = flag('prompt') ?? 'current';
const showExamples = Math.max(0, Number(flag('show') ?? '6') || 0);
const dryRun = has('dry-run');
const useStub = has('stub');

if (promptMode !== 'current' && promptMode !== 'recorded') {
  fail(`--prompt must be "current" or "recorded", not "${promptMode}"`);
}

const runs = resolveRuns(db, sessionSpec);
if (runs.length === 0) fail(`no runs match "${sessionSpec}"`);

let recorded;
try {
  recorded = loadRecorded(db, runs, {
    agent,
    filter: regex(flag('filter')),
    trigger: regex(flag('trigger')),
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/no such table/.test(message)) {
    fail(
      'this database has no recorded decision inputs yet',
      'they are recorded from the first agent run on this version onward -- run a session, then replay it',
    );
  }
  throw err;
}

if (recorded.length === 0) {
  fail(
    `no recorded situations in session "${sessionSpec}"${agent === undefined ? '' : ` for ${agent}`}`,
    'runs from before decision inputs were recorded cannot be replayed -- start a new session first',
  );
}

const cases = sampleEvenly(recorded, limit);

/**
 * The model to replay under: an explicit --model, else whatever each run used.
 * A mixed session (Bob on Terra, the rest on Luna) replays each agent on its
 * own model unless told otherwise, so the default isolates the prompt.
 */
const modelOverride = flag('model');
if (modelOverride !== null && !useStub && PRICES[modelOverride] === undefined) {
  fail(`unknown model "${modelOverride}"`, `priced models: ${Object.keys(PRICES).join(', ')}`);
}
const modelFor = (originalModel: string): string =>
  modelOverride ?? (PRICES[originalModel] === undefined ? MODEL : originalModel);

// --- prompt ------------------------------------------------------------------

const recordedPrompts = new Map<string, string>();
function systemFor(agentId: string, runId: string): string {
  if (promptMode === 'current') return buildSystemPrompt(loadIdentityById(agentId));

  const key = `${runId}/${agentId}`;
  const cached = recordedPrompts.get(key);
  if (cached !== undefined) return cached;

  const row = db
    .prepare(`SELECT system_prompt FROM run_manifests WHERE run_id = ? AND agent_id = ?`)
    .get(runId, agentId) as { system_prompt?: string } | undefined;
  if (row?.system_prompt === undefined) {
    fail(`run ${runId} has no recorded prompt`, 'use --prompt current for runs from before manifests');
  }
  recordedPrompts.set(key, row.system_prompt);
  return row.system_prompt;
}

// --- estimate ----------------------------------------------------------------

console.log('');
console.log(`${BOLD}  Replay${RESET} ${DIM}${runs.map((r) => r.runId).join(', ')}${RESET}`);
console.log(
  `  ${cases.length} situation(s) sampled from ${recorded.length} recorded` +
    `${agent === undefined ? '' : `, agent ${agent}`}, prompt: ${promptMode}`,
);

const byModel = new Map<string, typeof cases>();
for (const c of cases) {
  const model = modelFor(c.original.model);
  byModel.set(model, [...(byModel.get(model) ?? []), c]);
}

let estimate = 0;
if (!useStub) {
  for (const [model, group] of byModel) {
    const cost = estimateCost(group, model);
    estimate += cost;
    console.log(`  ${DIM}${group.length} on ${model}: ~${formatUsd(cost)}${RESET}`);
  }
  console.log(`  estimate ${BOLD}~${formatUsd(estimate)}${RESET}, cap ${formatUsd(maxUsd)}`);
}

if (dryRun) {
  console.log(`\n  ${DIM}dry run -- nothing sent. Drop --dry-run to replay.${RESET}\n`);
  process.exit(0);
}

if (!useStub && estimate > maxUsd) {
  fail(
    `estimated ${formatUsd(estimate)} is over the ${formatUsd(maxUsd)} cap`,
    'lower --limit, or raise --max-usd if you mean it',
  );
}

const apiKey = env['OPENAI_API_KEY'];
if (!useStub && (apiKey === undefined || apiKey === '')) {
  fail('OPENAI_API_KEY is not set', 'put it in .env, or use --stub to check the pipeline for free');
}

// --- run ---------------------------------------------------------------------

const providers = new Map<string, AiProvider>();
const results: ReplayResult[] = [];
let spent = 0;
let budgetStop = false;

for (const [model, group] of byModel) {
  const provider = useStub
    ? createStubProvider()
    : (providers.get(model) ??
      createOpenAiProvider({ apiKey: String(apiKey), model }));
  providers.set(model, provider);

  const outcome = await runReplay(group, {
    provider,
    systemFor,
    tools: TOOL_SCHEMAS,
    maxUsd: Math.max(0, maxUsd - spent),
    concurrency,
    onProgress: (done, total, spentUsd) => {
      process.stdout.write(
        `\r  ${DIM}${model}: ${done}/${total} replayed, ${formatUsd(spent + spentUsd)} spent${RESET}   `,
      );
    },
  });
  process.stdout.write('\n');

  results.push(...outcome.results);
  spent += outcome.spentUsd;
  budgetStop ||= outcome.stoppedForBudget;
}

// --- report ------------------------------------------------------------------

const compared = results.filter((r) => r.comparison !== null);
const errors = results.filter((r) => r.error !== null);
const count = (grade: string): number =>
  compared.filter((r) => r.comparison?.agreement === grade).length;
const pct = (n: number): string =>
  compared.length === 0 ? '0%' : `${Math.round((100 * n) / compared.length)}%`;

console.log('');
console.log(`${BOLD}  Agreement with what the agents originally did${RESET}`);
console.log(`  ${GREEN}identical${RESET}        ${count('identical')}  ${DIM}${pct(count('identical'))}${RESET}`);
console.log(
  `  ${YELLOW}same tools${RESET}       ${count('same_tools')}  ${DIM}${pct(count('same_tools'))}  -- different arguments, usually noise${RESET}`,
);
console.log(
  `  ${RED}different choice${RESET} ${count('different')}  ${DIM}${pct(count('different'))}  -- this is what a change is being tested for${RESET}`,
);
if (errors.length > 0) {
  console.log(`  ${RED}errors${RESET}           ${errors.length}  ${DIM}${errors[0]?.error ?? ''}${RESET}`);
}
if (budgetStop) {
  console.log(`  ${YELLOW}stopped early at the ${formatUsd(maxUsd)} cap${RESET}`);
}

const shift = toolShift(
  compared.map((r) => ({ original: r.decision.original.calls, replayed: r.replayed?.calls ?? [] })),
);
if (shift.length > 0) {
  console.log('');
  console.log(`${BOLD}  How often each tool was chosen${RESET} ${DIM}original -> replay${RESET}`);
  for (const s of shift) {
    const delta = s.replayed - s.original;
    const colour = delta === 0 ? DIM : delta > 0 ? GREEN : RED;
    console.log(
      `  ${s.tool.padEnd(16)} ${String(s.original).padStart(4)} -> ${String(s.replayed).padStart(4)}  ` +
        `${colour}${delta > 0 ? '+' : ''}${delta}${RESET}`,
    );
  }
}

const divergent = compared.filter((r) => r.comparison?.agreement === 'different').slice(0, showExamples);
if (divergent.length > 0) {
  console.log('');
  console.log(`${BOLD}  Where the choice changed${RESET}`);
  for (const r of divergent) {
    // The last lines of an observation are what the agent was reacting to --
    // chat, pressures, setbacks -- and the goal line is the first.
    const lines = r.decision.observation.split('\n');
    const context = [...new Set([lines[1] ?? '', ...lines.slice(-4)])].filter(
      (l) => l.trim() !== '' && !l.startsWith('--- turn'),
    );
    console.log('');
    console.log(`  ${DIM}${r.decision.agentId} turn ${r.decision.cycle} -- woken by: ${r.decision.trigger}${RESET}`);
    for (const line of context) console.log(`  ${DIM}| ${line.slice(0, 110)}${RESET}`);
    console.log(`  original: ${formatCalls(r.decision.original.calls)}`);
    console.log(`  ${DIM}          ${r.decision.original.summary.slice(0, 110)}${RESET}`);
    console.log(`  replay:   ${formatCalls(r.replayed?.calls ?? [])}`);
    console.log(`  ${DIM}          ${(r.replayed?.summary ?? '').slice(0, 110)}${RESET}`);
  }
}

// Everything, for reading properly later -- the console report is a summary.
const outDir = path.join(ROOT, 'data', 'replays');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');
const outFile = path.join(outDir, `${stamp}${agent === undefined ? '' : `-${agent}`}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      session: sessionSpec,
      runs: runs.map((r) => r.runId),
      prompt: promptMode,
      modelOverride,
      stub: useStub,
      spentUsd: spent,
      results: results.map((r) => ({
        agent: r.decision.agentId,
        run: r.decision.runId,
        cycle: r.decision.cycle,
        trigger: r.decision.trigger,
        observation: r.decision.observation,
        original: r.decision.original,
        replayed: r.replayed,
        comparison: r.comparison,
        error: r.error,
      })),
    },
    null,
    2,
  ),
);

console.log('');
console.log(`  spent ${BOLD}${formatUsd(spent)}${RESET}  ${DIM}full results: ${path.relative(ROOT, outFile)}${RESET}`);
if (useStub) {
  console.log(`  ${YELLOW}--stub: decisions came from a script, so agreement numbers mean nothing${RESET}`);
}
console.log('');
db.close();
