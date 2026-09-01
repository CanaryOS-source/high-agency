/** POST /api/google/disconnect — revoke and forget this mentor's token. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireMentor, errorResponse } from "../../../lib/serverAuth";
import { disconnect } from "../../../lib/googleCalendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { uid } = await requireMentor(req);
    await disconnect(uid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "google/disconnect");
  }
}
