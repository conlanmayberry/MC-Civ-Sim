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
import { Vec3 } from 'vec3';

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

  // Typed `Item | null`, but genuinely undefined at the edges of the bot
  // lifecycle -- the same trap as bot.health at spawn. A `=== null` check
  // alone lets undefined through and throws on the next property access.
  const held = bot.heldItem ?? null;

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
        // Skip the bot's OWN space -- both blocks of it. A player is roughly
        // 1.8 blocks tall, so it occupies (0,0,0) and (0,1,0), and neither can
        // be built in.
        //
        // Only (0,0,0) was excluded before, so (0,1,0) -- the head -- was
        // offered as placeable and, having a horizontal distance of zero,
        // sorted FIRST. The agent was told every turn that it could build
        // inside its own head, tried it, and the server silently refused. That
        // is a large share of why place_block ran at 15%.
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue;
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


export interface GroundProfile {
  radius: number;
  /** Columns where a surface was actually found -- some may be unloaded. */
  sampled: number;
  /** Lowest and highest surface height in the area, or null if nothing loaded. */
  minY: number | null;
  maxY: number | null;
  /** Surface height directly under the bot, for reference. */
  hereY: number | null;
}

/**
 * How much the ground varies across a small area around the bot.
 *
 * Added after place_block ran at a 37% success rate across four agents
 * building at once, dominated by "grass_block already occupies that
 * position" and "target is 9m away". `observeBlocks` says what is nearby but
 * not whether the ground UNDER a planned footprint is level, so a rectangular
 * wall plotted assuming flat ground collides with terrain on the columns that
 * happen to sit higher, and fails `unreachable` on the columns that happen to
 * be farther away once the agent is standing in the resulting gap. Digging
 * into a hillside sidesteps both problems -- every neighbour is already solid
 * -- which is very likely why builds skew underground: it is the shape the
 * failure rate rewards, not a choice about what looks good.
 *
 * Deliberately a summary, not a grid: the full per-column picture exists for
 * the dashboard in observeMapTiles, but handing an agent an 9x9 table of
 * numbers to plan from is worse than one sentence it can act on -- "this spot
 * is not flat" is something a model can react to; 81 numbers are not.
 */
export function observeGroundProfile(bot: Bot, radius = 4): GroundProfile {
  const origin = bot.entity.position;
  const originX = Math.floor(origin.x);
  const originY = Math.floor(origin.y);
  const originZ = Math.floor(origin.z);

  let minY: number | null = null;
  let maxY: number | null = null;
  let hereY: number | null = null;
  let sampled = 0;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      // Scan down from just above head height: this is about the ground right
      // here, not spelunking, so the depth is small and fixed on purpose.
      let surfaceY: number | null = null;
      for (let dy = 2; dy >= -8; dy--) {
        const block = bot.blockAt(new Vec3(originX + dx, originY + dy, originZ + dz));
        if (block === null) continue;
        if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
        surfaceY = originY + dy;
        break;
      }
      // Unloaded, or nothing solid within range -- imperfect information, not
      // an error, and left out of the summary rather than guessed at.
      if (surfaceY === null) continue;

      sampled++;
      if (minY === null || surfaceY < minY) minY = surfaceY;
      if (maxY === null || surfaceY > maxY) maxY = surfaceY;
      if (dx === 0 && dz === 0) hereY = surfaceY;
    }
  }

  return { radius, sampled, minY, maxY, hereY };
}

export interface MapTile {
  /** Offset from the map centre, in blocks. */
  dx: number;
  dz: number;
  /** Surface block name, or null if the column is unloaded or all air. */
  name: string | null;
  /** Height of that surface block. */
  y: number | null;
}

export interface MapView {
  centre: Position;
  radius: number;
  tiles: MapTile[];
}

/**
 * A top-down surface view around the bot, for the dashboard map.
 *
 * Returns the highest non-air block in each column, which is what a player
 * looking down would see. Deliberately separate from `observeBlocks`: that
 * answers "what resources are near me" for an agent, this answers "what does
 * this place look like" for a human. Merging them would make both worse.
 *
 * Cost is one column scan per tile, so the radius matters -- 20 gives a 41x41
 * grid. The dashboard polls this far less often than live state for that
 * reason.
 *
 * Still only what the bot knows: unloaded columns come back as null rather than
 * being filled in from the server's world. The map shows what the agent could
 * see, not the truth (ADR-005).
 */
export function observeMapTiles(bot: Bot, radius = 20, depth = 24): MapView {
  const origin = bot.entity.position;
  const originX = Math.floor(origin.x);
  const originY = Math.floor(origin.y);
  const originZ = Math.floor(origin.z);

  const tiles: MapTile[] = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      let found: MapTile = { dx, dz, name: null, y: null };

      // Scan down from above the bot: the first solid thing is the surface.
      for (let dy = depth; dy >= -depth; dy--) {
        const block = bot.blockAt(new Vec3(originX + dx, originY + dy, originZ + dz));
        if (block === null) continue;
        if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
        found = { dx, dz, name: block.name, y: originY + dy };
        break;
      }

      tiles.push(found);
    }
  }

  return {
    centre: toPosition(origin),
    radius,
    tiles,
  };
}
