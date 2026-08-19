/**
 * Waitlist referrals — the shared vocabulary.
 *
 * Framework-free and dependency-free on purpose: the browser (Waitlist,
 * ApplyModal), the Firestore write path (firebase.ts) and the rules tests all
 * import these same constants, so the cap, the jump size and the position
 * arithmetic can never drift between the three.
 *
 * The design in one line: **a referral is arithmetic on one document, never a
 * re-sort of the queue.** Every applicant gets exactly one public counter doc
 * at `referrals/{code}` holding their base position and how many people they
 * have brought in; their displayed position is derived from those two numbers.
 * Crediting a referral is therefore a single increment on a single doc — no
 * fan-out, no query, no shifting anybody else's row.
 */

/** Public counter collection. Contains no PII — see `ReferralCounter`. */
export const REFERRALS_COLLECTION = "referrals";

/** How many confirmed referrals can ever move one operator up the queue. */
export const REFERRAL_MAX = 5;

/** Places gained per confirmed referral. */
export const REFERRAL_JUMP = 10;

/** Query parameter that carries a code into the site. */
export const REFERRAL_PARAM = "ref";

/**
 * Unambiguous alphabet — no O/0, I/1/L, U (reads as V when spoken). Codes get
 * read aloud and retyped off a phone screen, so the character set matters more
 * than the extra bit of entropy.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 6;

/** Regex form of the above, used by both the client and firestore.rules. */
export const REFERRAL_CODE_RE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/;

/**
 * The public, PII-free counter document at `referrals/{code}`.
 *
 * Everything the share screen renders lives here, so showing an operator their
 * referral progress costs exactly one read. `pos` is denormalised (it is always
 * `effectivePos(basePos, credited)`) so nothing has to be recomputed to paint
 * it, and so the value the applicant saw at submit time is the value stored.
 */
export interface ReferralCounter {
  /** Mirrors the doc id. */
  code: string;
  /** The referrer's public operator id, e.g. "HA-052". Not PII. */
  opId: string;
  /** Raw queue number at signup, before any referral credit. */
  basePos: number;
  /** Applications attributed to this code — uncapped, for our own curiosity. */
  confirmed: number;
  /** Attributions that actually moved the needle. Never exceeds REFERRAL_MAX. */
  credited: number;
  /** Displayed queue position = effectivePos(basePos, credited). */
  pos: number;
  /**
   * What this counter IS. Absent (the overwhelming majority) means an
   * applicant's own counter; `"staff"` marks a lead-source code — see
   * STAFF_COUNTER_KIND below. Clients can never write it: the create rule
   * accepts an exact field list that does not include `kind`, so only the
   * Admin SDK (scripts/staff-referrals.js) can mint one.
   */
  kind?: typeof STAFF_COUNTER_KIND;
}

/** Generate a fresh share code. Uniqueness is confirmed inside the write transaction. */
export function newReferralCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    // Node without webcrypto (older test runners). Only ever a fallback.
    for (let i = 0; i < CODE_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  // Modulo bias across a 30-letter alphabet is ~2% on the last two symbols —
  // irrelevant for a share code whose only job is to not collide.
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Coerce anything user-supplied (a query param, a pasted link, a typed code)
 * into a canonical code, or "" when it isn't one. Never throws.
 */
export function normalizeReferralCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const code = raw.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : "";
}

/**
 * The whole position model. Floors at 1 — five referrals off a low base would
 * otherwise print a zero or a negative.
 *
 * Positions are per-operator arithmetic, so two people can legitimately show
 * the same number once referrals start landing. That is the deliberate trade
 * for O(1) writes: keeping the queue strictly totally ordered would mean
 * touching every document behind the one that moved.
 */
export function effectivePos(basePos: number, credited: number): number {
  const capped = Math.min(Math.max(credited, 0), REFERRAL_MAX);
  return Math.max(1, Math.round(basePos) - capped * REFERRAL_JUMP);
}

/** Places still on the table for this operator. */
export function placesRemaining(credited: number): number {
  return Math.max(0, REFERRAL_MAX - credited) * REFERRAL_JUMP;
}

/* ------------------------------------------------------------------ */
/* Staff lead-source codes                                             */
/* ------------------------------------------------------------------ */

/**
 * A staff promo code is the SAME document shape as an applicant's counter —
 * same collection, same alphabet, same update rule — so an incoming
 * `?ref=CODE` resolves and credits through exactly one code path. What makes
 * it a lead-source counter rather than a queue position is two things:
 *
 *   1. `kind: "staff"`. Unforgeable from a browser (see ReferralCounter.kind),
 *      and the one bit the UI needs to stop promising a queue jump to somebody
 *      who has no queue position to jump.
 *   2. `basePos: 1`. This is the FIXED POINT of the position arithmetic:
 *      effectivePos(1, c) === max(1, 1 - c*10) === 1 for every c, so the
 *      position a staff counter reports never drifts no matter how many people
 *      it brings in. Nothing has to special-case the rules, the write path, or
 *      the arithmetic — the numbers simply stop meaning anything.
 *
 * The only load-bearing number on a staff counter is therefore `confirmed`:
 * how many applications that code brought in. `credited` still climbs to
 * REFERRAL_MAX and stops, because the shared update rule increments it; it is
 * inert bookkeeping on a staff counter, not a cap on anything.
 */
export const STAFF_COUNTER_KIND = "staff";

/** See above — the value of basePos for which the position model is inert. */
export const STAFF_BASE_POS = 1;

/** Public operator id on a staff counter. Constant and non-identifying: the
 *  counter is world-readable and the id is unused by every read path, so there
 *  is nothing to gain from putting a person's name on it. */
export const STAFF_OP_ID = "HA-STAFF";

/** True for a lead-source counter. Tolerates any shape — this runs on data
 *  that arrived from a public document. */
export function isStaffCounter(
  counter: Pick<ReferralCounter, "kind"> | null | undefined
): boolean {
  return counter?.kind === STAFF_COUNTER_KIND;
}

/**
 * The complete `referrals/{code}` document for a staff code, minus the two
 * timestamps (which are SDK sentinels the caller supplies). Shared by the
 * provisioning script and its tests so the shape can only be defined once.
 */
export function staffCounterFields(code: string): {
  code: string;
  opId: string;
  basePos: number;
  confirmed: number;
  credited: number;
  pos: number;
  kind: typeof STAFF_COUNTER_KIND;
} {
  return {
    code,
    opId: STAFF_OP_ID,
    basePos: STAFF_BASE_POS,
    confirmed: 0,
    credited: 0,
    pos: STAFF_BASE_POS,
    kind: STAFF_COUNTER_KIND,
  };
}

/** The link an operator shares. `origin` comes from the browser at call time. */
export function referralLink(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/?${REFERRAL_PARAM}=${code}`;
}
