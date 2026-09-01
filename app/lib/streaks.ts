import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getDb } from "./firebase";
import type { Profile } from "./types";

/* ------------------------------------------------------------------ */
/* Streaks — the only game mechanic. No XP, no levels, no gates.       */
/* A streak is kept alive by doing real things: a build log, a weekly  */
/* ritual, or showing up to a workshop. Logging in earns nothing.      */
/* ------------------------------------------------------------------ */

/** YYYY-MM-DD in the user's local timezone — a "day" is the local day. */
export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO week id (YYYY-Www) in local time — the squad ritual cadence. */
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

/** Called after every qualifying action. Same day: no-op. Yesterday active:
 *  extend (and bank a freeze every 7 days, max 3). Missed exactly one day
 *  with a freeze banked: the freeze burns and the streak survives.
 *  Otherwise: friendly restart at 1 — never shame. (Client-trusted for v1.) */
export async function touchStreak(profile: Profile): Promise<void> {
  const today = localDay();
  if (profile.lastActiveDay === today) return;

  const yesterday = localDay(new Date(Date.now() - 86400000));
  const dayBefore = localDay(new Date(Date.now() - 2 * 86400000));

  let streak: number;
  let freezes = profile.streakFreezes ?? 0;

  if (profile.lastActiveDay === yesterday) {
    streak = profile.streak + 1;
  } else if (profile.lastActiveDay === dayBefore && freezes > 0) {
    freezes -= 1; // freeze covers the missed day
    streak = profile.streak + 1;
  } else {
    streak = 1;
  }

  // Bank one freeze per completed 7-day run.
  if (streak > 0 && streak % 7 === 0 && freezes < MAX_FREEZES) freezes += 1;

  await updateDoc(doc(getDb(), "profiles", profile.uid), {
    streak,
    streakFreezes: freezes,
    lastActiveDay: today,
    updatedAt: serverTimestamp(),
  });
}
