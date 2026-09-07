/**
 * Agent identity.
 *
 * Pulled forward from Stage 6 because the dashboard needs personality to
 * display, and because retrofitting identity onto a running agent loop is worse
 * than building it in.
 *
 * The critical constraint, from the project brief: personality traits are
 * INITIAL TENDENCIES, NOT INSTRUCTIONS. An agent told "you are a farmer, go
 * farm" proves nothing about whether farming emerges. An agent told "you tend
 * to be patient and you enjoy growing things" may or may not farm, and that
 * outcome is data. `toPromptFragment` below is careful to describe disposition
 * rather than issue orders, and that distinction is the whole experiment.
 *
 * `role` is the deliberate exception, and it is kept as its own field rather
 * than smuggled into `traits` precisely because it changes what a run
 * measures. A run with roles assigned is no longer evidence about whether
 * division of labour EMERGES; it is evidence about what a group does once it
 * already has one. Both are legitimate experiments and the operator chooses --
 * but analysis has to be able to tell them apart, so the role is recorded
 * separately in telemetry and a run without one stays comparable to every
 * earlier run.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../config.ts';

export const AGENTS_DIR = path.join(ROOT, 'config', 'agents');

export interface AgentIdentity {
  /** Stable id, used as agent_id in telemetry. */
  id: string;
  /** Minecraft username. In offline mode this determines the UUID (Stage 1). */
  username: string;
  /** A short self-description, in the agent's own terms. */
  description: string;
  /** Dispositions, not directives. */
  traits: string[];
  /** Things it tends to care about. Also not directives. */
  interests: string[];
  /** What it will not readily do. */
  values: string[];
  /**
   * An assigned job, or null for the emergent case.
   *
   * The one part of an identity that IS a directive -- see the note at the top
   * of this file about what that costs.
   */
  role: string | null;
  /**
   * Which model decides for this agent, or null for the project default.
   *
   * Per-agent so a smarter model can be trialled on ONE agent against three on
   * the cheap one, which is the only way to tell "the model is the problem"
   * from "the prompt is the problem" without changing everything at once.
   */
  model: string | null;
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export class IdentityError extends Error {}

function stringArray(value: unknown, field: string, id: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new IdentityError(`${id}: "${field}" must be an array of strings`);
  }
  return value as string[];
}

export function loadIdentity(file: string): AgentIdentity {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new IdentityError(`${file}: not a JSON object`);
  }

  const record = raw as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : path.basename(file, '.json');

  const username = record['username'];
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new IdentityError(
      `${id}: "username" must be 3-16 characters of A-Z, a-z, 0-9 or _ (Minecraft's rule)`,
    );
  }

  const role = record['role'];
  if (role !== undefined && role !== null && typeof role !== 'string') {
    throw new IdentityError(`${id}: "role" must be a string, or omitted for no assigned role`);
  }

  const model = record['model'];
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw new IdentityError(`${id}: "model" must be a string, or omitted for the default model`);
  }

  return {
    id,
    username,
    description: typeof record['description'] === 'string' ? record['description'] : '',
    traits: stringArray(record['traits'], 'traits', id),
    interests: stringArray(record['interests'], 'interests', id),
    values: stringArray(record['values'], 'values', id),
    role: typeof role === 'string' && role.trim() !== '' ? role.trim() : null,
    model: typeof model === 'string' && model.trim() !== '' ? model.trim() : null,
  };
}

export function loadIdentityById(agentId: string): AgentIdentity {
  const file = path.join(AGENTS_DIR, `${agentId}.json`);
  if (!fs.existsSync(file)) {
    const available = fs.existsSync(AGENTS_DIR)
      ? fs
          .readdirSync(AGENTS_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.basename(f, '.json'))
      : [];
    throw new IdentityError(
      `No agent "${agentId}" in config/agents/. ` +
        (available.length > 0 ? `Available: ${available.join(', ')}` : 'That directory is empty.'),
    );
  }
  return loadIdentity(file);
}

/**
 * Render identity for the system prompt.
 *
 * Phrased as "you tend to" and "you care about" rather than "you must". The
 * difference looks cosmetic and is not: the brief forbids scripting the
 * behaviour we are trying to observe.
 */
export function toPromptFragment(identity: AgentIdentity): string {
  const lines = [`You are ${identity.username}.`];

  if (identity.description !== '') lines.push(identity.description);
  if (identity.traits.length > 0) {
    lines.push(`You tend to be ${identity.traits.join(', ')}.`);
  }
  if (identity.interests.length > 0) {
    lines.push(`You find ${identity.interests.join(' and ')} interesting.`);
  }
  if (identity.values.length > 0) {
    lines.push(`You care about: ${identity.values.join('; ')}.`);
  }

  if (identity.role === null) {
    lines.push(
      'These are dispositions, not orders. Decide for yourself what to do; nobody ' +
        'has told you what your purpose is.',
    );
  } else {
    lines.push(
      `The group has agreed that your job is: ${identity.role}. That is what the ` +
        'others are relying on you for, and it is where your effort should go when ' +
        'nothing more urgent is happening. It is a job, not a cage: keep yourself ' +
        'alive, eat when you are hungry, defend yourself, and help someone in real ' +
        'trouble even when it is not your job -- a specialist who starves at their ' +
        'post is no use to anyone. Everything above is disposition rather than ' +
        'instruction; this one line is the exception.',
    );
  }

  return lines.join(' ');
}
