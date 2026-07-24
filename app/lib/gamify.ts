import { doc, updateDoc, increment, serverTimestamp } from "firebase/firestore";
import { getDb } from "./firebase";
import type { Profile, Workshop } from "./types";
import { workshopSpots } from "./types";

/* ------------------------------------------------------------------ */
/* XP economy — ~70% of achievable XP flows through verified           */
/* real-world milestones. Login/lurk behavior earns almost nothing.    */
/* Milestone XP comes from lib/milestones.ts per milestone.            */
/* ------------------------------------------------------------------ */

export const XP = {
  workshopLive: 50,
  buildLog: 10, // capped 1/day via profile.lastBuildLogDay
  ritual: 25, // capped 1/week via profile.lastRitualWeek
  helpOther: 25, // capped 3/week (batch-2 surface)
  recording: 5, // capped 2/week (batch-2 surface)
} as const;

/* ------------------------------------------------------------------ */
/* Operator Levels — the access ladder. Rewards are access and status, */
/* not stickers. Levels persist across seasons.                        */
/* ------------------------------------------------------------------ */

export interface Level {
  level: number;
  name: string;
  xp: number;
  unlocks: string;
}

export const LEVELS: Level[] = [
  { level: 1, name: "Cadet", xp: 0, unlocks: "Everything free-tier" },
  { level: 2, name: "Builder", xp: 300, unlocks: "Profile flair, build-log boost" },
  { level: 3, name: "Operator", xp: 700, unlocks: "Advanced workshops, peer-lead eligibility" },
  { level: 4, name: "Closer", xp: 1200, unlocks: "Demo-day priority slot, platform showcase" },
  { level: 5, name: "Architect", xp: 2000, unlocks: "Opportunities board, direct mentor channel" },
];

export function levelOf(xp: number): Level {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.xp) cur = l;
  return cur;
}

export function nextLevel(xp: number): Level | null {
  return LEVELS.find((l) => l.xp > xp) ?? null;
}

/** 0..1 progress from the current level toward the next (1 at L5). */
export function levelProgress(xp: number): number {
  const cur = levelOf(xp);
  const next = nextLevel(xp);
  if (!next) return 1;
  return (xp - cur.xp) / (next.xp - cur.xp);
}

/* ------------------------------------------------------------------ */
/* Entitlements — flags wired now, everything free during batch 1.     */
/* ------------------------------------------------------------------ */

export const BATCH1_ALL_FREE = true;

/** Live workshop access: the open workshop is free for everyone; the
 *  rest are Pro (all free in batch 1). Level gates apply regardless of
 *  plan — access you earn, not buy. A full room beats every other
 *  answer: the seat simply isn't there (and the rules agree). */
export function canEnroll(profile: Profile, w: Workshop): { ok: boolean; reason: string } {
  if (workshopSpots(w).full && !(w.enrolledUids ?? []).includes(profile.uid)) {
    return { ok: false, reason: "Full" };
  }
  if (w.levelGate > 0 && levelOf(profile.xp).level < w.levelGate) {
    const gate = LEVELS.find((l) => l.level === w.levelGate);
    return { ok: false, reason: `Unlocks at L${w.levelGate} ${gate?.name ?? ""}`.trim() };
  }
  if (w.open || BATCH1_ALL_FREE || profile.plan === "pro") {
    return { ok: true, reason: "" };
  }
  return { ok: false, reason: "Operator Pro" };
}

/* ------------------------------------------------------------------ */
/* Days, weeks, streaks                                                */
/* ------------------------------------------------------------------ */

/** YYYY-MM-DD in the user's local timezone — a "day" is the local day. */
export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO week id (YYYY-Www) in local time — the cohort ritual cadence. */
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

export async function awardXp(uid: string, amount: number): Promise<void> {
  await updateDoc(doc(getDb(), "profiles", uid), {
    xp: increment(amount),
    updatedAt: serverTimestamp(),
  });
}

/** Called once on app entry. Same day: no-op. Yesterday active: extend
 *  (and bank a freeze every 7 days, max 3). Missed exactly one day with
 *  a freeze banked: the freeze burns and the streak survives. Otherwise:
 *  friendly restart at 1 — never shame. (Client-trusted for v1.) */
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
