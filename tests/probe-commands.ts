#!/usr/bin/env node
/**
 * Chat command probe.
 *
 *     npm run bot:probe-chat     (server AND `npm run bot` must be running)
 *
 * Joins as a second player, says the commands a human would say, and checks
 * what comes back. This is the Stage 2 success criterion executed as a script
 * rather than by hand -- the human check still matters (it confirms the bot is
 * visibly present and moves), but this catches format regressions in seconds
 * and can be re-run after any change.
 *
 * Deliberately a black-box test: it imports nothing from src/bot and asserts
 * only on what arrives over Minecraft chat.
 */

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';

import { loadConfig } from '../src/config.ts';

const SPAWN_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 8_000;
/** Comfortably above the bot's own outgoing-chat throttle. */
const BETWEEN_COMMANDS_MS = 1_200;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const config = loadConfig();
const TARGET = config.username;
const PREFIX = config.chat.commandPrefix;

interface Case {
  name: string;
  send: string;
  expect: RegExp;
}

const cases: Case[] = [
  {
    name: 'status (the Stage 2 success criterion)',
    send: `${PREFIX} status`,
    // The exact shape the project brief specifies.
    expect: /^Position: x=-?\d+ y=-?\d+ z=-?\d+ \| Health: \d+(\.\d+)? \| Food: \d+$/,
  },
  {
    name: 'inventory',
    send: `${PREFIX} inventory`,
    expect: /^(Inventory is empty\.|\d+ items in \d+ slots: .+)$/,
  },
  {
    name: 'inventory alias (inv)',
    send: `${PREFIX} inv`,
    expect: /^(Inventory is empty\.|\d+ items in \d+ slots: .+)$/,
  },
  {
    name: 'look (nearby blocks)',
    send: `${PREFIX} look`,
    expect: /^(Nothing but air within reach\.|Within \d+ blocks: .+)$/,
  },
  {
    name: 'who (nearby entities)',
    send: `${PREFIX} who`,
    expect: /^(Nothing within \d+ blocks\.|Nearby: .+)$/,
  },
  {
    name: 'help',
    send: `${PREFIX} help`,
    expect: /^Commands: .*status.*$/,
  },
  {
    name: 'unknown command is rejected, not ignored',
    send: `${PREFIX} definitelynotacommand`,
    expect: /^Unknown command "definitelynotacommand"\./,
  },
  {
    name: 'bare prefix prompts for help',
    send: PREFIX,
    expect: /^Say "bot help" for the command list\.$/,
  },
];

function finish(code: number, bot: Bot | null): never {
  if (bot !== null) {
    try {
      bot.quit('probe complete');
    } catch {
      // Already gone.
    }
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 250);
  return undefined as never;
}

console.log('');
console.log(`${BOLD}  MC-Civ-Sim chat probe${RESET}  driving "${TARGET}" as a second player`);
console.log(`  ${DIM}connecting to ${config.host}:${config.port}${RESET}`);
console.log('');

const tester = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: 'ProbeTester',
  version: config.version,
  auth: 'offline',
  logErrors: false,
});

/** Resolves with the next chat line spoken by the bot under test. */
function nextReply(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tester.removeListener('chat', onChat);
      reject(new Error(`no reply within ${REPLY_TIMEOUT_MS / 1000}s`));
    }, REPLY_TIMEOUT_MS);

    function onChat(username: string, message: string): void {
      if (username !== TARGET) return;
      clearTimeout(timer);
      tester.removeListener('chat', onChat);
      resolve(message);
    }

    tester.on('chat', onChat);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const spawnTimer = setTimeout(() => {
  console.error(`${RED}  FAILED${RESET}  no spawn within ${SPAWN_TIMEOUT_MS / 1000}s.`);
  finish(1, tester);
}, SPAWN_TIMEOUT_MS);
spawnTimer.unref();

tester.on('error', (err) => {
  clearTimeout(spawnTimer);
  console.error(`${RED}  FAILED${RESET}  connection error: ${err.message}`);
  finish(1, null);
});

tester.once('spawn', async () => {
  clearTimeout(spawnTimer);

  if (tester.players[TARGET] === undefined) {
    console.error(`${RED}  FAILED${RESET}  "${TARGET}" is not on the server.`);
    console.error(`          Start it first: ${DIM}npm run bot${RESET}`);
    finish(1, tester);
    return;
  }

  console.log(`  ${DIM}"${TARGET}" is online; running ${cases.length} cases ...${RESET}`);
  console.log('');

  let failures = 0;

  for (const testCase of cases) {
    // Space commands out so the bot's own chat throttle is never the thing
    // under test.
    await sleep(BETWEEN_COMMANDS_MS);

    let reply: string;
    try {
      const pending = nextReply();
      tester.chat(testCase.send);
      reply = await pending;
    } catch (err) {
      failures++;
      console.log(`  ${RED}FAIL${RESET}  ${BOLD}${testCase.name}${RESET}`);
      console.log(`        sent "${testCase.send}" -- ${err instanceof Error ? err.message : err}`);
      console.log('');
      continue;
    }

    const ok = testCase.expect.test(reply);
    if (!ok) failures++;

    console.log(`  ${ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`}  ${BOLD}${testCase.name}${RESET}`);
    console.log(`        ${DIM}> ${testCase.send}${RESET}`);
    console.log(`        ${ok ? '' : `${RED}`}${reply}${RESET}`);
    if (!ok) console.log(`        ${DIM}expected to match ${testCase.expect}${RESET}`);
    console.log('');
  }

  if (failures === 0) {
    console.log(`  ${GREEN}${BOLD}All ${cases.length} chat cases passed.${RESET}`);
  } else {
    console.log(`  ${RED}${BOLD}${failures} of ${cases.length} chat cases failed.${RESET}`);
  }
  console.log('');

  finish(failures === 0 ? 0 : 1, tester);
});
