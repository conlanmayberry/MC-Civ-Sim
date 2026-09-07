#!/usr/bin/env node
/**
 * ADR-001 verification probe.
 *
 *     npm run bot:probe          (the Paper server must be running)
 *
 * A bot can log in cleanly against a version minecraft-data models only
 * approximately -- the handshake proves the protocol matched, not that the
 * block, item and recipe data is right. If the dataset is subtly wrong, every
 * layer above inherits the error: Stage 3 mines the wrong block, Stage 5
 * reasons about a world that is not there.
 *
 * So this probe re-runs on every version change. It is deliberately
 * version-agnostic: it asks minecraft-data what the configured version should
 * resolve to, then checks the live server agrees.
 *
 * So this probe checks the data, not the connection. It exits non-zero on
 * failure, and prints enough detail for a human to judge the borderline cases.
 */

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';
import type { IndexedData } from 'minecraft-data';

import minecraftData from 'minecraft-data';

import { loadConfig } from '../src/config.ts';

const SPAWN_TIMEOUT_MS = 30_000;
/** Chunks stream in after spawn; scanning immediately reads mostly nulls. */
const CHUNK_SETTLE_MS = 3_000;
const SCAN_RADIUS = 12;
const SCAN_VERTICAL_RADIUS = 6;

interface CheckResult {
  ok: boolean;
  detail: string;
  /** Extra lines printed under the result, for human judgement. */
  notes?: string[];
}

interface Check {
  name: string;
  run: (bot: Bot, registry: IndexedData) => CheckResult;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** Blocks and items any overworld survival world must know about. */
const KNOWN_BLOCKS = [
  'stone',
  'dirt',
  'grass_block',
  'oak_log',
  'water',
  'iron_ore',
  'diamond_ore',
  'crafting_table',
  'furnace',
  'chest',
];

const KNOWN_ITEMS = [
  'oak_planks',
  'stick',
  'crafting_table',
  'iron_ingot',
  'wheat',
  'bread',
  'diamond_pickaxe',
  'torch',
];

/** Recipes Stage 3's crafting work depends on immediately. */
const KNOWN_RECIPES = ['oak_planks', 'stick', 'crafting_table', 'torch'];

const checks: Check[] = [
  {
    name: 'version resolution',
    run: (bot, registry) => {
      const config = loadConfig();
      const dataVersion = registry.version.dataVersion;
      const majorVersion = registry.version.majorVersion;

      // Mineflayer reports the DATASET version it resolved to, not the string
      // we passed in: connect to 26.1.2 and bot.version reads "26.1"; connect
      // to 1.21.8 and it reads "1.21.8". That mapping is minecraft-data doing
      // its job, so rather than hardcode either answer, ask minecraft-data what
      // the configured version SHOULD resolve to and check it agrees.
      const expected = minecraftData(config.version);
      const expectedMajor = expected === null ? null : expected.version.majorVersion;

      const ok = expectedMajor !== null && majorVersion === expectedMajor;
      return {
        ok,
        detail: ok
          ? `requested ${config.version} -> dataset ${majorVersion} (dataVersion ${dataVersion})`
          : `expected ${config.version} to resolve to ${expectedMajor ?? '(no dataset)'}, got ${majorVersion}`,
        notes: [
          `server brand: ${bot.game.serverBrand}`,
          `dimension:    ${bot.game.dimension}`,
          `bot.version:  ${bot.version}`,
        ],
      };
    },
  },

  {
    name: 'registries populated',
    run: (_bot, registry) => {
      const counts = {
        blocks: Object.keys(registry.blocksByName).length,
        items: Object.keys(registry.itemsByName).length,
        entities: Object.keys(registry.entitiesByName).length,
        foods: Object.keys(registry.foodsByName).length,
        recipes: Object.keys(registry.recipes).length,
      };
      const empty = Object.entries(counts).filter(([, n]) => n === 0);
      return {
        ok: empty.length === 0,
        detail:
          empty.length === 0
            ? Object.entries(counts)
                .map(([k, n]) => `${k}=${n}`)
                .join(' ')
            : `empty registries: ${empty.map(([k]) => k).join(', ')}`,
      };
    },
  },

  {
    name: 'block name round-trip',
    run: (_bot, registry) => {
      const missing: string[] = [];
      const inconsistent: string[] = [];

      for (const name of KNOWN_BLOCKS) {
        const def = registry.blocksByName[name];
        if (def === undefined) {
          missing.push(name);
          continue;
        }
        // name -> id -> name must be stable, or lookups elsewhere are unsafe.
        if (registry.blocks[def.id]?.name !== name) inconsistent.push(name);
      }

      const bad = [...missing, ...inconsistent];
      return {
        ok: bad.length === 0,
        detail:
          bad.length === 0
            ? `${KNOWN_BLOCKS.length}/${KNOWN_BLOCKS.length} resolve by name and id`
            : `missing: [${missing.join(', ')}] inconsistent: [${inconsistent.join(', ')}]`,
      };
    },
  },

  {
    name: 'item name round-trip',
    run: (_bot, registry) => {
      const bad = KNOWN_ITEMS.filter((name) => {
        const def = registry.itemsByName[name];
        return def === undefined || registry.items[def.id]?.name !== name;
      });
      return {
        ok: bad.length === 0,
        detail:
          bad.length === 0
            ? `${KNOWN_ITEMS.length}/${KNOWN_ITEMS.length} resolve by name and id`
            : `failed: ${bad.join(', ')}`,
      };
    },
  },

  {
    name: 'live chunk palette',
    run: (bot, registry) => {
      // THE test this probe exists for. Everything above reads minecraft-data
      // talking to itself; this decodes real chunk bytes the server sent.
      const origin = bot.entity.position;
      const tally = new Map<string, number>();

      let sampled = 0;
      let loaded = 0;
      let unnamed = 0;
      let unknownName = 0;
      let stateOutOfRange = 0;
      const examples: string[] = [];

      for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        for (let dy = -SCAN_VERTICAL_RADIUS; dy <= SCAN_VERTICAL_RADIUS; dy++) {
          for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
            sampled++;
            const block = bot.blockAt(origin.offset(dx, dy, dz).floored());
            if (block === null) continue; // Outside loaded chunks.
            loaded++;

            if (typeof block.name !== 'string' || block.name === '') {
              unnamed++;
              if (examples.length < 5) examples.push(`stateId ${block.stateId} has no name`);
              continue;
            }

            const def = registry.blocksByName[block.name];
            if (def === undefined) {
              unknownName++;
              if (examples.length < 5) examples.push(`"${block.name}" not in registry`);
              continue;
            }

            // A stateId outside the registry's declared range for that block
            // means the palette we decoded with does not match the one the
            // server encoded with.
            if (block.stateId < def.minStateId || block.stateId > def.maxStateId) {
              stateOutOfRange++;
              if (examples.length < 5) {
                examples.push(
                  `${block.name} stateId ${block.stateId} outside [${def.minStateId}, ${def.maxStateId}]`,
                );
              }
              continue;
            }

            tally.set(block.name, (tally.get(block.name) ?? 0) + 1);
          }
        }
      }

      const top = [...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, n]) => `${name} x${n}`);

      const failures = unnamed + unknownName + stateOutOfRange;
      const ok = loaded > 0 && failures === 0;

      const notes = [
        `sampled ${sampled}, ${loaded} in loaded chunks, ${tally.size} distinct block types`,
        `top blocks: ${top.join(', ')}`,
        `${DIM}^ eyeball this: it should look like a normal overworld surface${RESET}`,
      ];
      if (examples.length > 0) notes.push(`examples: ${examples.join('; ')}`);

      return {
        ok,
        detail:
          loaded === 0
            ? 'no chunks loaded -- cannot judge the palette'
            : ok
              ? `all ${loaded} decoded blocks consistent with the ${registry.version.majorVersion} palette`
              : `unnamed=${unnamed} unknown=${unknownName} stateOutOfRange=${stateOutOfRange}`,
        notes,
      };
    },
  },

  {
    name: 'recipe resolution',
    run: (bot, registry) => {
      const failed: string[] = [];
      const found: string[] = [];

      for (const name of KNOWN_RECIPES) {
        const item = registry.itemsByName[name];
        if (item === undefined) {
          failed.push(`${name} (no such item)`);
          continue;
        }
        // craftingTable=true: include 3x3 recipes, not just the 2x2 inventory grid.
        const recipes = bot.recipesAll(item.id, null, true);
        if (recipes.length === 0) failed.push(`${name} (no recipes)`);
        else found.push(`${name} x${recipes.length}`);
      }

      return {
        ok: failed.length === 0,
        detail: failed.length === 0 ? found.join(', ') : `failed: ${failed.join(', ')}`,
      };
    },
  },

  {
    name: 'food registry',
    run: (_bot, registry) => {
      // Stage 3's eat_food depends on this being both present and sane.
      const bread = registry.foodsByName['bread'];
      const ok = bread !== undefined && bread.foodPoints > 0;
      return {
        ok,
        detail: ok
          ? `bread restores ${bread.foodPoints} food, ${Object.keys(registry.foodsByName).length} foods known`
          : 'bread missing or has no food value',
      };
    },
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
  // Deliberately NOT unref'd: an unref'd timer lets Node exit on its own with
  // code 0, silently discarding a failure result.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 250);
  return undefined as never;
}

const config = loadConfig();

console.log('');
console.log(`${BOLD}  MC-Civ-Sim probe${RESET}  minecraft-data correctness for ${config.version}`);
console.log(`  ${DIM}connecting to ${config.host}:${config.port} as ${config.username}_probe${RESET}`);
console.log('');

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  // Distinct username: joining as the real bot would collide with a running one.
  username: `${config.username}_p`.slice(0, 16),
  version: config.version,
  auth: 'offline',
  logErrors: false,
});

const spawnTimer = setTimeout(() => {
  console.error(`${RED}  FAILED${RESET}  no spawn within ${SPAWN_TIMEOUT_MS / 1000}s.`);
  console.error(`          Is the server running? ${DIM}npm run minecraft${RESET}`);
  finish(1, bot);
}, SPAWN_TIMEOUT_MS);
spawnTimer.unref();

bot.on('error', (err) => {
  clearTimeout(spawnTimer);
  console.error(`${RED}  FAILED${RESET}  connection error: ${err.message}`);
  console.error(`          Is the server running? ${DIM}npm run minecraft${RESET}`);
  finish(1, null);
});

bot.on('kicked', (reason) => {
  clearTimeout(spawnTimer);
  console.error(`${RED}  FAILED${RESET}  kicked: ${JSON.stringify(reason)}`);
  finish(1, null);
});

bot.once('spawn', () => {
  clearTimeout(spawnTimer);
  console.log(`  ${DIM}spawned; waiting ${CHUNK_SETTLE_MS / 1000}s for chunks to stream in ...${RESET}`);
  console.log('');

  setTimeout(() => {
    // prismarine-registry ships no type declarations, so bot.registry is `any`
    // under skipLibCheck. IndexedData is the shape it actually has.
    const registry = bot.registry as unknown as IndexedData;

    let failures = 0;

    for (const check of checks) {
      let result: CheckResult;
      try {
        result = check.run(bot, registry);
      } catch (err) {
        result = {
          ok: false,
          detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!result.ok) failures++;

      const badge = result.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`  ${badge}  ${BOLD}${check.name}${RESET}`);
      console.log(`        ${result.detail}`);
      for (const note of result.notes ?? []) console.log(`        ${DIM}${note}${RESET}`);
      console.log('');
    }

    if (failures === 0) {
      console.log(`  ${GREEN}${BOLD}All ${checks.length} checks passed.${RESET}`);
      console.log(
        `  ${DIM}minecraft-data is consistent with this ${config.version} server.${RESET}`,
      );
    } else {
      console.log(`  ${RED}${BOLD}${failures} of ${checks.length} checks failed.${RESET}`);
      console.log(
        `  ${YELLOW}minecraft-data does not model this server correctly. Pick a version${RESET}`,
      );
      console.log(
        `  ${YELLOW}in minecraft/config/paper-version.json that mineflayer tests against,${RESET}`,
      );
      console.log(
        `  ${YELLOW}re-run setup, and regenerate the world. See ADR-001.${RESET}`,
      );
    }
    console.log('');

    finish(failures === 0 ? 0 : 1, bot);
  }, CHUNK_SETTLE_MS);
});
