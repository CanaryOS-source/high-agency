/** POST /api/build-log — post one line to your squad's build log. Body:
 *  { cohortId, text }. The server writes the log AND the streak. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireUser, errorResponse } from "../../lib/serverAuth";
import { recordBuildLog } from "../../lib/streakServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { uid } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { cohortId?: unknown; text?: unknown };
    const cohortId = typeof body.cohortId === "string" ? body.cohortId : "";
    if (!cohortId) return NextResponse.json({ error: "bad-request" }, { status: 400 });
    return NextResponse.json(await recordBuildLog(uid, cohortId, body.text));
  } catch (err) {
    return errorResponse(err, "build-log");
  }
}
