/**
 * Server-only. The two qualifying actions that keep a streak alive — a build
 * log and the weekly ritual — and the streak arithmetic they trigger. Each is
 * one Admin-SDK transaction: membership and consent are checked against the
 * live docs, "today" is computed from the profile's own IANA timezone (never
 * taken from the request), and the streak fields are written here and only
 * here. The rules freeze those fields on every client path.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { HttpError } from "./serverAuth";
import { isoWeek, nextStreak, type StreakState } from "./streaks";

export const BUILD_LOG_MAX = 300;

/** YYYY-MM-DD right now in `tz`. Falls back to UTC on a bad zone. */
export function localDayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** ISO week of the local day in `tz`. */
export function isoWeekIn(tz: string, now = new Date()): string {
  const [y, m, d] = localDayIn(tz, now).split("-").map(Number);
  return isoWeek(new Date(y, m - 1, d));
}

function streakOf(p: FirebaseFirestore.DocumentData): StreakState {
  return {
    streak: typeof p.streak === "number" ? p.streak : 0,
    streakFreezes: typeof p.streakFreezes === "number" ? p.streakFreezes : 0,
    lastActiveDay: typeof p.lastActiveDay === "string" ? p.lastActiveDay : "",
  };
}

/** Membership + consent, from the live docs. Returns what the action needs. */
async function gate(
  tx: FirebaseFirestore.Transaction,
  uid: string,
  cohortId: string
): Promise<{
  profileRef: FirebaseFirestore.DocumentReference;
  profile: FirebaseFirestore.DocumentData;
  cohortRef: FirebaseFirestore.DocumentReference;
  cohort: FirebaseFirestore.DocumentData;
}> {
  const db = adminDb();
  const profileRef = db.collection("profiles").doc(uid);
  const cohortRef = db.collection("cohorts").doc(cohortId);
  const [pSnap, cSnap] = await Promise.all([tx.get(profileRef), tx.get(cohortRef)]);
  const profile = pSnap.data();
  const cohort = cSnap.data();
  if (!profile) throw new HttpError(403, "no-profile");
  if (!cohort) throw new HttpError(404, "not-found");
  if (profile.consentStatus === "pending") throw new HttpError(403, "consent-pending");
  const members: string[] = Array.isArray(cohort.memberUids) ? cohort.memberUids : [];
  if (!members.includes(uid)) throw new HttpError(403, "not-a-member");
  return { profileRef, profile, cohortRef, cohort };
}

/** Post one line to the squad's build log and count the day. */
export async function recordBuildLog(
  uid: string,
  cohortId: string,
  rawText: unknown
): Promise<{ streak: number; day: string }> {
  const text = typeof rawText === "string" ? rawText.trim().slice(0, BUILD_LOG_MAX) : "";
  if (!text) throw new HttpError(400, "text-required");

  return adminDb().runTransaction(async (tx) => {
    const { profileRef, profile, cohortRef } = await gate(tx, uid, cohortId);
    const today = localDayIn(String(profile.timezone ?? "UTC"));
    const next = nextStreak(streakOf(profile), today);

    tx.set(cohortRef.collection("logs").doc(), {
      uid,
      name: String(profile.name ?? "?"),
      text,
      day: today,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(profileRef, {
      ...next,
      lastBuildLogDay: today,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { streak: next.streak, day: today };
  });
}

/** "We met": tick the squad's weekly streak once per ISO week and count the
 *  day for the member who pressed it. */
export async function recordRitual(
  uid: string,
  cohortId: string
): Promise<{ streak: number; weeklyStreak: number; week: string }> {
  return adminDb().runTransaction(async (tx) => {
    const { profileRef, profile, cohortRef, cohort } = await gate(tx, uid, cohortId);
    const tz = String(profile.timezone ?? "UTC");
    const today = localDayIn(tz);
    const week = isoWeekIn(tz);
    const next = nextStreak(streakOf(profile), today);

    let weeklyStreak = typeof cohort.weeklyStreak === "number" ? cohort.weeklyStreak : 0;
    if (cohort.lastRitualWeek !== week) {
      const prevWeek = isoWeekIn(tz, new Date(Date.now() - 7 * 86400000));
      weeklyStreak = cohort.lastRitualWeek === prevWeek ? weeklyStreak + 1 : 1;
      tx.update(cohortRef, { weeklyStreak, lastRitualWeek: week });
    }
    tx.update(profileRef, { ...next, updatedAt: FieldValue.serverTimestamp() });
    return { streak: next.streak, weeklyStreak, week };
  });
}
