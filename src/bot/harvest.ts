/**
 * Harvestability: will mining this block with this item actually drop anything?
 *
 * Distinct from `bot.canDigBlock`, which only says whether the block can be
 * broken at all (bedrock cannot). Stone can always be broken by hand, but by
 * hand it drops nothing -- so an agent that "successfully" mines stone
 * bare-handed and gets no cobblestone has learned something false about the
 * world. Checking first turns that into an honest `no_tool` failure.
 *
 * Tool SELECTION is not here: `bot.pathfinder.bestHarvestTool(block)` already
 * does it properly, weighing enchantments and status effects via
 * `block.digTime`. This module only answers the yes/no question that mineflayer
 * does not.
 *
 * Kept pure and dependency-free so it can be unit-tested without a server.
 */

/** The subset of prismarine-block we need. */
export interface HarvestableBlock {
  name: string;
  /**
   * minecraft-data's per-block map of item-id -> true for items that yield a
   * drop. Absent or empty means "anything works", which is the common case.
   */
  harvestTools?: Record<string, boolean> | undefined;
}

/** The subset of prismarine-item we need. */
export interface HeldItem {
  name: string;
  type: number;
}

export interface HarvestCheck {
  ok: boolean;
  /** Present when ok is false: why not. */
  reason?: string;
}

/**
 * True when breaking `block` while holding `item` yields its drop.
 *
 * `item` may be null, meaning bare hands.
 */
export function canHarvest(block: HarvestableBlock, item: HeldItem | null): HarvestCheck {
  const required = block.harvestTools;

  // No harvestTools entry means no tool requirement: dirt, wood, leaves, sand.
  if (required === undefined || Object.keys(required).length === 0) {
    return { ok: true };
  }

  if (item === null) {
    return { ok: false, reason: `${block.name} needs a tool; hands will drop nothing` };
  }

  if (required[String(item.type)] === true) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `${block.name} cannot be harvested with ${item.name}`,
  };
}
