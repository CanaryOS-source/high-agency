/**
 * TEMPORARY — founding-batch access gate.
 *
 * POST /api/access/request — step 1 of the gate. Body: { email }.
 *
 * Unauthenticated by necessity (the caller has no account yet), so it is
 * deliberately narrow: it takes one email, and the ONLY thing it can cause is
 * a sign-in link being mailed to that same address. It never reveals anything
 * about an address it was not given, and never creates an account.
 *
 * Not on the allowlist → 200 { status: "not-approved" } (not 403: this is a
 * normal, expected answer the UI renders as a polite screen, not an error).
 *
 * Delete with the rest of the gate — see app/lib/accessGate.ts.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { adminAuth } from "../../../lib/firebaseAdmin";
import {
  callerIp,
  checkRateLimit,
  isValidEmail,
  lookupApprovedMember,
  normalizeEmail,
} from "../../../lib/accessGate";
import { sendAccessEmail } from "../../../lib/accessEmail";

export const runtime = "nodejs";
/** Reads live allowlist state and sends mail — never cached. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const email = normalizeEmail(body.email);

  if (!isValidEmail(email)) {
    return NextResponse.json(
      { status: "bad-email", message: "That doesn't look like a valid email." },
      { status: 400 }
    );
  }

  // Budget is consumed by every well-formed request, approved or not, so the
  // endpoint can't be used to probe the allowlist quickly either.
  const limit = checkRateLimit([`email:${email}`, `ip:${callerIp(req.headers)}`]);
  if (!limit.ok) {
    return NextResponse.json(
      {
        status: "rate-limited",
        message: "Too many attempts. Give it a few minutes, then try again.",
        retryAfter: limit.retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  try {
    const member = await lookupApprovedMember(email);
    if (!member) {
      return NextResponse.json({ status: "not-approved" });
    }

    const origin = (process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin).replace(
      /\/$/,
      ""
    );
    const signInUrl = await adminAuth().generateSignInWithEmailLink(email, {
      url: `${origin}/login/verify`,
      handleCodeInApp: true,
    });

    const delivery = await sendAccessEmail({
      to: email,
      signInUrl,
      name: member.name,
    });

    return NextResponse.json({ status: "sent", delivery });
  } catch (err) {
    // Never leak internals (misconfigured Admin creds, Resend errors, the
    // fact that an address does or doesn't exist in Firebase Auth).
    console.error("[access/request] failed:", err);
    return NextResponse.json(
      { status: "error", message: "Couldn't send the link. Try again shortly." },
      { status: 500 }
    );
  }
}
