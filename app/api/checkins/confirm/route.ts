/** POST /api/checkins/confirm — the squad's mentor puts a time on a request.
 *  Body: ConfirmWire. Creates the calendar event + Meet when connected. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireMentor, errorResponse } from "../../../lib/serverAuth";
import { confirmCheckIn } from "../../../lib/checkinServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { uid, profile } = await requireMentor(req);
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await confirmCheckIn(uid, profile, body));
  } catch (err) {
    return errorResponse(err, "checkins/confirm");
  }
}
