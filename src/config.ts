/**
 * Typed configuration, resolved once at startup.
 *
 * Precedence: process.env > .env > defaults. The Minecraft version default is
 * read from minecraft/config/paper-version.json rather than hard-coded, so the
 * bot cannot silently drift from the server it is meant to talk to.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PIN_FILE = path.join(ROOT, 'minecraft', 'config', 'paper-version.json');

/**
 * Minimal .env reader. Shared with scripts/start-server.mjs -- a .mjs file can
 * import this .ts module directly under Node's native type stripping, so there
 * is one implementation rather than two that drift.
 *
 * Deliberately not dotenv: this is a dozen lines, and Stage 1 established a
 * no-runtime-dependency policy for infrastructure scripts.
 */
export function loadEnvFile(root: string = ROOT): Record<string, string> {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};

  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

export interface BotConfig {
  readonly host: string;
  readonly port: number;
  /** Minecraft version string; see docs/decisions.md ADR-001 and ADR-003. */
  readonly version: string;
  readonly username: string;

  readonly reconnect: {
    readonly enabled: boolean;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly maxAttempts: number;
  };

  readonly observation: {
    /** Horizontal radius for block scans. Bounded on purpose -- see ADR-005. */
    readonly blockRadius: number;
    readonly entityRadius: number;
    readonly maxEntities: number;
  };

  readonly chat: {
    /** Minimum gap between outgoing messages. Minecraft kicks for spam. */
    readonly minIntervalMs: number;
    readonly commandPrefix: string;
  };
}

class ConfigError extends Error {}

function readPinnedVersion(): string | undefined {
  try {
    const pin: unknown = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
    if (typeof pin === 'object' && pin !== null && 'minecraftVersion' in pin) {
      const v = (pin as { minecraftVersion: unknown }).minecraftVersion;
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    // Pin file missing or malformed: fall through to the env value. Not fatal
    // here -- `npm run minecraft:setup` is the place that enforces the pin.
  }
  return undefined;
}

function intFrom(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} must be an integer, got "${raw}"`);
  return n;
}

// Minecraft's own username rules. Worth enforcing rather than letting the
// server reject the login with a less obvious message.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function loadConfig(env: Record<string, string | undefined> = {
  ...loadEnvFile(),
  ...process.env,
}): BotConfig {
  const port = intFrom(env, 'MC_PORT', 25565);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`MC_PORT must be between 1 and 65535, got ${port}`);
  }

  const username = env['BOT_USERNAME'] ?? 'CivBot_01';
  if (!USERNAME_RE.test(username)) {
    throw new ConfigError(
      `BOT_USERNAME must be 3-16 characters of A-Z, a-z, 0-9 or _, got "${username}"`,
    );
  }

  const version = env['MC_VERSION'] ?? readPinnedVersion();
  if (version === undefined) {
    throw new ConfigError(
      'Could not determine the Minecraft version. Set MC_VERSION in .env, or ' +
        'restore minecraft/config/paper-version.json.',
    );
  }

  return {
    host: env['MC_HOST'] ?? '127.0.0.1',
    port,
    version,
    username,
    reconnect: {
      enabled: env['BOT_RECONNECT'] !== 'false',
      initialDelayMs: intFrom(env, 'BOT_RECONNECT_INITIAL_MS', 1_000),
      maxDelayMs: intFrom(env, 'BOT_RECONNECT_MAX_MS', 60_000),
      maxAttempts: intFrom(env, 'BOT_RECONNECT_MAX_ATTEMPTS', 10),
    },
    observation: {
      blockRadius: intFrom(env, 'BOT_BLOCK_RADIUS', 16),
      entityRadius: intFrom(env, 'BOT_ENTITY_RADIUS', 32),
      maxEntities: intFrom(env, 'BOT_MAX_ENTITIES', 25),
    },
    chat: {
      minIntervalMs: intFrom(env, 'BOT_CHAT_MIN_INTERVAL_MS', 900),
      commandPrefix: env['BOT_COMMAND_PREFIX'] ?? 'bot',
    },
  };
}
