/**
 * TEMPORARY — founding-batch access gate. Client-side.
 *
 * The browser half of the gate: thin fetch wrappers over app/api/access/**.
 * Kept out of db.ts on purpose — db.ts is the permanent data layer, and this
 * whole file goes away when the batch ends (see app/lib/accessGate.ts for the
 * removal checklist).
 */
import { getFirebaseAuth } from "./firebase";
import type { MentorSignupInput } from "./types";

/** Where the requested email is stashed so /login/verify can complete the
 *  sign-in. Firebase requires the email back at completion time; it is only
 *  absent when the link is opened on a different device, which the verify
 *  page handles by asking. */
export const ACCESS_EMAIL_KEY = "ha:accessEmail";

export type AccessRequestStatus =
  | "sent"
  | "not-approved"
  | "bad-email"
  | "rate-limited"
  | "error";

/** Ask for a sign-in link. Never throws on a normal outcome — "not-approved"
 *  is an answer, not a failure. */
export async function requestAccessLink(email: string): Promise<{
  status: AccessRequestStatus;
  message?: string;
}> {
  try {
    const res = await fetch("/api/access/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: AccessRequestStatus;
      message?: string;
    };
    return { status: data.status ?? "error", message: data.message };
  } catch {
    return { status: "error" };
  }
}

export interface AccessClaim {
  ok: boolean;
  role: "operator" | "mentor";
  hasProfile: boolean;
}

/** Re-check the allowlist against the signed-in identity and find out where
 *  this person belongs. A false `ok` means sign them straight back out. */
export async function claimAccess(): Promise<AccessClaim> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("not-signed-in");
  const idToken = await user.getIdToken();

  const res = await fetch("/api/access/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    role?: "operator" | "mentor";
    hasProfile?: boolean;
  };

  return {
    ok: res.ok && data.status === "ok",
    role: data.role === "mentor" ? "mentor" : "operator",
    hasProfile: Boolean(data.hasProfile),
  };
}

/** Create the mentor profile for an allowlisted mentor (the magic-link
 *  equivalent of redeeming an invite code). Server-side write — clients can
 *  never author `role: "mentor"` themselves. */
export async function createApprovedMentorProfile(
  profile: MentorSignupInput
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("not-signed-in");
  const idToken = await user.getIdToken();

  const res = await fetch("/api/access/mentor-profile", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profile }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
  };
  return { ok: res.ok, ...data };
}
