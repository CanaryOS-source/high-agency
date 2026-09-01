/** POST /api/workshops — a mentor schedules a session. Body: WorkshopWire. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireMentor, errorResponse } from "../../lib/serverAuth";
import { createWorkshop } from "../../lib/workshopServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { uid, profile } = await requireMentor(req);
    const body = await req.json().catch(() => ({}));
    const result = await createWorkshop(uid, profile, body);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, "workshops/create");
  }
}
