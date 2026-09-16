#!/usr/bin/env node
/**
 * Turn on RCON for the local server, so scenario tests can drive it.
 *
 *     npm run minecraft:enable-rcon      then restart the server
 *
 * Scenarios need to run server commands -- build the test arena, teleport
 * bots into it, hand them items -- and RCON is the server's own channel for
 * that. The alternative, making a bot an operator and typing commands into
 * chat, is slower and leaves operator status lying around on a test account.
 *
 * Safe on this setup, and deliberately so:
 *   - The server binds to 127.0.0.1 (server-ip in server.properties), and RCON
 *     binds to the same address, so nothing off this machine can reach it.
 *   - The password is 32 random bytes generated here and never printed. The
 *     scenario runner reads it from server.properties rather than .env, so it
 *     lives in exactly one place.
 *
 * Idempotent: an existing password is kept, so running it twice does not break
 * anything already using the first one.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROPS = path.join(ROOT, 'minecraft', 'server', 'server.properties');

if (!fs.existsSync(PROPS)) {
  console.error('\n\x1b[31mFAILED\x1b[0m  no server.properties yet');
  console.error('        run setup-server.bat (or npm run minecraft:setup) first\n');
  process.exit(1);
}

const lines = fs.readFileSync(PROPS, 'utf8').split(/\r?\n/);
const get = (key) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
function set(key, value) {
  const index = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (index === -1) lines.push(`${key}=${value}`);
  else lines[index] = `${key}=${value}`;
}

const serverIp = get('server-ip') ?? '';
if (serverIp !== '127.0.0.1' && serverIp !== 'localhost') {
  // RCON follows server-ip. Enabling it on a server bound to every interface
  // would expose remote command execution to the network.
  console.error('\n\x1b[31mREFUSED\x1b[0m  server-ip is not loopback');
  console.error(`        server-ip=${serverIp || '(empty -- all interfaces)'}`);
  console.error('        RCON binds to the same address; set server-ip=127.0.0.1 first\n');
  process.exit(1);
}

const wasEnabled = get('enable-rcon') === 'true';
const hadPassword = (get('rcon.password') ?? '') !== '';

set('enable-rcon', 'true');
if (!hadPassword) set('rcon.password', crypto.randomBytes(32).toString('hex'));
if ((get('rcon.port') ?? '') === '') set('rcon.port', '25575');
// Every scenario command would otherwise be echoed to any op who is online.
set('broadcast-rcon-to-ops', 'false');

fs.writeFileSync(PROPS, lines.join('\n'));

console.log('');
if (wasEnabled && hadPassword) {
  console.log('\x1b[32mOK\x1b[0m  RCON was already enabled; nothing changed that matters');
} else {
  console.log(`\x1b[32mOK\x1b[0m  RCON enabled on 127.0.0.1:${get('rcon.port')}${hadPassword ? '' : ' with a new random password'}`);
  console.log('    \x1b[33mRestart the server for this to take effect.\x1b[0m');
}
console.log('');
