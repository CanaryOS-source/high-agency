/**
 * POST /api/hubspot/application — body { applicationId }.
 *
 * Fired by the public apply form immediately after the Firestore write, so a
 * new applicant shows up in the CRM in seconds instead of on the next cron
 * tick. The cron is still the safety net: if this call never lands, the next
 * reconcile picks the document up.
 *
 * PUBLIC, because the apply form is public — so it is written to be worth
 * nothing to an attacker:
 *   • it accepts an id, never data, and reads the document itself;
 *   • it refuses a document that is already synced (no re-push loop);
 *   • it refuses a document older than 15 minutes, so the id of an old
 *     application isn't a lever for anything;
 *   • it is rate-limited per IP;
 *   • it returns 200 with a `skipped` reason for every one of those cases, and
 *     when HubSpot isn't configured at all. The applicant's success screen must
 *     never depend on the CRM being reachable, so there is nothing here for the
 *     client to react to.
 * It also reveals nothing: the response never echoes the document.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { adminDb } from "../../../lib/firebaseAdmin";
import { hubspotConfigured } from "../../../lib/hubspot";
import { APPLICATIONS, pushApplication } from "../../../lib/hubspotSync";

export const runtime = "nodejs";
/** Reads and writes live state — never cached. */
export const dynamic = "force-dynamic";

/** A just-submitted application only. Anything older is the cron's job. */
const MAX_AGE_MS = 15 * 60_000;

/* ------------------------------------------------------------------ */
/* Best-effort per-IP rate limit                                       */
/* ------------------------------------------------------------------ */

/**
 * Deliberately a local copy of the in-process sliding window accessGate.ts
 * uses, rather than an import: that module is the temporary founding-batch gate
 * and is meant to be deleted in one commit, and the CRM sync must not be part
 * of the wreckage when it goes.
 *
 * Same caveat as there: this lives in one Fluid Compute instance, so it is a
 * guard against an accidental loop and casual abuse, not a security control.
 * The real protections are the age and already-synced checks above.
 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  if (hits.size > 5_000) {
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(k);
    }
  }
  const recent = (hits.get(key) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function callerIp(headers: Headers): string {
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "unknown";
}

/** Firestore auto-ids are 20 chars; bound the input and reject a path. */
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes("/")
  );
}

function ok(skipped?: string) {
  return NextResponse.json(skipped ? { ok: true, skipped } : { ok: true });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    applicationId?: unknown;
  };
  if (!validId(body.applicationId)) return ok("bad-id");

  if (rateLimited(`ip:${callerIp(req.headers)}`)) return ok("rate-limited");

  // Cheapest possible answer when the portal token isn't set — which is the
  // state today. No Firestore read, no work at all.
  if (!hubspotConfigured()) return ok("hubspot-not-configured");

  try {
    const db = adminDb();
    const snap = await db.collection(APPLICATIONS).doc(body.applicationId).get();
    if (!snap.exists) return ok("not-found");

    const data = snap.data() ?? {};
    if (data.hubspotSyncedAt) return ok("already-synced");

    const createdMs =
      typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : 0;
    // A serverTimestamp can still be unresolved microseconds after the write,
    // which reads as 0 — treat that as fresh, not as ancient.
    if (createdMs && Date.now() - createdMs > MAX_AGE_MS) return ok("too-old");

    const res = await pushApplication(body.applicationId, db);
    return ok(res.status === "skipped" ? res.reason : undefined);
  } catch (err) {
    // Log for us, 200 for the applicant. The cron will retry.
    console.error("[hubspot/application] push failed:", err);
    return ok("push-failed");
  }
}
