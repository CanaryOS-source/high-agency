/** GET /api/google/status — is calendar set up, and is this mentor connected. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireMentor, errorResponse } from "../../../lib/serverAuth";
import { connectionStatus, isCalendarConfigured } from "../../../lib/googleCalendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { uid } = await requireMentor(req);
    const configured = isCalendarConfigured();
    const status = configured ? await connectionStatus(uid) : { connected: false, email: "" };
    return NextResponse.json({ configured, ...status });
  } catch (err) {
    return errorResponse(err, "google/status");
  }
}
