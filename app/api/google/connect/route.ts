/** POST /api/google/connect — start the OAuth dance for the signed-in mentor.
 *  Returns { url } for the client to navigate to. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireMentor, errorResponse } from "../../../lib/serverAuth";
import { connectUrl, isCalendarConfigured, signState } from "../../../lib/googleCalendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { uid } = await requireMentor(req);
    if (!isCalendarConfigured()) {
      return NextResponse.json({ error: "not-configured" }, { status: 503 });
    }
    const body = (await req.json().catch(() => ({}))) as { returnTo?: string };
    const returnTo =
      typeof body.returnTo === "string" && body.returnTo.startsWith("/") ? body.returnTo : "/mentor";
    return NextResponse.json({ url: connectUrl(signState(uid, returnTo), req.nextUrl.origin) });
  } catch (err) {
    return errorResponse(err, "google/connect");
  }
}
