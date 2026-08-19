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
import {
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
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
  referralCountProperties,
  referralSourceFor,
  type ApplicationDoc,
  type ApprovedMemberDoc,
  type PropertyBag,
  type ReferralFacts,
} from "./hubspotMapping";
import {
  APPLICATION_STATUS,
  DECISION_SYNCED,
  DECISION_READ_PROPERTIES,
  MEMBER_ROLE,
  MEMBER_STATUS,
  P,
  REFERRAL_SOURCE,
} from "./hubspotSchema";
import {
  REFERRALS_COLLECTION,
  STAFF_COUNTER_KIND,
  normalizeReferralCode,
} from "./referral";
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

/**
 * How many APPLICATIONS a standalone referral-count refresh considers. When the
 * refresh runs as part of reconcile it is handed that pass's application page
 * instead, so the whole run shares one bound.
 */
export const REFERRAL_REFRESH_LIMIT = 200;

/**
 * Hard ceiling on HubSpot writes in one refresh pass, so a first run after the
 * property is added cannot turn into an unbounded burst of API calls. Hitting
 * it sets `truncated`; the next pass picks up where this one stopped, because
 * everything written becomes `unchanged` and is skipped.
 */
export const REFERRAL_REFRESH_MAX_WRITES = 50;

/** Documents per batched `getAll`. Firestore handles far more, but a bounded
 *  chunk keeps one round trip predictable in size. */
const REFERRAL_READ_CHUNK = 100;

/**
 * Field on the application document mirroring the `confirmed` count we last
 * wrote to HubSpot. It is the change detector: a refresh pass that finds it
 * already equal to the live counter makes NO HubSpot call at all, which is what
 * keeps a five-minute cron from being N writes every five minutes.
 */
export const REFERRAL_MIRROR_FIELD = "hubspotReferralConfirmed";

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
  /** Contacts whose referral count actually MOVED this pass. Zero is the
   *  normal, healthy reading — see refreshReferralCounts. */
  refreshedReferrals: number;
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
    refreshedReferrals: 0,
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
 * The two referral facts an application document cannot answer on its own:
 * what KIND of link brought this person in, and how many people their own link
 * has brought in so far.
 *
 * Costs at most two document reads, both by id, both against the public
 * PII-free counters. It runs once per application push — never inside the
 * signup transaction, which stays HubSpot-free and Firestore-only.
 *
 * An application with no `referredBy` FIELD (the three legacy records, and the
 * referral-free fallback write) reports no source at all rather than `direct`:
 * "arrived before referrals existed" is not the same claim as "arrived cold",
 * and a segment built on the wrong one is worse than a blank.
 */
export async function resolveReferralFacts(
  app: ApplicationDoc,
  db: Firestore = adminDb()
): Promise<ReferralFacts> {
  const facts: ReferralFacts = {};
  const counters = db.collection(REFERRALS_COLLECTION);

  try {
    if (typeof app.referredBy === "string") {
      const incoming = normalizeReferralCode(app.referredBy);
      if (!incoming) {
        facts.source = REFERRAL_SOURCE.direct;
      } else {
        const snap = await counters.doc(incoming).get();
        facts.source = referralSourceFor(
          incoming,
          snap.exists ? (snap.data() ?? null) : null
        );
      }
    }

    const own = normalizeReferralCode(app.referralCode);
    if (own) {
      const snap = await counters.doc(own).get();
      const confirmed = snap.exists ? snap.data()?.confirmed : undefined;
      if (typeof confirmed === "number" && Number.isFinite(confirmed)) {
        facts.confirmed = confirmed;
      }
    }
  } catch {
    // Attribution is analytics. Losing it must never stop an applicant from
    // reaching the CRM, so a read failure degrades to "no facts".
    return facts;
  }

  return facts;
}

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
  const referral = await resolveReferralFacts(app, db);
  const props = applicationToProperties(app, referral);

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
    {
      hubspotContactId: contactId,
      hubspotSyncedAt: FieldValue.serverTimestamp(),
      // Seed the change detector with whatever this push just wrote, so the
      // next refresh pass has something to compare against instead of
      // re-pushing a number HubSpot already has.
      ...(referral.confirmed !== undefined
        ? { [REFERRAL_MIRROR_FIELD]: referral.confirmed }
        : {}),
    },
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
/* Refresh: referral counts                                            */
/* ------------------------------------------------------------------ */

export interface ReferralRefreshSummary {
  skipped?: "hubspot-not-configured";
  /** Contacts actually patched. */
  refreshed: number;
  /** Counters looked at and found unchanged — no HubSpot call made. */
  unchanged: number;
  truncated: boolean;
  errors: SyncError[];
}

/**
 * Keep `ha_referral_confirmed` current, cheaply — and drive it from the
 * AUTHORITATIVE side.
 *
 * An application is pushed to HubSpot exactly once, at signup, when its own
 * referral count is necessarily zero. Without this pass the property would read
 * 0 forever and be worse than useless. But a naive "re-push everyone on every
 * tick" is dozens of HubSpot writes every five minutes for a number that
 * changes a handful of times a week.
 *
 * The candidate set is the load-bearing decision. It comes from `applications`,
 * NOT from `referrals`:
 *
 *   `referrals` is a PUBLIC, unauthenticated-writable collection — the waitlist
 *   has to be able to mint and credit counters for signed-out visitors. So
 *   anyone can create counters with `confirmed > 0`. A bounded query over that
 *   collection (`where confirmed > 0` + `limit`) applies its limit BEFORE any
 *   ownership filtering, and Firestore's ordering is stable, so a cheap flood
 *   of ownerless counters would occupy the first page forever and real
 *   applicants' counts would never be refreshed again. That is starvation by
 *   anyone with a browser, and no cursor fixes it — the flood outnumbers the
 *   real rows on every page.
 *
 *   Applications are create-only, carry the applicant's own minted code, and
 *   are stamped with `hubspotContactId` by the Admin SDK. Driving from them
 *   means an ownerless counter is never even a candidate: it has no application
 *   pointing at it, so it is never read and never considered.
 *
 * The rest is unchanged and still cheap:
 *
 *   1. Take the applications that have a code AND have been pushed. Counters
 *      are then read BY ID, batched — never queried, so nothing a stranger
 *      writes can affect which ones we look at.
 *   2. Compare against REFERRAL_MIRROR_FIELD — what we last told HubSpot. Equal
 *      means no API call at all. This is the change detection that makes the
 *      five-minute cadence safe.
 *   3. Only then patch the contact, and record the new value in the same shape
 *      so the next pass sees it as unchanged. Bounded by
 *      REFERRAL_REFRESH_MAX_WRITES per pass.
 *
 * Staff counters are skipped: they are nobody's application, so they never
 * appear as candidates, and the one that could (a staff code someone also typed
 * onto an application) is filtered by `kind`. Staff totals are answerable in
 * HubSpot by filtering contacts on `ha_referred_by` = the staff code, which is
 * a better number anyway — it is the list of people, not just the count.
 *
 * Idempotent, and safe to run concurrently with itself: every write is a
 * value-equality-guarded upsert keyed on a stable id.
 */
export async function refreshReferralCounts(
  db: Firestore = adminDb(),
  /**
   * The application page reconcile has already read. Passing it makes the
   * refresh cost zero extra application reads and share one bound with the rest
   * of the run. Omitted (tests, direct calls) it reads its own bounded page.
   */
  applications?: QueryDocumentSnapshot[]
): Promise<ReferralRefreshSummary> {
  if (!hubspotConfigured()) {
    return {
      skipped: "hubspot-not-configured",
      refreshed: 0,
      unchanged: 0,
      truncated: false,
      errors: [],
    };
  }

  const errors: SyncError[] = [];
  let refreshed = 0;
  let unchanged = 0;
  let truncated = false;

  let candidates = applications;
  if (!candidates) {
    const snap = await db
      .collection(APPLICATIONS)
      .orderBy("createdAt", "desc")
      .limit(REFERRAL_REFRESH_LIMIT)
      .get();
    candidates = snap.docs;
    truncated = snap.size === REFERRAL_REFRESH_LIMIT;
  }

  // Newest first (the order both callers supply), so the applicants most likely
  // to be accruing referrals right now are the ones inside the bound.
  const owners = new Map<string, QueryDocumentSnapshot>();
  for (const doc of candidates) {
    const data = doc.data();
    const code = normalizeReferralCode(data.referralCode);
    // No code, or never pushed: nothing to refresh. A contact that does not
    // exist must not be conjured by a patch — the push carries the count.
    if (!code || !data.hubspotContactId) continue;
    if (!owners.has(code)) owners.set(code, doc);
  }
  if (owners.size === 0) return { refreshed, unchanged, truncated, errors };

  // Read the counters BY ID, batched. getAll takes a bounded list built above,
  // so this is one round trip per chunk and reads nothing we did not ask for.
  const codes = [...owners.keys()];
  const counters = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  for (let i = 0; i < codes.length; i += REFERRAL_READ_CHUNK) {
    const chunk = codes.slice(i, i + REFERRAL_READ_CHUNK);
    const snaps = await db.getAll(
      ...chunk.map((code) => db.collection(REFERRALS_COLLECTION).doc(code))
    );
    snaps.forEach((snap, n) => counters.set(chunk[n], snap));
  }

  for (const [code, appDoc] of owners) {
    // The code is a document id and carries no PII — safe to name in an error.
    const ref = `referral:${code}`;
    try {
      const snap = counters.get(code);
      if (!snap?.exists) continue;
      const data = snap.data() ?? {};

      // A staff code cannot be an applicant's own code; if one is sitting in
      // that field the record is wrong, and refreshing off it would report a
      // staff lead count as somebody's personal referral total.
      if (data.kind === STAFF_COUNTER_KIND) continue;

      const confirmed = data.confirmed;
      if (typeof confirmed !== "number" || !Number.isFinite(confirmed)) continue;

      const appData = appDoc.data();
      if (appData[REFERRAL_MIRROR_FIELD] === confirmed) {
        unchanged++;
        continue;
      }

      const email = hubspotEmail(appData.email);
      if (!email || !isValidEmail(email)) continue;

      if (refreshed >= REFERRAL_REFRESH_MAX_WRITES) {
        // Stop calling HubSpot, but say so. Next pass resumes here, because
        // everything already written now compares equal.
        truncated = true;
        break;
      }

      await upsertContactByEmail(email, referralCountProperties(confirmed));
      await appDoc.ref.set({ [REFERRAL_MIRROR_FIELD]: confirmed }, { merge: true });
      refreshed++;
    } catch (err) {
      errors.push({ stage: "refresh-referral", ref, message: reason(err) });
    }
  }

  return { refreshed, unchanged, truncated, errors };
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

  // 1. Applications that have never been pushed. The page is kept: step 4
  //    refreshes referral counts off exactly these authoritative records, so
  //    the whole run shares one bound and costs one application read.
  let applicationPage: QueryDocumentSnapshot[] = [];
  try {
    const snap = await db
      .collection(APPLICATIONS)
      .orderBy("createdAt", "desc")
      .limit(RECONCILE_SCAN_LIMIT)
      .get();
    if (snap.size === RECONCILE_SCAN_LIMIT) summary.truncated = true;
    applicationPage = snap.docs;

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

  // 4. Referral counts that moved since the last pass. Usually a no-op, and
  //    deliberately last: it is the least important thing in the run, and it
  //    must never be the reason a decision did not get applied.
  try {
    // The page is deliberately the one read at the top of this run, NOT a
    // re-read. An application step 1 just pushed carries no hubspotContactId in
    // this snapshot, so it is skipped here — which is right: that push already
    // wrote the current count. Everything else was stamped by an earlier run
    // and is accurate. Re-reading to catch the first case would cost a second
    // full page of reads every five minutes to save one redundant write.
    const refresh = await refreshReferralCounts(db, applicationPage);
    summary.refreshedReferrals = refresh.refreshed;
    summary.truncated = summary.truncated || refresh.truncated;
    summary.errors.push(...refresh.errors);
  } catch (err) {
    summary.errors.push({
      stage: "refresh-referrals",
      ref: REFERRALS_COLLECTION,
      message: reason(err),
    });
  }

  return summary;
}
