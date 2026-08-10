/**
 * TEMPORARY — founding-batch access gate. Server-only.
 *
 * ============================================================================
 * This module exists to make production safe to open for the free founding
 * batch (~50 people). Only an email that staff has explicitly added to
 * `approvedMembers` may obtain an account at all; everybody else lands on a
 * polite "not in the batch yet" screen pointing back at the waitlist.
 *
 * It is meant to be DELETED IN ONE COMMIT once the batch is over. Everything
 * gate-specific lives in files named `access*` plus the `approvedMembers`
 * rules block — nothing here entangles with product logic. To remove it:
 *   1. delete app/lib/accessGate.ts, app/lib/accessEmail.ts,
 *      app/api/access/**, app/(platform)/login/verify/, scripts/approve.js
 *   2. restore an ordinary sign-in UI in app/(platform)/login/page.tsx
 *   3. drop `isApprovedMember()` from the profiles create rule and the
 *      `approvedMembers` match block in firestore.rules
 * ============================================================================
 *
 * Storage: `approvedMembers/{email}` where the doc id is the email TRIMMED and
 * LOWERCASED, so Sai can add a member by hand in the Firebase Console without
 * running anything. Client access is deny-all (see firestore.rules) — this is
 * server-only data, read here through the Admin SDK.
 */
import { adminDb } from "./firebaseAdmin";

export const APPROVED_MEMBERS = "approvedMembers";

/** Which app an approved member gets. Mirrors `Role` in types.ts, but kept
 *  separate on purpose: the gate must not become load-bearing for the domain
 *  model it is temporarily standing in front of. */
export type ApprovedRole = "operator" | "mentor";

export interface ApprovedMember {
  /** Normalized (trimmed + lowercased) email — also the doc id. */
  email: string;
  role: ApprovedRole;
  /** Display only; never shown to other members. */
  name?: string;
  /** Epoch ms. OPTIONAL: absent on docs hand-created in the Console. */
  addedAt?: number;
  note?: string;
}

/** The doc id convention, in one place. Trim + lowercase, nothing else — the
 *  Console click-path documented in QA-HANDOFF.md depends on this being
 *  something a human can reproduce by typing. */
export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Deliberately loose: a real mailbox check is the sign-in link itself (an
 *  unreachable address simply never arrives). This only rejects input that
 *  could not be an address at all, and bounds the length so a hostile body
 *  can't be used as a Firestore doc id. Firestore doc ids also cannot contain
 *  "/", which the shape check already excludes. */
export function isValidEmail(email: string): boolean {
  return (
    email.length > 0 &&
    email.length <= 254 &&
    /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email)
  );
}

/**
 * Look up an approved member. Returns null when the email is not on the list
 * or the doc is malformed (a hand-created doc missing `role`, say) — a doc we
 * can't read a role out of is not an approval.
 */
export async function lookupApprovedMember(
  rawEmail: string
): Promise<ApprovedMember | null> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) return null;

  const snap = await adminDb().collection(APPROVED_MEMBERS).doc(email).get();
  if (!snap.exists) return null;

  const data = snap.data() ?? {};
  const role = data.role === "mentor" ? "mentor" : data.role === "operator" ? "operator" : null;
  if (!role) return null;

  return {
    email,
    role,
    ...(typeof data.name === "string" ? { name: data.name } : {}),
    // Console-created docs often have no addedAt at all — that must not throw.
    ...(typeof data.addedAt === "number" ? { addedAt: data.addedAt } : {}),
    ...(typeof data.note === "string" ? { note: data.note } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Best-effort rate limiting                                           */
/* ------------------------------------------------------------------ */

/** 5 requests per 15 minutes, keyed per-email AND per-IP. */
export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

/**
 * In-process sliding window. Deliberately NOT durable: on Vercel this map
 * lives inside one Fluid Compute instance, so a determined caller spreading
 * requests across instances gets more than the nominal budget. That is
 * accepted — the real protections are that (a) an unapproved email never
 * sends mail at all, and (b) Firebase itself rate-limits link generation.
 * This exists to stop an accidental loop and casual inbox-spamming of a known
 * approved address, not to be a security control.
 */
const hits = new Map<string, number[]>();

function tooMany(key: string, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Keep the map from growing without bound in a long-lived instance. */
function prune(now: number): void {
  if (hits.size < 5_000) return;
  for (const [key, times] of hits) {
    if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(key);
  }
}

/**
 * Consume one unit of budget against every supplied key (email, IP). Returns
 * `retryAfter` in seconds when any key is over budget. Checks all keys before
 * recording, so a blocked request doesn't also burn the other key's budget.
 */
export function checkRateLimit(keys: string[]): {
  ok: boolean;
  retryAfter: number;
} {
  const now = Date.now();
  prune(now);
  const present = keys.filter(Boolean);

  for (const key of present) {
    const recent = (hits.get(key) ?? []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS
    );
    if (recent.length >= RATE_LIMIT_MAX) {
      const oldest = Math.min(...recent);
      return {
        ok: false,
        retryAfter: Math.max(
          1,
          Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000)
        ),
      };
    }
  }

  for (const key of present) tooMany(key, now);
  return { ok: true, retryAfter: 0 };
}

/** Caller IP, best-effort. Vercel sets x-forwarded-for; local dev often has
 *  neither header, in which case every local caller shares one bucket. */
export function callerIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "unknown";
}
