/* ------------------------------------------------------------------ */
/* Streaks — the only game mechanic. No XP, no levels, no gates.       */
/* A streak is kept alive by doing real things: a build log or the     */
/* weekly ritual. Logging in earns nothing.                            */
/*                                                                     */
/* The math lives here (pure, shared by browser and server); the       */
/* WRITES live in app/lib/streakServer.ts behind /api/build-log and    */
/* /api/ritual. Clients cannot touch streak fields — the rules freeze  */
/* them — so the number on the flame is one the server computed.       */
/* ------------------------------------------------------------------ */

/** YYYY-MM-DD in the browser's local timezone — display only. */
export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO week id (YYYY-Www) for a local calendar date — the squad ritual
 *  cadence. Takes a Date whose local getters hold the day in question. */
export function isoWeek(d = new Date()): string {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Thursday of the current week decides the ISO year.
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      ((t.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    );
  return `${t.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const MAX_FREEZES = 3;

/** The day before a YYYY-MM-DD, as YYYY-MM-DD (calendar arithmetic, no tz). */
export function dayBefore(day: string, n = 1): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  return t.toISOString().slice(0, 10);
}

export interface StreakState {
  streak: number;
  streakFreezes: number;
  lastActiveDay: string;
}

/** One qualifying action on `today`. Same day: unchanged. Yesterday active:
 *  extend (and bank a freeze every 7 days, max 3). Missed exactly one day
 *  with a freeze banked: the freeze burns and the streak survives.
 *  Otherwise: friendly restart at 1 — never shame. Pure. */
export function nextStreak(prev: StreakState, today: string): StreakState {
  if (prev.lastActiveDay === today) return prev;

  let freezes = prev.streakFreezes ?? 0;
  let streak: number;
  if (prev.lastActiveDay === dayBefore(today, 1)) {
    streak = prev.streak + 1;
  } else if (prev.lastActiveDay === dayBefore(today, 2) && freezes > 0) {
    freezes -= 1; // freeze covers the missed day
    streak = prev.streak + 1;
  } else {
    streak = 1;
  }
  if (streak > 0 && streak % 7 === 0 && freezes < MAX_FREEZES) freezes += 1;

  return { streak, streakFreezes: freezes, lastActiveDay: today };
}
