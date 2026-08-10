/**
 * TEMPORARY — founding-batch access gate.
 *
 * POST /api/access/claim — step 2 of the gate, called right after the
 * magic-link sign-in completes. Auth: Firebase ID token (Bearer).
 *
 * Re-checks the allowlist server-side against the email IN THE VERIFIED TOKEN,
 * not anything the client sent. This is the load-bearing check: signing in is
 * not the same as being allowed in, and a Firebase account could exist from an
 * earlier era (or a different sign-in method) without being on the list.
 *
 * Not on the list → 403; the client signs the user out immediately.
 *
 * Delete with the rest of the gate — see app/lib/accessGate.ts.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { adminAuth, adminDb } from "../../../lib/firebaseAdmin";
import { lookupApprovedMember } from "../../../lib/accessGate";

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

  try {
    const member = await lookupApprovedMember(email);
    if (!member) {
      return NextResponse.json({ status: "not-approved" }, { status: 403 });
    }

    // Whether they still need onboarding decides where the client routes next.
    const profileSnap = await adminDb().collection("profiles").doc(uid).get();
    const profile = profileSnap.data();

    return NextResponse.json({
      status: "ok",
      // The allowlist decides which app they get; an already-existing profile
      // wins, so a promoted account doesn't get bounced into the wrong shell.
      role: profile?.role === "mentor" ? "mentor" : member.role,
      hasProfile: profileSnap.exists,
    });
  } catch (err) {
    console.error("[access/claim] failed:", err);
    return NextResponse.json({ error: "server-error" }, { status: 500 });
  }
}
