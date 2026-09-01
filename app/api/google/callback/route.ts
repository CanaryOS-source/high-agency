/** GET /api/google/callback — Google sends the mentor back here. The signed
 *  state names the uid; the code becomes a stored refresh token. Redirects
 *  into the app with ?calendar=connected|error. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { completeConnect, verifyState } from "../../../lib/googleCalendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = verifyState(req.nextUrl.searchParams.get("state") ?? "");
  const back = (path: string, status: string) =>
    NextResponse.redirect(new URL(`${path}?calendar=${status}`, req.nextUrl.origin));

  if (!state) return back("/mentor", "error");
  if (!code) return back(state.returnTo, "denied");
  try {
    await completeConnect(state.uid, code, req.nextUrl.origin);
    return back(state.returnTo, "connected");
  } catch (err) {
    console.error("[google/callback] failed:", err);
    return back(state.returnTo, "error");
  }
}
