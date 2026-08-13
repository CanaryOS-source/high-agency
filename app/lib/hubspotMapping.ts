/**
 * Firestore → HubSpot property mapping. PURE — no I/O, no Admin SDK, no env.
 *
 * Everything in here is a total function of its arguments so the whole mapping
 * is unit-testable without a network or an emulator (tests/hubspot.test.mts).
 * The sync engine does the reading and writing; this file only decides shapes.
 *
 * Two rules it exists to enforce in one place:
 *   1. An absent field is OMITTED, never sent as the string "undefined". The
 *      three applications already on record predate the form expansion and
 *      have no social/impact/problem/plan at all — a mapping that stringifies
 *      undefined would write literal garbage onto a real person's CRM record.
 *   2. Truncation happens here and nowhere else.
 */
import {
  MAX_MULTI_LINE,
  MAX_SINGLE_LINE,
  MEMBER_ROLE,
  MEMBER_STATUS,
  P,
  STD,
  YES_NO,
} from "./hubspotSchema";

/* ------------------------------------------------------------------ */
/* Source shapes                                                       */
/* ------------------------------------------------------------------ */

/**
 * An application document as it actually comes back from Firestore — every
 * field optional and `unknown`, because legacy docs are missing half of them
 * and nothing validates the collection on write beyond the security rules.
 */
export interface ApplicationDoc {
  id: string;
  name?: unknown;
  email?: unknown;
  age?: unknown;
  social?: unknown;
  building?: unknown;
  boldest?: unknown;
  impact?: unknown;
  problem?: unknown;
  plan?: unknown;
  opId?: unknown;
  queuePos?: unknown;
  createdAt?: unknown;
}

export interface ApprovedMemberDoc {
  email: string;
  role?: unknown;
  name?: unknown;
  addedAt?: unknown;
  note?: unknown;
}

export type PropertyBag = Record<string, string>;

/* ------------------------------------------------------------------ */
/* Coercion helpers                                                    */
/* ------------------------------------------------------------------ */

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** HubSpot number properties accept a numeric string; anything unparseable is
 *  dropped rather than written as 0, which would be a lie. */
function numeric(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (value.trim() !== "" && Number.isFinite(n)) return String(n);
  }
  return undefined;
}

/**
 * Normalize the many shapes a Firestore date arrives in — an Admin SDK
 * `Timestamp` (has toMillis), epoch ms, an ISO string, a `Date` — to the
 * `YYYY-MM-DD` HubSpot wants for a `date` property. Returns undefined for
 * anything it can't read, including a serverTimestamp sentinel that hasn't
 * resolved yet.
 */
export function toDateProperty(value: unknown): string | undefined {
  let ms: number | undefined;

  if (value && typeof value === "object" && "toMillis" in value) {
    const fn = (value as { toMillis: unknown }).toMillis;
    if (typeof fn === "function") {
      const n = (fn as () => number).call(value);
      if (Number.isFinite(n)) ms = n;
    }
  } else if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  }

  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

/** Add a key only when there is a value — the omit-not-"undefined" rule. */
function put(bag: PropertyBag, key: string, value: string | undefined): void {
  if (value !== undefined) bag[key] = value;
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Split a full name for HubSpot's firstname/lastname. Last space wins, so
 * "Ada King Lovelace" → "Ada King" / "Lovelace". A single token is all
 * firstname: guessing a surname out of one word is worse than leaving it blank,
 * and "firstname" is what personalisation tokens use in email.
 */
export function nameParts(fullName: unknown): {
  firstName?: string;
  lastName?: string;
} {
  if (typeof fullName !== "string") return {};
  const clean = fullName.trim().replace(/\s+/g, " ");
  if (!clean) return {};

  const cut = clean.lastIndexOf(" ");
  if (cut === -1) return { firstName: clean.slice(0, 100) };
  return {
    firstName: clean.slice(0, cut).slice(0, 100),
    lastName: clean.slice(cut + 1).slice(0, 100),
  };
}

/**
 * HubSpot-side email normalization. Trim + lowercase, same as the Firestore
 * doc-id convention in accessGate.ts — but deliberately re-stated here rather
 * than imported, because this file must stay pure (accessGate pulls in the
 * Admin SDK) and because this is about HubSpot's dedupe key, not about a
 * Firestore document id.
 */
export function hubspotEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  return clean ? clean.slice(0, 254) : undefined;
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The application's own data — answers, ids, timestamps. Deliberately does NOT
 * include any status field: whether this contact is `new`, or has a decision a
 * human already made, is the sync engine's call, and re-pushing an application
 * must never reset it.
 */
export function applicationToProperties(app: ApplicationDoc): PropertyBag {
  const bag: PropertyBag = {};

  put(bag, STD.email, hubspotEmail(app.email));
  const { firstName, lastName } = nameParts(app.name);
  put(bag, STD.firstName, firstName);
  put(bag, STD.lastName, lastName);

  put(bag, P.operatorId, text(app.opId, MAX_SINGLE_LINE));
  put(bag, P.queuePosition, numeric(app.queuePos));
  put(bag, P.age, numeric(app.age));
  put(bag, P.social, text(app.social, MAX_SINGLE_LINE));

  // Legacy docs (HA-049..051) have no impact/problem/plan/social at all.
  put(bag, P.building, text(app.building, MAX_MULTI_LINE));
  put(bag, P.boldest, text(app.boldest, MAX_MULTI_LINE));
  put(bag, P.impact, text(app.impact, MAX_MULTI_LINE));
  put(bag, P.problem, text(app.problem, MAX_MULTI_LINE));
  put(bag, P.plan, text(app.plan, MAX_MULTI_LINE));

  put(bag, P.appliedAt, toDateProperty(app.createdAt));
  put(bag, P.firestoreAppId, text(app.id, MAX_SINGLE_LINE));

  return bag;
}

/**
 * An approved member. `hasProfile` is the caller's answer to "did they
 * actually show up?" — resolving it needs Auth + Firestore, so it stays out of
 * here.
 */
export function approvedMemberToProperties(
  member: ApprovedMemberDoc,
  hasProfile: boolean
): PropertyBag {
  const bag: PropertyBag = {};

  put(bag, STD.email, hubspotEmail(member.email));
  const { firstName, lastName } = nameParts(member.name);
  put(bag, STD.firstName, firstName);
  put(bag, STD.lastName, lastName);

  bag[P.memberRole] =
    member.role === MEMBER_ROLE.mentor ? MEMBER_ROLE.mentor : MEMBER_ROLE.operator;
  // Activated wins: a signed-in operator is more than an approved one.
  bag[P.memberStatus] = hasProfile
    ? MEMBER_STATUS.activeOperator
    : MEMBER_STATUS.approvedMember;
  bag[P.platformActivated] = hasProfile ? YES_NO.yes : YES_NO.no;

  // addedAt is the moment the approval was recorded, so it maps to decidedAt —
  // NOT appliedAt, which belongs to the application push. It is epoch ms on
  // script-created docs and a Timestamp on some hand-created ones;
  // toDateProperty eats both.
  put(bag, P.decidedAt, toDateProperty(member.addedAt));

  // `note` is deliberately NOT mapped onto ha_sync_note: that property is the
  // channel the sync uses to tell staff something needed a human, and an
  // allowlist note would overwrite a live warning. The note stays in Firestore.

  return bag;
}
