/** POST /api/ritual — "we met this week". Body: { cohortId }. Ticks the
 *  squad's weekly streak (once per ISO week) and the caller's daily streak. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireUser, errorResponse } from "../../lib/serverAuth";
import { recordRitual } from "../../lib/streakServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { uid } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { cohortId?: unknown };
    const cohortId = typeof body.cohortId === "string" ? body.cohortId : "";
    if (!cohortId) return NextResponse.json({ error: "bad-request" }, { status: 400 });
    return NextResponse.json(await recordRitual(uid, cohortId));
  } catch (err) {
    return errorResponse(err, "ritual");
  }
}
