import type { Cohort, Profile } from "./types";

/** v1 matching: domain-tag overlap + interests-wanted overlap + a
 *  timezone-band boost + an open-with-room nudge. No embeddings yet —
 *  deliberate. Returns a score plus the "why matched" chips shown on the
 *  card. (Weekly hours are captured per-application, not used to rank.) */

export interface Match {
  cohort: Cohort;
  score: number;
  why: string[];
  /** Tags/skills already spoken for by a `why` chip. Cards use these to drop
   *  the duplicate plain chips — "Both building ai" and an "AI" chip on the
   *  same card is the same fact twice. */
  matchedTags: string[];
  matchedWants: string[];
}

/** Hour offset between two IANA timezones right now (coarse — good
 *  enough to call "same band" within ±3h). */
function tzOffsetHours(tz: string): number | null {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const local = parseInt(fmt.format(now), 10);
    return isNaN(local) ? null : local;
  } catch {
    return null;
  }
}

export function scoreCohort(profile: Profile, cohort: Cohort): Match {
  let score = 0;
  const why: string[] = [];

  // Domain overlap — the core "building things like yours" signal.
  const shared = cohort.tags.filter((t) => (profile.domains ?? []).includes(t));
  if (shared.length > 0) {
    score += shared.length * 30;
    why.push(`Both building ${shared[0].toLowerCase()}`);
  }

  // They want what you have.
  const wanted = (cohort.lookingFor ?? []).filter((s) => (profile.skills ?? []).includes(s));
  if (wanted.length > 0) {
    score += wanted.length * 20;
    why.push(`They need ${wanted[0].toLowerCase()}`);
  }

  // Timezone overlap — can you actually make the weekly ritual?
  const mine = tzOffsetHours(profile.timezone);
  const theirs = tzOffsetHours(cohort.timezone);
  if (mine !== null && theirs !== null) {
    const diff = Math.min(Math.abs(mine - theirs), 24 - Math.abs(mine - theirs));
    if (diff <= 3) {
      score += 25;
      why.push("Same timezone band");
    } else if (diff >= 8) {
      score -= 25;
    }
  }

  // Room to join.
  if (cohort.open && cohort.memberUids.length < 8) score += 10;

  return {
    cohort,
    score,
    why: why.slice(0, 3),
    matchedTags: shared,
    matchedWants: wanted,
  };
}

export function rankCohorts(profile: Profile, cohorts: Cohort[]): Match[] {
  return cohorts
    .map((c) => scoreCohort(profile, c))
    .sort((a, b) => b.score - a.score);
}
