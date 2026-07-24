/**
 * GET /api/cron/unassigned-squads — daily sweep for squads nobody has adopted.
 *
 * A squad with no mentor can't activate and can't clear milestones 4–7, so one
 * sitting unclaimed for a week is a product failure that has to reach a human.
 * This finds them and sends ONE summary email to the crew inbox.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`. Vercel Cron sends exactly this
 * header when CRON_SECRET is set on the project (see vercel.json for the
 * schedule). Without the env var the route refuses to run at all rather than
 * defaulting open — an unauthenticated endpoint that reads every squad and
 * sends mail is not something to leave ajar.
 *
 * Re-notification is throttled by `mentorNotifiedAt` on the cohort doc, written
 * here with the Admin SDK (clients can never touch that field — see
 * firestore.rules), so the same squad doesn't page ops every morning forever.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";
import { sendStaleSquadsEmail, type StaleSquad } from "../../../lib/opsEmail";

export const runtime = "nodejs";
/** Never cached: it both reads live state and writes. */
export const dynamic = "force-dynamic";

const DAY_MS = 86400000;
/** How long a squad may sit unclaimed before ops hears about it. */
const STALE_DAYS = 7;
/** And how long before the same squad is allowed to page ops again. */
const RENOTIFY_DAYS = 7;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron-not-configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const cutoff = Timestamp.fromMillis(now - STALE_DAYS * DAY_MS);
  const db = adminDb();

  // Firestore can't query for an ABSENT field, and legacy squads predate
  // mentorUid entirely — so bound the read by age (a single-field index) and
  // decide the rest here. Batch 1 is a few dozen squads.
  const snap = await db.collection("cohorts").where("createdAt", "<", cutoff).get();

  const stale: StaleSquad[] = [];
  const toStamp: string[] = [];

  for (const d of snap.docs) {
    const c = d.data();
    if (c.mentorUid) continue;
    if (c.state === "archived") continue;

    const notifiedMs =
      c.mentorNotifiedAt && typeof c.mentorNotifiedAt.toMillis === "function"
        ? c.mentorNotifiedAt.toMillis()
        : 0;
    if (notifiedMs && now - notifiedMs < RENOTIFY_DAYS * DAY_MS) continue;

    const createdMs =
      c.createdAt && typeof c.createdAt.toMillis === "function" ? c.createdAt.toMillis() : now;

    stale.push({
      id: d.id,
      name: String(c.name ?? "Unnamed squad"),
      mission: String(c.mission ?? ""),
      members: Array.isArray(c.memberUids) ? c.memberUids.length : 0,
      daysWaiting: Math.floor((now - createdMs) / DAY_MS),
    });
    toStamp.push(d.id);
  }

  if (stale.length === 0) {
    return NextResponse.json({ ok: true, stale: 0 });
  }

  stale.sort((a, b) => b.daysWaiting - a.daysWaiting);

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin.replace(/\/$/, "");
  const delivery = await sendStaleSquadsEmail({ squads: stale, appUrl });

  // Only mark as notified once the mail actually went out, so a provider
  // failure doesn't silently swallow the alert for another week.
  const batch = db.batch();
  for (const id of toStamp) {
    batch.update(db.collection("cohorts").doc(id), {
      mentorNotifiedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  return NextResponse.json({ ok: true, stale: stale.length, delivery });
}
