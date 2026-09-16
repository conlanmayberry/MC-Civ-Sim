/**
 * Did the replayed decision do what the original did?
 *
 * Kept pure and separate from the model calls, so what counts as "the same
 * decision" is testable without an API key -- and so it is one definition, not
 * something re-decided each time a report is read.
 *
 * Three grades, because "different" alone hides the interesting case. Picking
 * the same tools with different arguments (mine the same block type at another
 * spot, walk to a slightly different coordinate) is usually noise. Picking
 * different TOOLS -- replying where the original did not, eating where it
 * mined -- is a genuinely different decision, and that is what a prompt or
 * model change is actually being tested for.
 */

import { attemptKey } from '../agent/setbacks.ts';

export interface Call {
  name: string;
  args: Record<string, unknown>;
}

export type Agreement = 'identical' | 'same_tools' | 'different';

export interface Comparison {
  agreement: Agreement;
  /** Tool names the original used that the replay did not, with multiplicity. */
  dropped: string[];
  /** Tool names the replay used that the original did not. */
  added: string[];
}

/** Multiset difference: what is in `a` and not matched in `b`. */
function without(a: readonly string[], b: readonly string[]): string[] {
  const remaining = [...b];
  const out: string[] = [];
  for (const item of a) {
    const index = remaining.indexOf(item);
    if (index === -1) out.push(item);
    else remaining.splice(index, 1);
  }
  return out;
}

/**
 * Order-insensitive. The agent loop reorders calls itself (speech first), so
 * the order a model listed them in is not part of what it decided.
 */
export function compareCalls(original: readonly Call[], replayed: readonly Call[]): Comparison {
  const originalKeys = original.map((c) => attemptKey(c.name, c.args)).sort();
  const replayedKeys = replayed.map((c) => attemptKey(c.name, c.args)).sort();

  const originalNames = original.map((c) => c.name);
  const replayedNames = replayed.map((c) => c.name);
  const dropped = without(originalNames, replayedNames);
  const added = without(replayedNames, originalNames);

  if (
    originalKeys.length === replayedKeys.length &&
    originalKeys.every((key, i) => key === replayedKeys[i])
  ) {
    return { agreement: 'identical', dropped: [], added: [] };
  }

  return {
    agreement: dropped.length === 0 && added.length === 0 ? 'same_tools' : 'different',
    dropped,
    added,
  };
}

export interface ToolShift {
  tool: string;
  original: number;
  replayed: number;
}

/**
 * How often each tool was chosen, before and after.
 *
 * The single most readable result of a replay: "send_chat 140 -> 60" says what
 * a prompt change did to behaviour in one line, where a list of individual
 * divergent decisions takes an afternoon to read.
 */
export function toolShift(
  pairs: ReadonlyArray<{ original: readonly Call[]; replayed: readonly Call[] }>,
): ToolShift[] {
  const counts = new Map<string, { original: number; replayed: number }>();
  const bump = (tool: string, side: 'original' | 'replayed'): void => {
    const entry = counts.get(tool) ?? { original: 0, replayed: 0 };
    entry[side]++;
    counts.set(tool, entry);
  };

  for (const pair of pairs) {
    for (const call of pair.original) bump(call.name, 'original');
    for (const call of pair.replayed) bump(call.name, 'replayed');
  }

  return [...counts.entries()]
    .map(([tool, c]) => ({ tool, ...c }))
    .sort((a, b) => Math.abs(b.replayed - b.original) - Math.abs(a.replayed - a.original) || b.original - a.original);
}

/** A call as one short line: the same key setbacks use, so it reads the same everywhere. */
export function formatCalls(calls: readonly Call[]): string {
  if (calls.length === 0) return '(nothing)';
  return calls.map((c) => attemptKey(c.name, c.args)).join('  ');
}
