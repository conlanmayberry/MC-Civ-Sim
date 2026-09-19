/**
 * Why an agent died, from the server's own death message.
 *
 * Telemetry recorded that deaths happened and where, never why -- so the doctor
 * guessed from the food bar and diagnosed four agents as starving when, per the
 * server log, a skeleton had shot every one of them. The other 28 deaths in
 * that session were drowning, which nothing in the database could show at all.
 *
 * The server announces every death to everyone as a system message ("Bob
 * drowned", "Alice was shot by Skeleton"), so the cause is already arriving;
 * it only needed keeping. The message and the death packet land within a tick
 * or two of each other in either order, hence remembering the latest one
 * briefly rather than expecting it at a fixed moment.
 */

import type { Bot } from 'mineflayer';

/** How long a death message stays attributable to a death. */
const MATCH_WINDOW_MS = 5_000;
/** Also lets a caller wait this long after the death packet for the message. */
export const DEATH_CAUSE_WAIT_MS = 1_000;

const NOT_DEATHS = /^(joined|left) the game|has (made|completed|reached)|is now|is no longer/;

export interface DeathCauses {
  /** The cause of this bot's most recent death, if announced within the window. */
  latest: () => string | null;
}

/** Strip the name off "Bob was shot by Skeleton" -> "was shot by Skeleton". */
export function parseDeathMessage(username: string, message: string): string | null {
  const prefix = `${username} `;
  if (!message.startsWith(prefix)) return null;
  const rest = message.slice(prefix.length).trim();
  if (rest === '' || NOT_DEATHS.test(rest)) return null;
  return rest;
}

export function watchDeathCauses(bot: Bot): DeathCauses {
  let last: { cause: string; at: number } | null = null;
  bot.on('messagestr', (message: string, position: string) => {
    if (position !== 'system') return;
    const cause = parseDeathMessage(bot.username, message);
    if (cause !== null) last = { cause, at: Date.now() };
  });
  return {
    latest: () => (last !== null && Date.now() - last.at <= MATCH_WINDOW_MS ? last.cause : null),
  };
}
