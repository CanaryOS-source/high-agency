/** PATCH /api/workshops/[id] — edit your own session. DELETE — cancel it. */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireMentor, errorResponse } from "../../../lib/serverAuth";
import { updateWorkshop, deleteWorkshop } from "../../../lib/workshopServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { uid, profile } = await requireMentor(req);
    const body = await req.json().catch(() => ({}));
    await updateWorkshop(id, uid, profile, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "workshops/update");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { uid } = await requireMentor(req);
    await deleteWorkshop(id, uid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "workshops/delete");
  }
}
