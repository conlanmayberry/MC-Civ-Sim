import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_SCHEMAS, invokeTool } from '../../src/ai/tools.ts';
import type { Actions, ActionResult } from '../../src/bot/actions/index.ts';
import { createInbox } from '../../src/agent/inbox.ts';
import { loadIdentity } from '../../src/agent/identity.ts';
import { toPromptFragment } from '../../src/agent/identity.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The tool surface is the security boundary and the model's entire vocabulary,
 * so it is worth testing that it stays closed and that the schemas satisfy
 * OpenAI strict mode -- a violation there is rejected by the API at runtime,
 * which is an expensive place to find out.
 */

describe('tool schemas', () => {
  test('every schema satisfies strict mode', () => {
    for (const tool of TOOL_SCHEMAS) {
      const params = tool.parameters as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };

      assert.equal(params.type, 'object', `${tool.name}: parameters must be an object schema`);
      assert.equal(
        params.additionalProperties,
        false,
        `${tool.name}: strict mode requires additionalProperties: false`,
      );

      // The constraint that actually bites: strict mode requires EVERY property
      // in `required`. Optionality has to be expressed as a nullable type.
      const properties = Object.keys(params.properties ?? {});
      const required = params.required ?? [];
      assert.deepEqual(
        [...properties].sort(),
        [...required].sort(),
        `${tool.name}: strict mode requires every property to be listed in required`,
      );
    }
  });

  test('optional arguments are nullable rather than omitted', () => {
    const mine = TOOL_SCHEMAS.find((t) => t.name === 'mine_block');
    const props = (mine?.parameters as { properties: Record<string, { type: unknown }> }).properties;
    assert.deepEqual(props['count']?.type, ['integer', 'null']);
    assert.equal(props['block']?.type, 'string');
  });

  test('every tool has a description a model can act on', () => {
    for (const tool of TOOL_SCHEMAS) {
      assert.ok(tool.description.length > 20, `${tool.name}: description is too thin to be useful`);
    }
  });

  test('the surface is closed -- no escape hatches', () => {
    // An exact list on purpose: the tool surface is the security boundary, so
    // it must not grow without a person deciding it should. Updating this
    // assertion is the deliberate act.
    const names = TOOL_SCHEMAS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      // Creatures only; attacking players is refused in the action itself.
      'attack_entity',
      'collect_items',
      'craft_item',
      'eat_food',
      'equip_item',
      'follow_player',
      'give_item',
      'mine_block',
      'move_to',
      'place_block',
      // Tills and plants ground in the world; nothing outside it.
      'plant_crop',
      // Records a name and a coordinate the agent already had. It reads
      // nothing and reaches nothing outside the process.
      'remember_place',
      'send_chat',
      // set_goal only stores a string the agent shows itself next turn. It
      // touches nothing outside the process.
      'set_goal',
      // A bed in the world.
      'sleep_in_bed',
      // Furnace and chest windows in the game world, nothing outside it.
      'smelt_item',
      'stop_movement',
      'store_items',
      'take_items',
      'wear_armor',
    ]);
    // Principle 16: nothing that runs code, reads files or touches the host.
    for (const name of names) {
      assert.ok(
        !/exec|eval|shell|command|file|read|write|http|fetch/i.test(name),
        `${name} looks like an escape hatch`,
      );
    }
  });
});

function stubActions(record: string[]): Actions {
  const ok = (action: string): ActionResult => ({ ok: true, action, durationMs: 1, detail: {} });
  return {
    moveTo: async (x, y, z, range) => {
      record.push(`moveTo(${x},${y},${z},${String(range)})`);
      return ok('move_to');
    },
    followPlayer: async (u, r) => {
      record.push(`follow(${u},${String(r)})`);
      return ok('follow_player');
    },
    stop: () => {
      record.push('stop()');
      return ok('stop_movement');
    },
    mineBlock: async (b, c, r) => {
      record.push(`mine(${b},${String(c)},${String(r)})`);
      return ok('mine_block');
    },
    collectNearbyItems: async (r) => {
      record.push(`collect(${String(r)})`);
      return ok('collect_items');
    },
    craftItem: async (i, c) => {
      record.push(`craft(${i},${String(c)})`);
      return ok('craft_item');
    },
    placeBlock: async (i, x, y, z) => {
      record.push(`place(${i},${x},${y},${z})`);
      return ok('place_block');
    },
    eatFood: async () => {
      record.push('eat()');
      return ok('eat_food');
    },
    giveItem: async (i, c, u) => {
      record.push(`give(${i},${String(c)},${u})`);
      return ok('give_item');
    },
    equipItem: async (i, d) => {
      record.push(`equip(${i},${String(d)})`);
      return ok('equip_item');
    },
    attackEntity: async (target) => {
      record.push(`attackEntity(${target})`);
      return ok('attack_entity');
    },
    smeltItem: async (item, count) => {
      record.push(`smeltItem(${item},${count})`);
      return ok('smelt_item');
    },
    storeItems: async (item, count) => {
      record.push(`storeItems(${item},${String(count)})`);
      return ok('store_items');
    },
    takeItems: async (item, count) => {
      record.push(`takeItems(${String(item)},${String(count)})`);
      return ok('take_items');
    },
    plantCrop: async (seed, count) => {
      record.push(`plantCrop(${seed},${count})`);
      return ok('plant_crop');
    },
    sleepInBed: async () => {
      record.push('sleepInBed()');
      return ok('sleep_in_bed');
    },
    wearArmor: async () => {
      record.push('wearArmor()');
      return ok('wear_armor');
    },
    busy: () => false,
    current: () => null,
    interrupt: () => {},
    onReflex: () => {},
  } as Actions;
}

describe('tool dispatch', () => {
  test('null means "use the default", not literal null', () => {
    const calls: string[] = [];
    return invokeTool(stubActions(calls), () => {}, 'mine_block', {
      block: 'stone',
      count: null,
      searchRadius: null,
    }).then(() => {
      assert.deepEqual(calls, ['mine(stone,1,32)']);
    });
  });

  test('an invented tool returns a failure the model can read', async () => {
    const result = await invokeTool(stubActions([]), () => {}, 'summon_dragon', {});
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'invalid_argument');
    assert.match(result.error?.message ?? '', /no such tool/);
  });

  test('bad arguments fail as a value rather than throwing', async () => {
    // The model gets to see this and correct itself next turn.
    const result = await invokeTool(stubActions([]), () => {}, 'move_to', { x: 'over there' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'invalid_argument');
  });

  test('set_goal records the goal without touching the world', async () => {
    const calls: string[] = [];
    let recorded: string | null = null;
    const result = await invokeTool(
      stubActions(calls),
      () => {},
      'set_goal',
      { goal: 'build a shelter before nightfall' },
      (g) => {
        recorded = g;
      },
    );
    assert.equal(result.ok, true);
    assert.equal(recorded, 'build a shelter before nightfall');
    assert.deepEqual(calls, [], 'set_goal must not perform any world action');
  });

  test('restating the goal you already have is reported as doing nothing', async () => {
    // Six identical set_goal calls in one ten-minute run, each spending a whole
    // turn. The model cannot tell a no-op from a change unless it is told.
    const result = await invokeTool(
      stubActions([]),
      () => {},
      'set_goal',
      { goal: 'build a shelter' },
      () => false,
    );

    assert.equal(result.ok, true, 'nothing went wrong -- it just achieved nothing');
    assert.equal(result.detail['unchanged'], true);
    assert.match(String(result.detail['note']), /already your goal/);
  });

  test('a goal that did change carries no such note', async () => {
    const result = await invokeTool(stubActions([]), () => {}, 'set_goal', { goal: 'find food' }, () => true);
    assert.equal(result.detail['unchanged'], undefined);
  });

  test('remember_place with no coordinates means "here"', async () => {
    let got: unknown = 'not called';
    await invokeTool(
      stubActions([]),
      () => {},
      'remember_place',
      { name: 'shelter', note: null, x: null, y: null, z: null },
      () => true,
      (name, note, at) => {
        got = { name, note, at };
        return { ok: true, action: 'remember_place', durationMs: 0, detail: {} };
      },
    );
    assert.deepEqual(got, { name: 'shelter', note: '', at: null });
  });

  test('two coordinates out of three is refused rather than guessed', async () => {
    // Filling the third from the agent's own position would record a place
    // that is neither where it meant nor where it stands.
    const result = await invokeTool(stubActions([]), () => {}, 'remember_place', {
      name: 'cave',
      note: null,
      x: 100,
      y: 64,
      z: null,
    });
    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? '', /all three/);
  });

  test('give_item dispatches item, count and recipient in order', async () => {
    const calls: string[] = [];
    await invokeTool(stubActions(calls), () => {}, 'give_item', {
      item: 'bread',
      count: 2,
      username: 'Carla',
    });
    assert.deepEqual(calls, ['give(bread,2,Carla)']);
  });

  test('send_chat routes to chat rather than to an action', async () => {
    const said: string[] = [];
    const result = await invokeTool(
      stubActions([]),
      (m) => {
        said.push(m);
      },
      'send_chat',
      { message: 'hello' },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(said, ['hello']);
  });

  test('a refused message comes back as a result the model can read', async () => {
    // Chat is rate-limited (agent/voice.ts). A refusal has to be visible to
    // the model, or it believes it said something it never said.
    const result = await invokeTool(stubActions([]), () => false, 'send_chat', {
      message: 'hello',
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'blocked');
    assert.match(result.error?.message ?? '', /messages for this minute/);
  });
});

describe('inbox', () => {
  test('injections queue and drain once', () => {
    const inbox = createInbox();
    inbox.inject('go find wood', 'operator');
    assert.equal(inbox.pending(), 1);

    const drained = inbox.drain();
    assert.equal(drained[0]?.text, 'go find wood');
    assert.equal(inbox.pending(), 0, 'draining must clear, or an instruction repeats forever');
  });

  test('empty injections are ignored', () => {
    const inbox = createInbox();
    assert.equal(inbox.inject('   ', 'operator'), null);
    assert.equal(inbox.pending(), 0);
  });

  test('the queue is bounded, dropping the oldest', () => {
    const inbox = createInbox();
    for (let i = 0; i < 20; i++) inbox.inject(`instruction ${i}`, 'operator');

    const drained = inbox.drain();
    assert.ok(drained.length <= 8);
    // The newest instruction is the one that matters.
    assert.equal(drained.at(-1)?.text, 'instruction 19');
  });
});

describe('identity', () => {
  test('personality is phrased as disposition, never as an order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-id-'));
    const file = path.join(dir, 'test.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: 'test',
        username: 'Tester',
        traits: ['cautious'],
        interests: ['farming'],
      }),
    );

    const fragment = toPromptFragment(loadIdentity(file));

    assert.match(fragment, /tend to be cautious/);
    assert.match(fragment, /dispositions, not orders/);
    // The brief forbids scripting the behaviour we are trying to observe.
    assert.doesNotMatch(fragment, /you must|your goal is|your job is/i);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an assigned role is stated as a job, and only that one line is', () => {
    // Roles are a deliberate exception to the brief's "dispositions, not
    // orders" rule, and the exception has to stay contained: the traits above
    // it must not turn into instructions just because a role is present.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-id-'));
    const file = path.join(dir, 'roled.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: 'roled',
        username: 'Roled',
        role: 'miner -- supply the group with stone and ore',
        traits: ['cautious'],
      }),
    );

    const fragment = toPromptFragment(loadIdentity(file));

    assert.match(fragment, /your job is: miner/);
    assert.match(fragment, /tend to be cautious/, 'traits stay dispositions');
    // The failure mode this guards: a specialist who will not eat because
    // feeding itself is not its job.
    assert.match(fragment, /keep yourself alive/);
    assert.doesNotMatch(fragment, /nobody has told you what your purpose is/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an agent with no role keeps the original emergent framing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-id-'));
    const file = path.join(dir, 'free.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'free', username: 'Free', traits: ['bold'] }));

    const fragment = toPromptFragment(loadIdentity(file));

    assert.match(fragment, /dispositions, not orders/);
    assert.doesNotMatch(fragment, /your job is/);
    assert.equal(loadIdentity(file).role, null);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a malformed role or model is rejected at load, not at the API', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-id-'));
    const roleFile = path.join(dir, 'badrole.json');
    fs.writeFileSync(roleFile, JSON.stringify({ id: 'x', username: 'Xxx', role: 42 }));
    assert.throws(() => loadIdentity(roleFile), /role/);

    const modelFile = path.join(dir, 'badmodel.json');
    fs.writeFileSync(modelFile, JSON.stringify({ id: 'y', username: 'Yyy', model: [] }));
    assert.throws(() => loadIdentity(modelFile), /model/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an invalid Minecraft username is rejected at load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-id-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'bad', username: 'a name with spaces' }));

    assert.throws(() => loadIdentity(file), /username/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
