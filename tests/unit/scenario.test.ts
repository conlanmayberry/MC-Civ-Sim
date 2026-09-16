import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { connectRcon, decodePackets, encodePacket, readRconSettings } from '../../src/scenario/rcon.ts';
import { SCENARIOS, describeChange } from '../../src/scenario/scenarios.ts';

/**
 * The scenario harness drives the server through RCON, so the protocol is
 * tested here against a fake server -- a wrong byte in a length field would
 * otherwise show up only as a hung test run with the real server up.
 */

describe('RCON packets', () => {
  test('a packet round-trips', () => {
    const { packets, rest } = decodePackets(encodePacket(7, 2, 'list'));
    assert.deepEqual(packets, [{ id: 7, type: 2, body: 'list' }]);
    assert.equal(rest.length, 0);
  });

  test('the length field counts everything after itself', () => {
    const packet = encodePacket(1, 3, 'pw');
    assert.equal(packet.readInt32LE(0), packet.length - 4);
  });

  test('a packet split across reads waits for the rest', () => {
    // TCP guarantees order, not boundaries.
    const whole = Buffer.concat([encodePacket(1, 0, 'first'), encodePacket(2, 0, 'second')]);
    const cut = whole.length - 3;

    const firstRead = decodePackets(whole.subarray(0, cut));
    assert.deepEqual(firstRead.packets.map((p) => p.body), ['first']);

    const secondRead = decodePackets(Buffer.concat([firstRead.rest, whole.subarray(cut)]));
    assert.deepEqual(secondRead.packets.map((p) => p.body), ['second']);
  });
});

describe('reading RCON settings', () => {
  test('from server.properties, so the password lives in one place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-rcon-'));
    const file = path.join(dir, 'server.properties');
    fs.writeFileSync(file, 'server-ip=127.0.0.1\nenable-rcon=true\nrcon.port=25599\nrcon.password=secret\n');

    assert.deepEqual(readRconSettings(file), {
      enabled: true,
      host: '127.0.0.1',
      port: 25599,
      password: 'secret',
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing file reads as disabled rather than throwing', () => {
    assert.equal(readRconSettings(path.join(os.tmpdir(), 'no-such-file.properties')).enabled, false);
  });
});

/** A fake RCON server: accepts one password, echoes commands. */
async function fakeServer(password: string): Promise<{ port: number; close: () => void; commands: string[] }> {
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { packets, rest } = decodePackets(buffer);
      buffer = rest;
      for (const p of packets) {
        if (p.type === 3) {
          socket.write(encodePacket(p.body === password ? p.id : -1, 2, ''));
        } else {
          commands.push(p.body);
          const reply = encodePacket(p.id, 0, `ran: ${p.body}`);
          // Split the reply, as a real network might.
          socket.write(reply.subarray(0, 5));
          setTimeout(() => socket.write(reply.subarray(5)), 5);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, commands, close: () => server.close() };
}

describe('the RCON client', () => {
  test('authenticates, runs commands in order, and returns their output', async () => {
    const server = await fakeServer('pw');
    const rcon = await connectRcon({ enabled: true, host: '127.0.0.1', port: server.port, password: 'pw' });

    const outputs = await Promise.all([rcon.command('first'), rcon.command('second')]);
    assert.deepEqual(outputs, ['ran: first', 'ran: second']);
    assert.deepEqual(server.commands, ['first', 'second']);

    rcon.close();
    server.close();
  });

  test('a wrong password is an error, not a hang', async () => {
    const server = await fakeServer('pw');
    await assert.rejects(
      connectRcon({ enabled: true, host: '127.0.0.1', port: server.port, password: 'wrong' }),
      /rejected the password/,
    );
    server.close();
  });

  test('a server that is not there fails quickly', async () => {
    await assert.rejects(
      connectRcon({ enabled: true, host: '127.0.0.1', port: 1, password: 'pw' }, 2_000),
    );
  });
});

describe('the scenario registry', () => {
  test('ids are unique', () => {
    const ids = SCENARIOS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('scenarios that spend money say so', () => {
    // Anything that runs the agent loop needs a model, and must be opt-in.
    for (const s of SCENARIOS.filter((s) => s.id.startsWith('agent'))) {
      assert.equal(s.live, true, `${s.id} runs agents but is not marked live`);
    }
  });

  test('a pass that becomes a fail is a regression; the reverse is a fix', () => {
    assert.equal(describeChange('pass', 'fail'), 'REGRESSED');
    assert.equal(describeChange('fail', 'pass'), 'fixed');
    assert.equal(describeChange('pass', 'pass'), null);
    assert.equal(describeChange(null, 'fail'), null, 'a first-ever failure is not a regression');
  });
});
