/**
 * The sync engine. Server-only, Admin SDK, bypasses security rules.
 *
 * Direction 1 — Firebase → HubSpot (push): every application and every
 * approved member becomes a Contact with its full application on the record,
 * so staff can read, segment and mail from one place.
 *
 * Direction 2 — HubSpot → Firebase (pull): staff sets `ha_application_status`
 * to Approved or Declined on the contact, and the next sync applies it — an
 * approval writes the founding-batch allowlist entry that actually lets that
 * person get an account. This direction is POLL-based, not webhook-based, on
 * purpose: the portal is on a tier with no workflow webhook actions, so there
 * is nothing to subscribe to. `ha_decision_synced` is the marker that stops a
 * decision being applied twice.
 *
 * Everything here is idempotent and independently failing: one bad record
 * collects an error and the run continues. `reconcile()` is safe to call as
 * often as you like.
 *
 * If HUBSPOT_ACCESS_TOKEN is unset every entry point returns a "skipped"
 * summary instead of throwing. We do not have a portal token yet.
 */
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebaseAdmin";
import { APPROVED_MEMBERS, isValidEmail, normalizeEmail } from "./accessGate";
import {
  getContactByEmail,
  hubspotConfigured,
  patchContactById,
  searchAllContacts,
  upsertContactByEmail,
  type HubSpotContact,
} from "./hubspot";
import {
  applicationToProperties,
  approvedMemberToProperties,
  hubspotEmail,
  nameParts,
  type ApplicationDoc,
  type ApprovedMemberDoc,
  type PropertyBag,
} from "./hubspotMapping";
import {
  APPLICATION_STATUS,
  DECISION_SYNCED,
  DECISION_READ_PROPERTIES,
  MEMBER_ROLE,
  MEMBER_STATUS,
  P,
} from "./hubspotSchema";
import { sendApprovalEmail } from "./hubspotEmail";

export const APPLICATIONS = "applications";
export const PROFILES = "profiles";

/**
 * Firestore cannot query for an ABSENT field, and "never synced" is exactly
 * that. So a reconcile reads a bounded page of each collection and decides in
 * memory — the same trade-off the unassigned-squads sweep makes. Batch 1 is a
 * few dozen records; if either collection ever outgrows this the summary says
 * `truncated` rather than silently syncing a subset.
 */
export const RECONCILE_SCAN_LIMIT = 500;

/** Marker written onto an allowlist entry the CRM created. The decline path
 *  will only ever delete an entry carrying this — a hand-added mentor is not
 *  the CRM's to destroy. */
export const HUBSPOT_SOURCE = "hubspot";

/* ------------------------------------------------------------------ */
/* Summary shapes                                                      */
/* ------------------------------------------------------------------ */

export interface SyncError {
  /** What we were doing: "push-application", "pull-decision", … */
  stage: string;
  /** Firestore doc id or HubSpot contact id — never an email, never PII. */
  ref: string;
  message: string;
}

export interface ReconcileSummary {
  skipped?: "hubspot-not-configured";
  pushedApplications: number;
  pushedMembers: number;
  approvals: number;
  declines: number;
  /** True when a bounded read hit its ceiling and more work remains. */
  truncated: boolean;
  errors: SyncError[];
}

function emptySummary(): ReconcileSummary {
  return {
    pushedApplications: 0,
    pushedMembers: 0,
    approvals: 0,
    declines: 0,
    truncated: false,
    errors: [],
  };
}

/** Error text safe to put in a JSON response and a log line. */
function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "unknown error";
}

/* ------------------------------------------------------------------ */
/* Push: applications                                                  */
/* ------------------------------------------------------------------ */

export type PushResult =
  | { status: "pushed"; contactId: string }
  | { status: "skipped"; reason: string };

/**
 * Push one application to HubSpot and stamp the link back onto the Firestore
 * doc. The document is READ HERE with the Admin SDK — a caller (including the
 * public route) only ever supplies an id, never data.
 *
 * Status handling is the important part: on a contact we are creating we set
 * `new` / `pending` / `applicant`, but on a contact that already exists we only
 * FILL IN missing statuses. Re-pushing an application must never walk back a
 * decision a human has already made in the CRM.
 */
export async function pushApplication(
  applicationId: string,
  db: Firestore = adminDb()
): Promise<PushResult> {
  if (!hubspotConfigured()) {
    return { status: "skipped", reason: "hubspot-not-configured" };
  }

  const ref = db.collection(APPLICATIONS).doc(applicationId);
  const snap = await ref.get();
  if (!snap.exists) return { status: "skipped", reason: "not-found" };

  const data = snap.data() ?? {};
  const email = hubspotEmail(data.email);
  if (!email || !isValidEmail(email)) {
    return { status: "skipped", reason: "no-usable-email" };
  }

  // Doc id last: a stray `id` field inside the document must not shadow it.
  const app: ApplicationDoc = { ...data, id: snap.id };
  const props = applicationToProperties(app);

  const existing = await getContactByEmail(email, [
    P.applicationStatus,
    P.decisionSynced,
    P.memberStatus,
  ]);

  if (!existing) {
    props[P.applicationStatus] = APPLICATION_STATUS.new;
    props[P.decisionSynced] = DECISION_SYNCED.pending;
    props[P.memberStatus] = MEMBER_STATUS.applicant;
  } else {
    // Backfill only what is genuinely absent, so a contact that pre-existed in
    // the portal still becomes reviewable without overwriting anything.
    if (!existing.properties[P.applicationStatus]) {
      props[P.applicationStatus] = APPLICATION_STATUS.new;
    }
    if (!existing.properties[P.decisionSynced]) {
      props[P.decisionSynced] = DECISION_SYNCED.pending;
    }
    if (!existing.properties[P.memberStatus]) {
      props[P.memberStatus] = MEMBER_STATUS.applicant;
    }
  }

  const contactId = await upsertContactByEmail(email, props);

  await ref.set(
    { hubspotContactId: contactId, hubspotSyncedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { status: "pushed", contactId };
}

/* ------------------------------------------------------------------ */
/* Push: approved members                                              */
/* ------------------------------------------------------------------ */

/**
 * Has this person actually turned up? The allowlist is keyed by email but
 * `profiles` deliberately stores no email (minor PII lives only in
 * privateProfiles), so the join goes through Firebase Auth: email → uid →
 * profiles/{uid}. A missing Auth user simply means "not yet".
 */
async function hasPlatformProfile(
  email: string,
  db: Firestore
): Promise<boolean> {
  try {
    const user = await adminAuth().getUserByEmail(email);
    const snap = await db.collection(PROFILES).doc(user.uid).get();
    return snap.exists;
  } catch {
    // user-not-found is the common case; an Auth outage should not fail the
    // whole push either — "no" is the safe answer for a segmentation field.
    return false;
  }
}

/**
 * Push one allowlist entry. HubSpot's member fields are a mirror of Firebase
 * truth, so these are written unconditionally — but the *decision* fields are
 * still only filled in when absent, for the same don't-clobber reason as above.
 */
export async function pushApprovedMember(
  rawEmail: string,
  db: Firestore = adminDb()
): Promise<PushResult> {
  if (!hubspotConfigured()) {
    return { status: "skipped", reason: "hubspot-not-configured" };
  }

  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) return { status: "skipped", reason: "bad-email" };

  const snap = await db.collection(APPROVED_MEMBERS).doc(email).get();
  if (!snap.exists) return { status: "skipped", reason: "not-found" };

  const data = snap.data() ?? {};
  // Normalized email last: the doc id is the truth, not a field inside it.
  const member: ApprovedMemberDoc = { ...data, email };
  const activated = await hasPlatformProfile(email, db);
  const props = approvedMemberToProperties(member, activated);

  const existing = await getContactByEmail(email, [
    P.applicationStatus,
    P.decisionSynced,
  ]);

  // An approved member IS an approval that already happened in Firebase, so
  // there is nothing for the pull direction to apply. Marking it synced up
  // front is what stops the very next reconcile from "re-approving" them.
  if (!existing?.properties[P.applicationStatus]) {
    props[P.applicationStatus] = APPLICATION_STATUS.approved;
    props[P.decisionSynced] = DECISION_SYNCED.synced;
  }

  const contactId = await upsertContactByEmail(email, props);
  return { status: "pushed", contactId };
}

/* ------------------------------------------------------------------ */
/* Pull: decisions made in HubSpot                                     */
/* ------------------------------------------------------------------ */

export interface PullSummary {
  skipped?: "hubspot-not-configured";
  approvals: number;
  declines: number;
  truncated: boolean;
  errors: SyncError[];
}

/**
 * Contacts carrying an unapplied decision.
 *
 * Two filter groups because HubSpot's NEQ does not match a property that has
 * no value at all — a contact staff created by hand, or one that pre-dates the
 * property, would be invisible to `ha_decision_synced != synced`. Groups are
 * OR'd, filters within a group are AND'd:
 *   A: status in (approved, declined) AND decision_synced = pending
 *   B: status in (approved, declined) AND decision_synced not set
 */
function decisionFilterGroups() {
  const statusFilter = {
    propertyName: P.applicationStatus,
    operator: "IN",
    values: [APPLICATION_STATUS.approved, APPLICATION_STATUS.declined],
  };
  return [
    {
      filters: [
        statusFilter,
        {
          propertyName: P.decisionSynced,
          operator: "EQ",
          value: DECISION_SYNCED.pending,
        },
      ],
    },
    {
      filters: [
        statusFilter,
        { propertyName: P.decisionSynced, operator: "NOT_HAS_PROPERTY" },
      ],
    },
  ];
}

/**
 * Find the application doc a decision belongs to, cheapest link first:
 *   1. `ha_firestore_app_id` — set by every push, so this is the normal path.
 *   2. the contact id we stamped onto the doc — exact, and immune to the fact
 *      that the form stores the email exactly as typed while the CRM key is
 *      lowercased.
 *   3. an email equality match, newest first.
 * Null is a legitimate answer: a hand-added mentor never had an application.
 */
async function findApplicationRef(
  contact: HubSpotContact,
  email: string,
  db: Firestore
) {
  const linked = contact.properties[P.firestoreAppId];
  if (linked) {
    const ref = db.collection(APPLICATIONS).doc(linked);
    if ((await ref.get()).exists) return ref;
  }

  const byContact = await db
    .collection(APPLICATIONS)
    .where("hubspotContactId", "==", contact.id)
    .limit(1)
    .get();
  if (!byContact.empty) return byContact.docs[0].ref;

  // Applications are create-only for clients, but the Admin SDK can query
  // them. Ordering by createdAt alongside the equality filter would need a
  // composite index; batch 1 has at most a couple of docs per address, so read
  // the small set and pick the newest in memory instead.
  const matches = await db
    .collection(APPLICATIONS)
    .where("email", "==", email)
    .limit(10)
    .get();
  if (matches.empty) return null;

  const newest = matches.docs.sort((a, b) => {
    const at = a.data().createdAt?.toMillis?.() ?? 0;
    const bt = b.data().createdAt?.toMillis?.() ?? 0;
    return bt - at;
  })[0];
  return newest.ref;
}

/** Display name for the allowlist entry, from HubSpot's name fields. */
function contactName(contact: HubSpotContact): string | undefined {
  const first = contact.properties.firstname?.trim() ?? "";
  const last = contact.properties.lastname?.trim() ?? "";
  const joined = `${first} ${last}`.trim();
  return joined ? joined.slice(0, 80) : undefined;
}

interface DecisionOutcome {
  kind: "approved" | "declined";
  /** Written back to the contact; empty string clears a stale warning. */
  syncNote: string;
  memberStatus: string;
  /** True only when this run created the allowlist entry (gates the email). */
  newlyApproved: boolean;
}

async function applyApproval(
  contact: HubSpotContact,
  email: string,
  db: Firestore
): Promise<DecisionOutcome> {
  const role =
    contact.properties[P.memberRole] === MEMBER_ROLE.mentor
      ? MEMBER_ROLE.mentor
      : MEMBER_ROLE.operator;
  const name = contactName(contact);
  const memberRef = db.collection(APPROVED_MEMBERS).doc(email);
  const existing = await memberRef.get();

  if (!existing.exists) {
    await memberRef.set({
      role,
      ...(name ? { name } : {}),
      addedAt: Date.now(),
      note: "Approved in HubSpot",
      source: HUBSPOT_SOURCE,
    });
  } else {
    // Merge role/name onto an entry that already exists, but do NOT stamp
    // `source: "hubspot"` onto it. That marker is what licenses a later
    // decline to delete the entry, and an entry we did not create is not ours
    // to authorise deleting.
    await memberRef.set(
      { role, ...(name ? { name } : {}) },
      { merge: true }
    );
  }

  const appRef = await findApplicationRef(contact, email, db);
  if (appRef) {
    await appRef.set(
      {
        status: "approved",
        decidedAt: FieldValue.serverTimestamp(),
        decidedVia: HUBSPOT_SOURCE,
      },
      { merge: true }
    );
  }

  return {
    kind: "approved",
    syncNote: "",
    memberStatus: MEMBER_STATUS.approvedMember,
    newlyApproved: !existing.exists,
  };
}

async function applyDecline(
  contact: HubSpotContact,
  email: string,
  db: Firestore
): Promise<DecisionOutcome> {
  const declineReason = (contact.properties[P.declineReason] ?? "").trim();

  const appRef = await findApplicationRef(contact, email, db);
  if (appRef) {
    await appRef.set(
      {
        status: "declined",
        decidedAt: FieldValue.serverTimestamp(),
        decidedVia: HUBSPOT_SOURCE,
        ...(declineReason ? { declineReason: declineReason.slice(0, 500) } : {}),
      },
      { merge: true }
    );
  }

  // THE GUARDRAIL. A decline revokes access only for an entry the CRM itself
  // created. A hand-added entry — josh@high-agency.io and every other mentor
  // Sai typed into the Console — survives, and staff is told why in HubSpot
  // rather than finding out when a mentor can't sign in.
  const memberRef = db.collection(APPROVED_MEMBERS).doc(email);
  const memberSnap = await memberRef.get();
  let syncNote = "";

  if (memberSnap.exists) {
    if (memberSnap.data()?.source === HUBSPOT_SOURCE) {
      await memberRef.delete();
    } else {
      syncNote =
        "Declined here, but the platform allowlist entry was added by hand " +
        "(not by this sync) so it was left in place. Remove it in Firebase if " +
        "access really should be revoked.";
    }
  }

  return {
    kind: "declined",
    syncNote,
    memberStatus: MEMBER_STATUS.declined,
    newlyApproved: false,
  };
}

/**
 * Apply every unapplied decision, then mark each one synced.
 *
 * Order matters: Firebase is written FIRST and the `synced` marker last. If the
 * run dies in between, the next pass re-applies the same decision — which is
 * harmless, because both directions are idempotent — whereas marking first
 * could lose a decision entirely.
 */
export async function pullDecisions(
  db: Firestore = adminDb()
): Promise<PullSummary> {
  if (!hubspotConfigured()) {
    return {
      skipped: "hubspot-not-configured",
      approvals: 0,
      declines: 0,
      truncated: false,
      errors: [],
    };
  }

  const { contacts, truncated } = await searchAllContacts({
    filterGroups: decisionFilterGroups(),
    properties: DECISION_READ_PROPERTIES,
  });

  const errors: SyncError[] = [];
  let approvals = 0;
  let declines = 0;

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://high-agency.io").replace(
    /\/$/,
    ""
  );

  for (const contact of contacts) {
    // Contact id only — never the email — in anything that gets logged.
    const ref = `contact:${contact.id}`;
    try {
      const email = normalizeEmail(contact.properties.email);
      if (!isValidEmail(email)) {
        errors.push({ stage: "pull-decision", ref, message: "unusable email" });
        await markSynced(contact.id, email || null, {
          syncNote:
            "This contact has no usable email address, so the decision could " +
            "not be applied to the platform.",
        });
        continue;
      }

      const decision = contact.properties[P.applicationStatus];
      const outcome =
        decision === APPLICATION_STATUS.approved
          ? await applyApproval(contact, email, db)
          : await applyDecline(contact, email, db);

      if (outcome.kind === "approved") approvals++;
      else declines++;

      await markSynced(contact.id, email, {
        memberStatus: outcome.memberStatus,
        syncNote: outcome.syncNote,
      });

      if (outcome.kind === "approved" && outcome.newlyApproved) {
        try {
          await sendApprovalEmail({
            to: email,
            firstName: nameParts(contactName(contact)).firstName,
            appUrl,
          });
        } catch (err) {
          // A mail failure must never un-approve someone.
          errors.push({
            stage: "approval-email",
            ref,
            message: reason(err),
          });
        }
      }
    } catch (err) {
      errors.push({ stage: "pull-decision", ref, message: reason(err) });
    }
  }

  return { approvals, declines, truncated, errors };
}

/**
 * Write the bookkeeping back to the contact. Addressed by email where we have
 * one (the same key everything else uses); by object id otherwise.
 */
async function markSynced(
  contactId: string,
  email: string | null,
  fields: { memberStatus?: string; syncNote?: string }
): Promise<void> {
  const props: PropertyBag = {
    [P.decisionSynced]: DECISION_SYNCED.synced,
    [P.decidedAt]: new Date().toISOString().slice(0, 10),
    // Always written, so a warning from a previous run is cleared once the
    // situation is resolved rather than haunting the record.
    [P.syncNote]: fields.syncNote ?? "",
  };
  if (fields.memberStatus) props[P.memberStatus] = fields.memberStatus;

  if (email) {
    await upsertContactByEmail(email, props);
    return;
  }
  // No email to key on: patch by object id directly. This is the only place
  // that addresses a contact by id — email is the key everywhere else.
  await patchContactById(contactId, props);
}

/* ------------------------------------------------------------------ */
/* Reconcile                                                           */
/* ------------------------------------------------------------------ */

/**
 * One full pass in both directions. Safe to run repeatedly and safe to run
 * concurrently with itself — every write is an idempotent set/merge keyed by a
 * stable id.
 *
 * A single failing record never aborts the run: it lands in `errors` and the
 * pass continues, because one malformed legacy doc must not stop 50 good ones
 * from reaching the CRM.
 */
export async function reconcile(
  db: Firestore = adminDb()
): Promise<ReconcileSummary> {
  const summary = emptySummary();
  if (!hubspotConfigured()) {
    return { ...summary, skipped: "hubspot-not-configured" };
  }

  // 1. Applications that have never been pushed.
  try {
    const snap = await db
      .collection(APPLICATIONS)
      .orderBy("createdAt", "desc")
      .limit(RECONCILE_SCAN_LIMIT)
      .get();
    if (snap.size === RECONCILE_SCAN_LIMIT) summary.truncated = true;

    for (const doc of snap.docs) {
      if (doc.data().hubspotSyncedAt) continue;
      try {
        const res = await pushApplication(doc.id, db);
        if (res.status === "pushed") summary.pushedApplications++;
      } catch (err) {
        summary.errors.push({
          stage: "push-application",
          ref: doc.id,
          message: reason(err),
        });
      }
    }
  } catch (err) {
    summary.errors.push({
      stage: "scan-applications",
      ref: APPLICATIONS,
      message: reason(err),
    });
  }

  // 2. Every allowlist entry — cheap, and it keeps `ha_platform_activated`
  //    honest as people sign in over the course of the batch.
  try {
    const snap = await db
      .collection(APPROVED_MEMBERS)
      .limit(RECONCILE_SCAN_LIMIT)
      .get();
    if (snap.size === RECONCILE_SCAN_LIMIT) summary.truncated = true;

    for (const doc of snap.docs) {
      try {
        const res = await pushApprovedMember(doc.id, db);
        if (res.status === "pushed") summary.pushedMembers++;
      } catch (err) {
        summary.errors.push({
          stage: "push-member",
          // Doc ids in this collection ARE emails, so never echo them.
          ref: "approvedMember",
          message: reason(err),
        });
      }
    }
  } catch (err) {
    summary.errors.push({
      stage: "scan-members",
      ref: APPROVED_MEMBERS,
      message: reason(err),
    });
  }

  // 3. Decisions staff made in HubSpot since the last pass.
  try {
    const pull = await pullDecisions(db);
    summary.approvals = pull.approvals;
    summary.declines = pull.declines;
    summary.truncated = summary.truncated || pull.truncated;
    summary.errors.push(...pull.errors);
  } catch (err) {
    summary.errors.push({
      stage: "pull-decisions",
      ref: "search",
      message: reason(err),
    });
  }

  return summary;
}
