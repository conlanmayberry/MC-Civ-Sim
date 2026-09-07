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
      'collect_items',
      'craft_item',
      'eat_food',
      'equip_item',
      'follow_player',
      'mine_block',
      'move_to',
      'place_block',
      'send_chat',
      // set_goal only stores a string the agent shows itself next turn. It
      // touches nothing outside the process.
      'set_goal',
      'stop_movement',
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
    equipItem: async (i, d) => {
      record.push(`equip(${i},${String(d)})`);
      return ok('equip_item');
    },
    busy: () => false,
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

  test('send_chat routes to chat rather than to an action', async () => {
    const said: string[] = [];
    const result = await invokeTool(stubActions([]), (m) => said.push(m), 'send_chat', {
      message: 'hello',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(said, ['hello']);
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

  test('an invalid Minecraft username is rejected at load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-id-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'bad', username: 'a name with spaces' }));

    assert.throws(() => loadIdentity(file), /username/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
