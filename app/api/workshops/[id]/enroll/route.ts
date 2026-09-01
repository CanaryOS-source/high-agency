/** POST /api/workshops/[id]/enroll — take a seat. DELETE — give it back.
 *  Any signed-in user; the seat is claimed in a transaction and the host's
 *  calendar guest list follows. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireUser, errorResponse } from "../../../../lib/serverAuth";
import { enroll, leave } from "../../../../lib/workshopServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { uid } = await requireUser(req);
    return NextResponse.json({ status: await enroll(id, uid) });
  } catch (err) {
    return errorResponse(err, "workshops/enroll");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { uid } = await requireUser(req);
    return NextResponse.json({ status: await leave(id, uid) });
  } catch (err) {
    return errorResponse(err, "workshops/leave");
  }
}
