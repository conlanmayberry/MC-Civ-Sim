/**
 * What a run was: the code it ran, how it was configured, and the exact prompt.
 *
 * Exists because a comparison could not be trusted. Bob ran on Luna one day and
 * on Terra days later, on a different world state, with several commits landing
 * in between -- so the measured difference mixed the model with every fix that
 * shipped meanwhile, and nothing recorded could pull them apart. The same gap
 * caused the stale-process confusion four times: nothing said what code a
 * running agent was actually executing.
 *
 * Git is asked, not assumed. A machine without git, or a copy of the project
 * outside a repository, records null rather than failing to start -- a run
 * with an unknown commit is still worth having.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ManifestRow } from './store.ts';

export interface GitState {
  commit: string | null;
  dirty: boolean | null;
  /** Uncommitted paths, capped: the point is "which", not an exhaustive diff. */
  dirtyFiles: string[];
}

/** Enough to say what changed without storing a whole working tree. */
const MAX_DIRTY_FILES = 40;

function git(root: string, args: string[]): string | null {
  try {
    // trimEnd, not trim: porcelain status lines START with a significant
    // space (" M file" is modified-in-worktree), and trimming the whole output
    // ate it on the first line, so that file lost its first character.
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
  } catch {
    return null;
  }
}

/** Porcelain v1: two status columns, a space, then the path (renames: "old -> new"). */
export function parsePorcelain(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      return (arrow === -1 ? path : path.slice(arrow + 4)).replace(/^"|"$/g, '');
    })
    .filter((file) => file !== '');
}

export function readGitState(root: string): GitState {
  const commit = git(root, ['rev-parse', 'HEAD'])?.trim() ?? null;
  if (commit === null) return { commit: null, dirty: null, dirtyFiles: [] };

  const status = git(root, ['status', '--porcelain', '--untracked-files=normal']);
  if (status === null) return { commit, dirty: null, dirtyFiles: [] };

  // Telemetry and runtime files change during every run by design; counting
  // them would mark every run dirty and make the flag meaningless.
  const files = parsePorcelain(status).filter(
    (file) => !/^(data|minecraft|node_modules)\//.test(file),
  );

  return { commit, dirty: files.length > 0, dirtyFiles: files.slice(0, MAX_DIRTY_FILES) };
}

/** Short and stable: enough to tell two prompts apart at a glance. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export interface ManifestInput {
  runId: string;
  agentId: string;
  git: GitState;
  minecraftVersion: string;
  provider: string;
  model: string;
  intervalMs: number;
  budgetUsd: number;
  identity: unknown;
  settings: Record<string, unknown>;
  systemPrompt: string;
  tools: unknown;
}

export function buildManifest(input: ManifestInput): ManifestRow {
  return {
    runId: input.runId,
    agentId: input.agentId,
    createdAt: new Date().toISOString(),
    gitCommit: input.git.commit,
    gitDirty: input.git.dirty,
    dirtyFiles: input.git.dirtyFiles,
    nodeVersion: process.version,
    minecraftVersion: input.minecraftVersion,
    provider: input.provider,
    model: input.model,
    intervalMs: input.intervalMs,
    budgetUsd: input.budgetUsd,
    identity: input.identity,
    settings: input.settings,
    systemPrompt: input.systemPrompt,
    systemPromptHash: shortHash(input.systemPrompt),
    toolsHash: shortHash(JSON.stringify(input.tools)),
  };
}

/** One line for a startup banner. */
export function describeGitState(state: GitState): string {
  if (state.commit === null) return 'code: unknown (not a git checkout)';
  const short = state.commit.slice(0, 7);
  if (state.dirty === true) {
    return `code: ${short} + ${state.dirtyFiles.length} uncommitted file(s) -- this run is not reproducible from a commit`;
  }
  return `code: ${short}`;
}
