/**
 * Staff lead-source codes — the server half. Admin SDK, bypasses security
 * rules, never imported from a client component.
 *
 * Same split as consentServer.ts / mentorInviteServer.ts: app/lib/staffReferrals.ts
 * holds the roster and the pure decisions, this file does the reading and
 * writing, and scripts/staff-referrals.js is a thin CLI over it. The split is
 * what makes provisioning testable — tests/staffReferrals.test.mts drives these
 * functions against the emulator, so "re-running does not mint a second code"
 * is a proved claim rather than a promise in a comment.
 *
 * Nothing here creates an Auth user, a profile, an approvedMembers entry or an
 * application. A staff promo code is a counter and a private mapping, full stop.
 */
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  REFERRALS_COLLECTION,
  newReferralCode,
  referralLink,
  staffCounterFields,
} from "./referral";
import {
  STAFF_CODES_COLLECTION,
  STAFF_ROSTER,
  planStaffCode,
  staffMappingFields,
  validateRoster,
  type StaffCodePlan,
  type StaffMember,
} from "./staffReferrals";

/** Codes are 30^6 ≈ 7e8, so this loop realistically never runs twice. */
const CODE_ATTEMPTS = 5;

export type StaffCodeAction =
  | "exists"
  | "created"
  | "would-create"
  | "conflict";

export interface StaffCodeResult {
  slug: string;
  name: string;
  slackId: string;
  action: StaffCodeAction;
  /** Why a conflict, or why an apply came back as `exists`. Null otherwise. */
  reason: string | null;
  /** Null on `would-create` and `conflict` — there is no code to hand out. */
  code: string | null;
  link: string | null;
  /** Applications this code has brought in. Null when there is no counter. */
  confirmed: number | null;
}

export interface StaffProvisionSummary {
  mode: "dry-run" | "apply";
  origin: string;
  collections: { counters: string; mapping: string };
  staff: StaffCodeResult[];
  conflicts: Array<{ slug: string; reason: string }>;
  /** False when anything needs a human. The CLI exits non-zero on it. */
  ok: boolean;
}

/**
 * Read what currently exists for one roster entry and decide what to do.
 * Two document reads, both by id, and no writes — this is the whole dry run.
 */
export async function planMember(
  db: Firestore,
  member: StaffMember
): Promise<StaffCodePlan> {
  const mapSnap = await db
    .collection(STAFF_CODES_COLLECTION)
    .doc(member.slug)
    .get();
  const mapping = mapSnap.exists ? (mapSnap.data() ?? null) : null;

  let counter = null;
  const code = mapping && typeof mapping.code === "string" ? mapping.code : "";
  if (code) {
    const counterSnap = await db.collection(REFERRALS_COLLECTION).doc(code).get();
    counter = counterSnap.exists ? (counterSnap.data() ?? null) : null;
  }

  return planStaffCode(member, mapping, counter);
}

/**
 * Mint one staff code, atomically.
 *
 * The mapping is re-read INSIDE the transaction because a plan is stale the
 * moment it is printed: another run, or another person, may have provisioned
 * the same slug in between. `create` rather than `set` on both documents means
 * a race loses loudly instead of overwriting a code that may already be sitting
 * in somebody's post.
 */
export async function mintStaffCode(
  db: Firestore,
  member: StaffMember
): Promise<{ code: string; raced: boolean }> {
  return db.runTransaction(async (tx) => {
    const mapRef = db.collection(STAFF_CODES_COLLECTION).doc(member.slug);
    const mapSnap = await tx.get(mapRef);
    if (mapSnap.exists) {
      // A mapping that appeared between planning and here — another run, or a
      // transaction retry. It is NOT trusted on sight: whoever wrote it may
      // have written it badly, and returning its `code` unchecked would report
      // a malformed or half-written pair as a healthy `exists` and hand out a
      // link that credits nobody. Re-read the counter and re-run the SAME
      // validation the plan uses; only a pair that passes every invariant is
      // an `exists`.
      const mapping = mapSnap.data() ?? null;
      const raced = mapping && typeof mapping.code === "string" ? mapping.code : "";
      const counterSnap = raced
        ? await tx.get(db.collection(REFERRALS_COLLECTION).doc(raced))
        : null;
      const plan = planStaffCode(
        member,
        mapping,
        counterSnap?.exists ? (counterSnap.data() ?? null) : null
      );
      if (plan.action !== "exists") {
        // Thrown, not returned: provisionStaffCodes turns this into a conflict
        // row, which is the same outcome the planning path gives for the same
        // broken state. Nothing is written either way.
        throw new Error(
          plan.action === "conflict"
            ? plan.reason
            : `mapping for ${member.slug} appeared mid-transaction but does not ` +
              `describe a usable code`
        );
      }
      return { code: plan.code, raced: true };
    }

    // Every read before any write — a hard Firestore requirement.
    let code = "";
    for (let i = 0; i < CODE_ATTEMPTS && !code; i++) {
      const candidate = newReferralCode();
      const taken = await tx.get(
        db.collection(REFERRALS_COLLECTION).doc(candidate)
      );
      if (!taken.exists) code = candidate;
    }
    if (!code) {
      throw new Error(
        `could not find a free referral code in ${CODE_ATTEMPTS} attempts`
      );
    }

    const now = FieldValue.serverTimestamp();
    tx.create(db.collection(REFERRALS_COLLECTION).doc(code), {
      ...staffCounterFields(code),
      createdAt: now,
      updatedAt: now,
    });
    tx.create(mapRef, staffMappingFields(member, code, now));
    return { code, raced: false };
  });
}

export interface ProvisionOptions {
  /** Write. Omitted or false means plan only — the default everywhere. */
  apply?: boolean;
  /** Origin for the shareable link. */
  origin?: string;
  roster?: StaffMember[];
  db?: Firestore;
}

/**
 * Plan (and optionally provision) the whole roster.
 *
 * Idempotent by construction: a slug that already has a valid mapping/counter
 * pair is reported as `exists` and not touched, so this can be re-run as often
 * as you like. A pair that disagrees with itself is reported as a `conflict`
 * and left exactly as it was — repairing it automatically could detach a live
 * link, so a human decides.
 */
export async function provisionStaffCodes(
  options: ProvisionOptions = {}
): Promise<StaffProvisionSummary> {
  const {
    apply = false,
    origin = "https://high-agency.io",
    roster = STAFF_ROSTER,
    db = adminDb(),
  } = options;

  // Fail before touching anything: a typo in the roster should not leave three
  // of five provisioned.
  const rosterProblems = validateRoster(roster);
  if (rosterProblems.length) {
    throw new Error(
      "the staff roster in app/lib/staffReferrals.ts is invalid:\n" +
        rosterProblems.map((p) => `    - ${p}`).join("\n")
    );
  }

  const staff: StaffCodeResult[] = [];

  for (const member of roster) {
    const base = { slug: member.slug, name: member.name, slackId: member.slackId };
    const plan = await planMember(db, member);

    if (plan.action === "conflict") {
      staff.push({
        ...base,
        action: "conflict",
        reason: plan.reason,
        code: null,
        link: null,
        confirmed: null,
      });
      continue;
    }

    if (plan.action === "exists") {
      staff.push({
        ...base,
        action: "exists",
        reason: null,
        code: plan.code,
        link: referralLink(origin, plan.code),
        confirmed: plan.confirmed,
      });
      continue;
    }

    if (!apply) {
      staff.push({
        ...base,
        action: "would-create",
        reason: null,
        code: null,
        link: null,
        confirmed: 0,
      });
      continue;
    }

    try {
      const { code, raced } = await mintStaffCode(db, member);
      staff.push({
        ...base,
        action: raced ? "exists" : "created",
        reason: raced ? "another run provisioned this slug first" : null,
        code,
        link: code ? referralLink(origin, code) : null,
        confirmed: 0,
      });
    } catch (err) {
      staff.push({
        ...base,
        action: "conflict",
        reason: err instanceof Error ? err.message : "provisioning failed",
        code: null,
        link: null,
        confirmed: null,
      });
    }
  }

  const conflicts = staff
    .filter((r) => r.action === "conflict")
    .map((r) => ({ slug: r.slug, reason: r.reason ?? "unknown" }));

  return {
    mode: apply ? "apply" : "dry-run",
    origin,
    collections: {
      counters: REFERRALS_COLLECTION,
      mapping: STAFF_CODES_COLLECTION,
    },
    staff,
    conflicts,
    ok: conflicts.length === 0,
  };
}
