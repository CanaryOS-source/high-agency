/**
 * TEMPORARY — founding-batch access gate.
 *
 * POST /api/access/mentor-profile — mint a mentor profile for an allowlisted
 * mentor who arrived by magic link rather than an invite code. Auth: Firebase
 * ID token (Bearer). Body: { profile: MentorSignupInput }.
 *
 * Mirrors /api/mentor/redeem: same Admin-SDK write, same transaction shape,
 * same promote-an-existing-operator-in-place behaviour — and crucially the
 * SAME profile builder (`buildMentorProfile`), so the two entry paths can
 * never drift into producing differently-shaped mentors. The only difference
 * is what authorizes the grant: an allowlist entry with role "mentor" here, a
 * single-use code there.
 *
 * Clients are rules-blocked from ever writing `role: "mentor"`, so this must
 * stay server-side. Delete with the rest of the gate — see app/lib/accessGate.ts.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../../../lib/firebaseAdmin";
import { buildMentorProfile } from "../../../lib/mentorInviteServer";
import { lookupApprovedMember } from "../../../lib/accessGate";
import type { MentorSignupInput } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function POST(req: NextRequest) {
  const idToken = bearerToken(req);
  if (!idToken) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let uid: string;
  let email: string;
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
    email = decoded.email ?? "";
  } catch {
    return NextResponse.json({ error: "invalid-token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    profile?: MentorSignupInput;
  };

  try {
    // The allowlist is re-read here, not trusted from the claim call: this is
    // the request that actually grants the role.
    const member = await lookupApprovedMember(email);
    if (!member || member.role !== "mentor") {
      return NextResponse.json({ error: "not-approved" }, { status: 403 });
    }

    const db = adminDb();
    const profileRef = db.collection("profiles").doc(uid);

    const status = await db.runTransaction(async (tx) => {
      const snap = await tx.get(profileRef);

      if (snap.exists) {
        if (snap.data()?.role === "mentor") return "already-mentor" as const;
        // An operator account whose email was later allowlisted as a mentor:
        // promote in place so profile, XP and squads all survive.
        tx.update(profileRef, {
          role: "mentor",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "promoted" as const;
      }

      const profile = body.profile && buildMentorProfile(uid, body.profile);
      if (!profile) return "profile-required" as const;
      tx.set(profileRef, profile);
      return "created" as const;
    });

    if (status === "profile-required") {
      return NextResponse.json({ error: "profile-required" }, { status: 422 });
    }
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    console.error("[access/mentor-profile] failed:", err);
    return NextResponse.json({ error: "server-error" }, { status: 500 });
  }
}
