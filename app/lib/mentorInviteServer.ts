/**
 * Server-only mentor-invite logic. Runs exclusively inside Route Handlers
 * (`app/api/mentor/**`) via the Admin SDK, which bypasses Firestore rules —
 * the ONLY channel besides the break-glass CLI that can mint `role: "mentor"`
 * (clients are rules-blocked from ever writing it).
 *
 * Invite model (mirrors consentTokens — single-use, expiring, hash-stored):
 *  - Staff mints a random invite code locally (`scripts/mentor-invite.js`) and
 *    shares the `/mentor/join?code=…` link with a specific person.
 *  - Firestore stores only the SHA-256 HASH of the code as the doc id in
 *    `mentorInvites/{hash}` (server-only collection, rules deny all client
 *    access), so nothing readable ever contains a usable code.
 *  - Redeeming is an Admin-SDK transaction that (a) rejects used/expired codes
 *    and (b) creates the mentor profile (or promotes an existing operator) and
 *    marks the invite used in the same atomic step — one code, one mentor.
 */
import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { DOMAINS, SKILLS, normalizeFocusTag } from "./types";
import type { MentorSignupInput, VentureStage } from "./types";

const INVITES = "mentorInvites";
const PROFILES = "profiles";

/** Invite links stay valid for 30 days by default; staff can re-mint. */
export const INVITE_DEFAULT_TTL_DAYS = 30;

export type MentorInviteStatus = "valid" | "used" | "expired" | "invalid";

export interface MentorInviteDoc {
  /** Who this invite was minted for — staff note, e.g. "Sarah C <s@x.com>". */
  label: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  used: boolean;
  usedAt: Timestamp | null;
  usedByUid: string | null;
}

function hashCode(rawCode: string): string {
  return createHash("sha256").update(rawCode).digest("hex");
}

/** Read-only look-up used by the join page to fail fast on a bad code before
 *  pushing someone through sign-in (does not consume). Returns status only —
 *  never the label, which can contain the invitee's email. */
export async function peekMentorInvite(
  rawCode: string
): Promise<MentorInviteStatus> {
  if (!rawCode) return "invalid";
  const snap = await adminDb().collection(INVITES).doc(hashCode(rawCode)).get();
  if (!snap.exists) return "invalid";
  const data = snap.data() as MentorInviteDoc;
  if (data.used) return "used";
  if (data.expiresAt.toMillis() < Date.now()) return "expired";
  return "valid";
}

/* ------------------------------------------------------------------ */
/* Signup-input sanitation                                             */
/* ------------------------------------------------------------------ */

const STAGES: VentureStage[] = ["idea", "building", "launched", "revenue"];

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Mentors are niche experts: expertise/coach tags may be presets OR free
 *  text (the join form's "add your own"). Same treatment as squad focus tags:
 *  normalize each entry, fold a typed preset name onto its canonical chip,
 *  dedupe case-insensitively, drop what doesn't survive, cap the count
 *  (mirrors validStringList in the rules). */
function tagList(v: unknown, presets: readonly string[], max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const t = normalizeFocusTag(raw);
    if (!t) continue;
    const folded = presets.find((p) => p.toLowerCase() === t.toLowerCase()) ?? t;
    if (out.some((x) => x.toLowerCase() === folded.toLowerCase())) continue;
    out.push(folded);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Turn the client-submitted signup form into a complete, bounds-checked mentor
 * profile doc. The Admin SDK bypasses `isValidProfile` in the rules, so this
 * function re-imposes the same constraints server-side; the resulting doc also
 * passes the rules' owner self-UPDATE path, so mentors can edit their profile
 * from the client later. Returns null when required fields don't survive
 * sanitation (caller responds 422 and consumes nothing).
 */
export function buildMentorProfile(
  uid: string,
  input: MentorSignupInput
): Record<string, unknown> | null {
  const firstName = str(input.firstName, 60);
  const lastName = str(input.lastName, 60);
  const country = str(input.country, 60);
  const headline = str(input.headline, 90);
  const domains = tagList(input.domains, DOMAINS, 9);
  const skills = tagList(input.skills, SKILLS, 7);
  if (!firstName || !lastName || !country || !headline) return null;
  if (domains.length === 0 || skills.length === 0) return null;

  const building = str(input.building, 300);
  // Mirror operator onboarding: the stage picker only exists once there's a
  // venture described; otherwise the required field defaults to "idea".
  const stage: VentureStage =
    building && STAGES.includes(input.stage) ? input.stage : "idea";

  const timezone = str(input.timezone, 60) || "UTC";
  // Client-local signup day, same client-trusted convention as operator
  // onboarding; malformed input falls back to the UTC day.
  const localDay = /^\d{4}-\d{2}-\d{2}$/.test(input.localDay ?? "")
    ? input.localDay
    : new Date().toISOString().slice(0, 10);

  const links = (input.links ?? {}) as Record<string, unknown>;

  return {
    uid,
    // Privacy convention holds for mentors too: display name is "First L."
    name: `${firstName} ${lastName.slice(0, 1).toUpperCase()}.`,
    ageBand: "18+", // attested in the form; invites only go to known adults
    country,
    timezone,
    headline,
    building,
    stage,
    domains,
    skills,
    proofUrl: str(input.proofUrl, 300),
    proofNote: str(input.proofNote, 200),
    bio: str(input.bio, 300),
    links: {
      github: str(links.github, 200),
      linkedin: str(links.linkedin, 200),
      site: str(links.site, 200),
    },
    consentStatus: "granted", // adults — the minor consent flow never applies
    plan: "free",
    role: "mentor",
    streak: 1,
    streakFreezes: 0,
    lastActiveDay: localDay,
    lastBuildLogDay: "",
    enrolledWorkshops: [],
    pendingApplications: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/* ------------------------------------------------------------------ */
/* Redeem                                                              */
/* ------------------------------------------------------------------ */

export type MentorRedeemResult =
  /** Fresh signup: the mentor profile was created. */
  | { status: "created" }
  /** Existing operator account: role flipped to mentor, profile kept. */
  | { status: "promoted" }
  /** Already a mentor — nothing to do, invite NOT consumed. */
  | { status: "already-mentor" }
  /** No profile exists and no (valid) signup form was submitted. */
  | { status: "profile-required" }
  | { status: "used" }
  | { status: "expired" }
  | { status: "invalid" };

/**
 * Consume an invite and authoritatively grant the mentor role — atomic and
 * single-use. The transaction re-reads the invite so two concurrent redeems
 * can't both succeed, and only ever writes the caller's own uid.
 */
export async function redeemMentorInvite(
  rawCode: string,
  uid: string,
  input: MentorSignupInput | null
): Promise<MentorRedeemResult> {
  if (!rawCode) return { status: "invalid" };
  const db = adminDb();
  const inviteRef = db.collection(INVITES).doc(hashCode(rawCode));
  const profileRef = db.collection(PROFILES).doc(uid);

  return db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) return { status: "invalid" } as const;
    const invite = inviteSnap.data() as MentorInviteDoc;
    if (invite.used) return { status: "used" } as const;
    if (invite.expiresAt.toMillis() < Date.now()) {
      return { status: "expired" } as const;
    }

    const profileSnap = await tx.get(profileRef);
    const consume = () =>
      tx.update(inviteRef, {
        used: true,
        usedAt: FieldValue.serverTimestamp(),
        usedByUid: uid,
      });

    if (profileSnap.exists) {
      if (profileSnap.data()?.role === "mentor") {
        // Idempotent no-op; keep the invite live for whoever it was meant for.
        return { status: "already-mentor" } as const;
      }
      // An operator followed a mentor invite: promote the existing account
      // in place (profile, XP, squads all survive).
      tx.update(profileRef, {
        role: "mentor",
        updatedAt: FieldValue.serverTimestamp(),
      });
      consume();
      return { status: "promoted" } as const;
    }

    const profile = input && buildMentorProfile(uid, input);
    if (!profile) return { status: "profile-required" } as const;
    tx.set(profileRef, profile);
    consume();
    return { status: "created" } as const;
  });
}
