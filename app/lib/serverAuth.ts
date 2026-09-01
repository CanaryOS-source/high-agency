/**
 * Server-only. The one way a Route Handler learns who is calling: a Firebase
 * ID token in `Authorization: Bearer <token>`, verified with the Admin SDK.
 * Never import from client components.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "./firebaseAdmin";

export interface Caller {
  uid: string;
  email: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Throws HttpError(401) when there is no valid token. */
export async function requireUser(req: NextRequest): Promise<Caller> {
  const idToken = bearerToken(req);
  if (!idToken) throw new HttpError(401, "unauthenticated");
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email ?? "" };
  } catch {
    throw new HttpError(401, "invalid-token");
  }
}

/** A signed-in caller whose profile says mentor. Returns the profile data
 *  too, since every mentor route needs at least the display name. */
export async function requireMentor(
  req: NextRequest
): Promise<Caller & { profile: Record<string, unknown> }> {
  const caller = await requireUser(req);
  const snap = await adminDb().collection("profiles").doc(caller.uid).get();
  const profile = snap.data();
  if (!profile || profile.role !== "mentor") throw new HttpError(403, "forbidden");
  return { ...caller, profile };
}

/** Uniform error → JSON. Anything that isn't an HttpError is a 500 with the
 *  detail kept server-side. */
export function errorResponse(err: unknown, label: string): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.code }, { status: err.status });
  }
  console.error(`[${label}] failed:`, err);
  return NextResponse.json({ error: "internal" }, { status: 500 });
}
