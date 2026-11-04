/**
 * The game clock.
 *
 * Server-authoritative: every client is sent the same snapshot (start time,
 * cycle length, server now) and derives the same minute from it, so all
 * players cross dusk together. Pure function of time, so it is trivial to test
 * and impossible for two rooms to disagree about.
 *
 *   06:00–18:00  DAY
 *   18:00–06:00  NIGHT
 *
 * `daylight` (0..1) is what the renderer lights by. It ramps over two game
 * hours either side of dusk and dawn, so the world dims gradually instead of
 * switching off at 18:00.
 */

const MIN_PER_DAY = 24 * 60;

const smooth = t => t * t * (3 - 2 * t);

/** Light level for a fractional hour of the day. */
export function daylightAt(hour) {
  if (hour >= 7 && hour < 17) return 1;
  if (hour >= 19 || hour < 5) return 0;
  if (hour >= 17) return +(1 - smooth((hour - 17) / 2)).toFixed(4);   // dusk 17→19
  return +smooth((hour - 5) / 2).toFixed(4);                         // dawn 5→7
}

export const isNightHour = hour => hour >= 18 || hour < 6;

/**
 * @param {{ startedAt: number|null, now: number, cycleMs: number, startHour: number }} o
 */
export function clockFor({ startedAt, now, cycleMs, startHour }) {
  const running = startedAt != null;
  const elapsed = running ? Math.max(0, now - startedAt) : 0;
  const minutes = (startHour * 60 + (elapsed / cycleMs) * MIN_PER_DAY) % MIN_PER_DAY;
  const hour = minutes / 60;
  const hh = String(Math.floor(hour)).padStart(2, '0');
  const mm = String(Math.floor(minutes % 60)).padStart(2, '0');
  return {
    running,
    minutes: +minutes.toFixed(2),
    time: `${hh}:${mm}`,
    phase: isNightHour(hour) ? 'NIGHT' : 'DAY',
    daylight: daylightAt(hour),
    // What a client needs to keep its own clock ticking between packets.
    startedAt, cycleMs, startHour, serverNow: now,
  };
}
