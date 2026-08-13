/**
 * GET /api/cron/hubspot-sync — one full two-way reconcile.
 *
 * Pushes applications and allowlist entries into HubSpot, then pulls back any
 * approve/decline a staff member set on a contact. Safe to hit as often as you
 * like: every operation is idempotent, and the pull only touches contacts whose
 * decision is still marked pending.
 *
 * Auth is the same posture as /api/cron/unassigned-squads: `Authorization:
 * Bearer $CRON_SECRET`, 503 when the secret isn't configured (refuse rather
 * than default open) and 401 on a bad bearer. This endpoint can grant platform
 * access — an approval writes the founding-batch allowlist — so leaving it ajar
 * is not an option.
 *
 * Two schedules point at it, on purpose:
 *   • vercel.json — once a day. Vercel Hobby caps crons at daily, so this is
 *     the safety net, not the mechanism.
 *   • .github/workflows/hubspot-sync.yml — every 5 minutes, which is what makes
 *     "approve someone in HubSpot and they can sign in" feel immediate.
 *
 * With HUBSPOT_ACCESS_TOKEN unset it answers 200 with
 * `{ skipped: "hubspot-not-configured" }` rather than throwing.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { reconcile } from "../../../lib/hubspotSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A reconcile is a few hundred sequential HubSpot calls at batch-1 size. */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron-not-configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await reconcile();
    // 200 even with per-record errors: the run itself succeeded, and the
    // summary is where the failures are reported. A non-2xx here would fail the
    // GitHub Action for one malformed legacy document.
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[cron/hubspot-sync] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync-failed" },
      { status: 500 }
    );
  }
}
