#!/usr/bin/env node
/**
 * Talk to a running agent from a terminal.
 *
 *     npm run talk                      interactive
 *     npm run talk -- "hello there"     one message and exit
 *     npm run talk -- --tell "go mine"  operator instruction, not conversation
 *
 * The point is not having to launch Minecraft and stand next to an agent to
 * say anything to it.
 *
 * SAY vs TELL matters, and the distinction is kept visible on purpose:
 *
 *   say  -- the agent hears it as speech, from a person, and may reply or
 *           ignore it. This is conversation.
 *   tell -- an operator instruction, weighted as a directive and recorded in
 *           telemetry as an intervention.
 *
 * A run where the operator issued orders is a different experiment from one
 * where they chatted, so the log has to be able to tell them apart.
 */

import { createInterface } from 'node:readline/promises';

import { loadEnvFile } from '../config.ts';
import { DEFAULT_CONTROL_PORT } from '../agent/control.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const env = { ...loadEnvFile(), ...process.env };
const port = Number(env['AGENT_CONTROL_PORT'] ?? '') > 0
  ? Number(env['AGENT_CONTROL_PORT'])
  : DEFAULT_CONTROL_PORT;
const base = `http://127.0.0.1:${port}`;

const args = process.argv.slice(2);
const tellMode = args.includes('--tell');
const message = args.filter((a) => !a.startsWith('--')).join(' ').trim();

interface AgentState {
  username?: string;
  agentId?: string;
  traits?: string[];
  cycles?: number;
  spentUsd?: number;
  budgetUsd?: number;
  model?: string;
  pendingInjections?: number;
}

async function getState(): Promise<AgentState | null> {
  try {
    const res = await fetch(`${base}/state`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    return (await res.json()) as AgentState;
  } catch {
    return null;
  }
}

async function send(kind: 'say' | 'tell', text: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, from: 'operator' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({}));
      console.error(
        `  ${RED}rejected:${RESET} ${
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : res.status
        }`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`  ${RED}could not reach the agent:${RESET} ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function noAgent(): never {
  console.error('');
  console.error(`  ${RED}No agent is listening on ${base}.${RESET}`);
  console.error(`  ${DIM}Start one with:  npm run agent${RESET}`);
  console.error(`  ${DIM}(or set AGENT_CONTROL_PORT if it is on another port)${RESET}`);
  console.error('');
  process.exit(1);
}

const state = await getState();
if (state === null) noAgent();

const who = state.username ?? 'the agent';

// One-shot mode.
if (message !== '') {
  const ok = await send(tellMode ? 'tell' : 'say', message);
  if (ok) {
    console.log(`  ${DIM}${tellMode ? 'instruction sent to' : 'said to'} ${who}${RESET}`);
  }
  process.exit(ok ? 0 : 1);
}

// Interactive mode.
console.log('');
console.log(`${BOLD}  Talking to ${who}${RESET} ${DIM}(${state.agentId ?? '?'})${RESET}`);
if (state.traits !== undefined && state.traits.length > 0) {
  console.log(`  ${DIM}${state.traits.join(', ')}${RESET}`);
}
console.log(
  `  ${DIM}${state.cycles ?? 0} decisions so far, $${(state.spentUsd ?? 0).toFixed(4)} of $${(state.budgetUsd ?? 0).toFixed(2)}${RESET}`,
);
console.log('');
console.log(`  ${DIM}Type to speak. Prefix with ${RESET}/tell${DIM} for an operator instruction.${RESET}`);
console.log(`  ${DIM}/state shows status, /stop halts the agent, /quit leaves this prompt.${RESET}`);
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });

for (;;) {
  const line = (await rl.question(`${CYAN}you>${RESET} `)).trim();
  if (line === '') continue;

  if (line === '/quit' || line === '/exit') break;

  if (line === '/state') {
    const current = await getState();
    if (current === null) {
      console.log(`  ${YELLOW}the agent is no longer responding${RESET}`);
      break;
    }
    console.log(
      `  ${DIM}${current.cycles ?? 0} decisions, $${(current.spentUsd ?? 0).toFixed(4)} spent, ` +
        `${current.pendingInjections ?? 0} pending instruction(s), model ${current.model ?? '?'}${RESET}`,
    );
    continue;
  }

  if (line === '/stop') {
    const confirm = (await rl.question(`  ${YELLOW}Stop the agent? [y/N]${RESET} `)).trim();
    if (confirm.toLowerCase() === 'y') {
      await fetch(`${base}/stop`, { method: 'POST' }).catch(() => {});
      console.log(`  ${DIM}stop requested${RESET}`);
      break;
    }
    continue;
  }

  if (line.startsWith('/tell ')) {
    const ok = await send('tell', line.slice('/tell '.length));
    if (ok) console.log(`  ${DIM}instruction queued -- it lands on the next decision${RESET}`);
    continue;
  }

  const ok = await send('say', line);
  if (ok) console.log(`  ${DIM}heard by ${who}${RESET}`);
}

rl.close();
console.log('');
