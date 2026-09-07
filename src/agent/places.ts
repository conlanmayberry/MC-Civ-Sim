/**
 * What an agent knows about where things are.
 *
 * Added after watching Alice build a shelter at 1419,71,-170, drift twenty
 * blocks away over five turns, and go on placing torches "at the shelter's
 * edge" from wherever she happened to be standing. She was not lying and she
 * was not confused about what a shelter is: nothing in the system had ever
 * recorded where hers was. Her observation says where she is NOW, and her
 * history is six turns of prose. "Our shelter" had no coordinates, so it
 * silently re-anchored to her own position, and by two hundred blocks out she
 * was sincerely reporting that she was working on it.
 *
 * This is deliberately the smallest thing that fixes that: a name, a position,
 * and a dimension. Mindcraft's memory bank -- twenty lines doing exactly this
 * -- is good evidence the small version is enough, and a large version would be
 * a research project of its own (Stage 7).
 *
 * ONE AGENT'S OWN NOTES. Places belong to the agent that recorded them, keyed
 * by agent rather than by run so they survive a restart, and are never shared
 * between agents. An agent learning where another agent's shelter is has to
 * happen by being told, in chat, like anything else -- which is precisely the
 * channel Stage 9 studies. Sharing this table would quietly cheat that.
 */

export interface Place {
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  /** Why it mattered, in the agent's own words. */
  note: string;
  updatedAt: string;
}

/** Persistence, kept behind an interface so the memory works without a database. */
export interface PlaceStore {
  load: (agentId: string) => Place[];
  upsert: (agentId: string, place: Place) => void;
}

export interface Places {
  /** Record a place, replacing any earlier one of the same name. */
  remember: (place: Omit<Place, 'updatedAt'>) => Place;
  all: () => Place[];
  get: (name: string) => Place | null;
}

/**
 * How many places an agent can hold.
 *
 * Bounded because every one of them is in every prompt from then on, and an
 * agent that names forty holes in the ground would spend its context on them.
 * The oldest is dropped, on the reasoning that a place worth keeping gets
 * re-recorded when it is visited again.
 */
export const MAX_PLACES = 12;

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/**
 * Minecraft's axes: +x is east and +z is SOUTH, so the bearing is measured from
 * -z. Getting this backwards would send an agent the wrong way with total
 * confidence, which is worse than saying nothing.
 */
export function direction(dx: number, dz: number): string {
  if (dx === 0 && dz === 0) return 'here';
  const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const index = Math.round(((degrees + 360) % 360) / 45) % 8;
  return COMPASS[index] ?? 'nearby';
}

export function distanceTo(from: { x: number; y: number; z: number }, place: Place): number {
  return Math.sqrt((place.x - from.x) ** 2 + (place.y - from.y) ** 2 + (place.z - from.z) ** 2);
}

/** Names are how the agent refers to a place, so they have to be stable and short. */
export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
}

export function createPlaces(agentId: string, store?: PlaceStore): Places {
  const places = new Map<string, Place>();
  for (const place of store?.load(agentId) ?? []) places.set(place.name, place);

  return {
    remember(input) {
      const place: Place = {
        ...input,
        name: normaliseName(input.name),
        x: Math.round(input.x),
        y: Math.round(input.y),
        z: Math.round(input.z),
        updatedAt: new Date().toISOString(),
      };

      // Delete before set so re-recording a place moves it to the newest end of
      // the insertion order, and the eviction below drops something else.
      places.delete(place.name);
      places.set(place.name, place);

      while (places.size > MAX_PLACES) {
        const oldest = places.keys().next().value;
        if (oldest === undefined) break;
        places.delete(oldest);
      }

      store?.upsert(agentId, place);
      return place;
    },

    all: () => [...places.values()],

    get: (name) => places.get(normaliseName(name)) ?? null,
  };
}

/**
 * Renders remembered places for the prompt, nearest first.
 *
 * The distance is the whole point. A list of coordinates tells an agent
 * nothing it can act on; "shelter -- 1419,71,-170, 217m northeast" tells it
 * that whatever it is standing in, it is not the shelter.
 */
export function describePlaces(
  places: readonly Place[],
  from: { x: number; y: number; z: number },
  dimension: string,
): string[] {
  if (places.length === 0) return [];

  const lines = ['Places you have recorded:'];
  const sorted = [...places].sort((a, b) => distanceTo(from, a) - distanceTo(from, b));

  for (const place of sorted) {
    const where = `${place.x},${place.y},${place.z}`;
    const note = place.note === '' ? '' : ` (${place.note})`;

    if (place.dimension !== dimension) {
      // No distance across dimensions: the number would be meaningless, and an
      // agent walking it in a straight line would be walking to nowhere.
      lines.push(`  ${place.name} -- ${where} in the ${place.dimension}${note}`);
      continue;
    }

    const metres = Math.round(distanceTo(from, place));
    const offset = metres <= 3 ? 'you are here' : `${metres}m ${direction(place.x - from.x, place.z - from.z)}`;
    lines.push(`  ${place.name} -- ${where}, ${offset}${note}`);
  }

  return lines;
}
