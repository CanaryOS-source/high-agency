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

/** The link an operator shares. `origin` comes from the browser at call time. */
export function referralLink(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/?${REFERRAL_PARAM}=${code}`;
}
