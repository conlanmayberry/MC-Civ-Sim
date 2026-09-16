/**
 * A minimal RCON client: the server's own channel for running commands.
 *
 * Scenario tests build their arena, teleport bots and hand out items through
 * this. Written against node:net rather than pulled in as a dependency, since
 * the protocol is four fields and the project keeps its runtime dependencies to
 * the three it genuinely needs.
 *
 * Wire format, little-endian:  int32 length | int32 id | int32 type | body | 0 0
 *   type 3  authenticate      type 2  run a command
 *   type 2  auth response (id -1 means the password was wrong)
 *   type 0  command output
 *
 * Commands are sent one at a time. Minecraft handles RCON sequentially anyway,
 * and pairing each reply to its request is then trivially correct.
 */

import fs from 'node:fs';
import net from 'node:net';

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buffer = Buffer.alloc(14 + payload.length);
  buffer.writeInt32LE(10 + payload.length, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  payload.copy(buffer, 12);
  // Two terminating nulls: one for the body string, one for the packet.
  return buffer;
}

/** Whole packets out of a stream buffer, and whatever partial packet remains. */
export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    if (buffer.length - offset - 4 < length) break;

    const start = offset + 4;
    packets.push({
      id: buffer.readInt32LE(start),
      type: buffer.readInt32LE(start + 4),
      body: buffer.toString('utf8', start + 8, start + length - 2),
    });
    offset = start + length;
  }

  return { packets, rest: buffer.subarray(offset) };
}

export interface RconSettings {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
}

/** Read straight from server.properties, so the password lives in one place. */
export function readRconSettings(propertiesPath: string): RconSettings {
  const text = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, 'utf8') : '';
  const get = (key: string): string =>
    text
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim() ?? '';

  return {
    enabled: get('enable-rcon') === 'true',
    host: get('server-ip') === '' ? '127.0.0.1' : get('server-ip'),
    port: Number(get('rcon.port')) || 25575,
    password: get('rcon.password'),
  };
}

export interface Rcon {
  /** Run a server command (no leading slash) and return its output. */
  command: (command: string) => Promise<string>;
  close: () => void;
}

export async function connectRcon(settings: RconSettings, timeoutMs = 5_000): Promise<Rcon> {
  const socket = net.connect(settings.port, settings.host);
  socket.setNoDelay(true);

  let buffer: Buffer = Buffer.alloc(0);
  let nextId = 1;
  const waiting = new Map<number, { resolve: (p: RconPacket) => void; reject: (e: Error) => void }>();
  let closed: Error | null = null;

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { packets, rest } = decodePackets(buffer);
    buffer = rest;
    for (const packet of packets) {
      // A failed auth answers with id -1, so it cannot be matched by id. There
      // is only ever one request in flight, so it belongs to that one.
      const key = packet.id === -1 ? [...waiting.keys()][0] : packet.id;
      if (key === undefined) continue;
      const waiter = waiting.get(key);
      waiting.delete(key);
      waiter?.resolve(packet);
    }
  });

  const fail = (err: Error): void => {
    closed = err;
    for (const waiter of waiting.values()) waiter.reject(err);
    waiting.clear();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('RCON connection closed')));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`could not reach RCON at ${settings.host}:${settings.port}`)), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  function send(type: number, body: string): Promise<RconPacket> {
    if (closed !== null) return Promise.reject(closed);
    const id = nextId++;
    return new Promise<RconPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`RCON timed out waiting for: ${body.slice(0, 60)}`));
      }, timeoutMs);
      waiting.set(id, {
        resolve: (packet) => {
          clearTimeout(timer);
          resolve(packet);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      socket.write(encodePacket(id, type, body));
    });
  }

  const auth = await send(TYPE_AUTH, settings.password);
  if (auth.id === -1) {
    socket.destroy();
    throw new Error('RCON rejected the password in server.properties');
  }

  // One command at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    command(command) {
      const result = queue.then(() => send(TYPE_COMMAND, command)).then((p) => p.body);
      queue = result.catch(() => undefined);
      return result;
    },
    close() {
      socket.destroy();
    },
  };
}
