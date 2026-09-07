/**
 * Observation functions -- the contract between Minecraft and everything above it.
 *
 * Three properties hold here and are worth defending in review (ADR-005):
 *
 *   PURE. No side effects, no chat, no logging. Given a bot, return a value.
 *
 *   SERIALISABLE. Plain numbers, strings, arrays and objects. No Vec3, no Item,
 *   no Entity references. What comes out of here is written verbatim to
 *   telemetry in Stage 4 and handed verbatim to Claude in Stage 5; a live object
 *   reference would break both.
 *
 *   BOUNDED. Every function takes an explicit radius or limit. An unbounded
 *   observation is a memory problem in Stage 4 and an unaffordable prompt in
 *   Stage 5.
 *
 * And one thing they deliberately do NOT do: reach for ground truth. These read
 * only what the Mineflayer client knows, which is what the bot could actually
 * see. Imperfect information is a core requirement of the experiment (project
 * brief, principles 9-11), and this file is where it is either preserved or
 * quietly lost.
 */

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface SelfObservation {
  position: Position;
  velocity: Position;
  yaw: number;
  pitch: number;
  onGround: boolean;
  health: number;
  food: number;
  foodSaturation: number;
  oxygen: number;
  dimension: string;
  gameMode: string;
  timeOfDay: number;
  isDay: boolean;
  experienceLevel: number;
}

export interface InventoryItem {
  name: string;
  displayName: string;
  count: number;
  slot: number;
}

export interface InventoryObservation {
  items: InventoryItem[];
  heldItem: InventoryItem | null;
  distinctItems: number;
  totalCount: number;
  usedSlots: number;
  emptySlots: number;
}

export interface EntityObservation {
  id: number;
  kind: string;
  name: string;
  username: string | null;
  position: Position;
  distance: number;
  health: number | null;
}

export interface EntitiesObservation {
  radius: number;
  entities: EntityObservation[];
  /** Present when the list was capped, so a consumer knows it is incomplete. */
  truncated: boolean;
}

export interface BlockTally {
  name: string;
  count: number;
  nearest: Position;
  nearestDistance: number;
}

export interface PlaceableSpot {
  position: Position;
  /** The solid block this would be placed against. */
  against: Position;
}

export interface BlocksObservation {
  radius: number;
  verticalRadius: number;
  /** Number of positions actually examined -- makes the cost of the scan visible. */
  sampled: number;
  /** Non-air block types found, most numerous first. */
  blocks: BlockTally[];
}

/** Two decimals: enough to be useful, few enough to keep telemetry readable. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPosition(v: { x: number; y: number; z: number }): Position {
  return { x: round2(v.x), y: round2(v.y), z: round2(v.z) };
}

export function observeSelf(bot: Bot): SelfObservation {
  return {
    position: toPosition(bot.entity.position),
    velocity: toPosition(bot.entity.velocity),
    yaw: round2(bot.entity.yaw),
    pitch: round2(bot.entity.pitch),
    onGround: bot.entity.onGround,
    health: bot.health,
    food: bot.food,
    foodSaturation: round2(bot.foodSaturation),
    oxygen: bot.oxygenLevel,
    dimension: bot.game.dimension,
    gameMode: bot.game.gameMode,
    timeOfDay: bot.time.timeOfDay,
    isDay: bot.time.isDay,
    experienceLevel: bot.experience.level,
  };
}

export function observeInventory(bot: Bot): InventoryObservation {
  const items = bot.inventory.items().map(
    (item): InventoryItem => ({
      name: item.name,
      displayName: item.displayName,
      count: item.count,
      slot: item.slot,
    }),
  );

  const held = bot.heldItem;

  // inventory.slots includes armour and crafting slots; the main storage window
  // is what "empty slots" should mean to a consumer, so count from items().
  const MAIN_INVENTORY_SLOTS = 36;

  return {
    items,
    heldItem:
      held === null
        ? null
        : {
            name: held.name,
            displayName: held.displayName,
            count: held.count,
            slot: held.slot,
          },
    distinctItems: new Set(items.map((i) => i.name)).size,
    totalCount: items.reduce((sum, i) => sum + i.count, 0),
    usedSlots: items.length,
    emptySlots: Math.max(0, MAIN_INVENTORY_SLOTS - items.length),
  };
}

/** Best available label for an entity, preferring the specific over the generic. */
function entityName(entity: Entity): string {
  return entity.username ?? entity.displayName ?? entity.name ?? entity.mobType ?? entity.type;
}

export function observeEntities(bot: Bot, radius: number, limit: number): EntitiesObservation {
  const self = bot.entity.position;
  const found: EntityObservation[] = [];

  for (const entity of Object.values(bot.entities)) {
    if (entity.id === bot.entity.id) continue;
    // Entities can be mid-despawn; position is not guaranteed to be present.
    if (!entity.isValid || entity.position === undefined) continue;

    const distance = self.distanceTo(entity.position);
    if (distance > radius) continue;

    found.push({
      id: entity.id,
      kind: entity.type,
      name: entityName(entity),
      username: entity.username ?? null,
      position: toPosition(entity.position),
      distance: round2(distance),
      health: entity.health ?? null,
    });
  }

  found.sort((a, b) => a.distance - b.distance);

  return {
    radius,
    entities: found.slice(0, limit),
    truncated: found.length > limit,
  };
}

/**
 * Tally non-air blocks in a bounded box around the bot.
 *
 * A full scan rather than a lookup of known-interesting block names, on purpose:
 * hard-coding "interesting" would be exactly the kind of prior knowledge the
 * agent is supposed to discover for itself (principle 8).
 *
 * The vertical radius defaults smaller than the horizontal one -- it cuts the
 * volume substantially and vertical context matters less for orientation.
 */
export function observeBlocks(
  bot: Bot,
  radius: number,
  verticalRadius: number = Math.ceil(radius / 2),
): BlocksObservation {
  const origin = bot.entity.position;
  const ox = Math.floor(origin.x);
  const oy = Math.floor(origin.y);
  const oz = Math.floor(origin.z);

  const tallies = new Map<string, { count: number; nearest: Position; nearestDistance: number }>();
  let sampled = 0;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        sampled++;

        const block = bot.blockAt(origin.offset(dx, dy, dz).floored());
        // null = outside loaded chunks, which is itself imperfect information:
        // the bot genuinely does not know what is there.
        if (block === null || block.name === 'air' || block.name === 'cave_air') continue;

        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const existing = tallies.get(block.name);

        if (existing === undefined) {
          tallies.set(block.name, {
            count: 1,
            nearest: { x: ox + dx, y: oy + dy, z: oz + dz },
            nearestDistance: round2(distance),
          });
        } else {
          existing.count++;
          if (distance < existing.nearestDistance) {
            existing.nearest = { x: ox + dx, y: oy + dy, z: oz + dz };
            existing.nearestDistance = round2(distance);
          }
        }
      }
    }
  }

  const blocks = [...tallies.entries()]
    .map(([name, t]): BlockTally => ({ name, ...t }))
    .sort((a, b) => b.count - a.count);

  return { radius, verticalRadius, sampled, blocks };
}


/**
 * Positions nearby where a block could actually be placed.
 *
 * Added after watching an agent fail `place_block` five times in a row: it
 * could see WHAT was around it but never WHERE there was room, so it guessed
 * coordinates and got `blocked` every time. That was an observation gap, not a
 * reasoning failure -- the agent was asked to build without being able to see
 * empty space.
 *
 * Mirrors exactly what `placeBlock` requires: an empty position, within reach,
 * with something solid adjacent to place against. Anything it returns will be
 * accepted by the action.
 */
export function observePlaceableSpots(bot: Bot, limit = 4): PlaceableSpot[] {
  const origin = bot.entity.position;
  const found: PlaceableSpot[] = [];

  // Nearby and reachable first: place_block requires the target within ~5
  // blocks, so distant candidates would only be rejected.
  const offsets: Array<[number, number, number]> = [];
  for (const dy of [0, -1, 1]) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        offsets.push([dx, dy, dz]);
      }
    }
  }
  offsets.sort((a, b) => Math.hypot(a[0], a[2]) - Math.hypot(b[0], b[2]));

  const SUPPORTS: Array<[number, number, number]> = [
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  for (const [dx, dy, dz] of offsets) {
    if (found.length >= limit) break;

    const target = origin.offset(dx, dy, dz).floored();
    const here = bot.blockAt(target);
    if (here === null || here.boundingBox !== 'empty') continue;

    for (const [ax, ay, az] of SUPPORTS) {
      const anchor = bot.blockAt(target.offset(ax, ay, az));
      if (anchor === null || anchor.boundingBox !== 'block') continue;
      found.push({ position: toPosition(target), against: toPosition(anchor.position) });
      break;
    }
  }

  return found;
}
