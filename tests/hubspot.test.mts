/**
 * HubSpot integration tests. Run with:
 *
 *   npm run test:hubspot
 *
 * (wraps `tsx --test` in `firebase emulators:exec --only firestore`, same as the
 * consent and mentor-invite suites).
 *
 * Two halves:
 *
 * 1. The pure mapping layer (app/lib/hubspotMapping.ts) — no I/O at all. The
 *    load-bearing claim is that the three real applications already on record,
 *    which predate the form expansion and have NO social/impact/problem/plan
 *    fields, map to a property bag that simply omits them instead of writing
 *    the string "undefined" onto a real person's CRM record.
 *
 * 2. The decline guardrail in pullDecisions() — exercised through the real code
 *    path against the Firestore emulator, with the HubSpot HTTP layer mocked.
 *    NOTHING here touches the real HubSpot API. The claim being proved is the
 *    one that protects humans: a decline in the CRM removes an allowlist entry
 *    the CRM itself created, and REFUSES to remove one a person added by hand
 *    (josh@high-agency.io and every other mentor), telling staff why instead.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

// Must look configured before any sync entry point runs. hubspotConfigured()
// reads the env at call time, so this is enough — and the fetch mock below
// means the token is never sent anywhere.
process.env.HUBSPOT_ACCESS_TOKEN = "test-token-not-a-real-pat";
// Approval mail stays off (the default) so no test can send anything.
delete process.env.HUBSPOT_APPROVAL_EMAIL;
delete process.env.RESEND_API_KEY;

import { adminDb } from "../app/lib/firebaseAdmin.ts";
import { hubspotBaseUrl } from "../app/lib/hubspot.ts";
import {
  applicationToProperties,
  approvedMemberToProperties,
  nameParts,
  referralCountProperties,
  referralSourceFor,
  toDateProperty,
} from "../app/lib/hubspotMapping.ts";
import {
  APPLICATIONS,
  HUBSPOT_SOURCE,
  REFERRAL_MIRROR_FIELD,
  REFERRAL_REFRESH_LIMIT,
  REFERRAL_REFRESH_MAX_WRITES,
  pullDecisions,
  pushApplication,
  refreshReferralCounts,
  resolveReferralFacts,
} from "../app/lib/hubspotSync.ts";
import { APPROVED_MEMBERS } from "../app/lib/accessGate.ts";
import {
  APPLICATION_STATUS,
  DECISION_SYNCED,
  MEMBER_ROLE,
  MEMBER_STATUS,
  P,
  REFERRAL_SOURCE,
  YES_NO,
} from "../app/lib/hubspotSchema.ts";
import {
  REFERRALS_COLLECTION,
  staffCounterFields,
} from "../app/lib/referral.ts";
import { marketingConsentState } from "../app/lib/marketingConsent.ts";
import { MARKETING_CONSENT_SOURCE } from "../app/lib/marketingConsent.ts";

const db = adminDb();

/* ------------------------------------------------------------------ */
/* Part 1 — pure mapping                                              */
/* ------------------------------------------------------------------ */

test("nameParts splits on the LAST space", () => {
  assert.deepEqual(nameParts("Ada Lovelace"), {
    firstName: "Ada",
    lastName: "Lovelace",
  });
  assert.deepEqual(nameParts("Ada King Lovelace"), {
    firstName: "Ada King",
    lastName: "Lovelace",
  });
});

test("nameParts puts a single-token name entirely in firstName", () => {
  // Guessing a surname out of one word is worse than leaving it blank, and
  // firstname is what email personalisation tokens read.
  assert.deepEqual(nameParts("Prince"), { firstName: "Prince" });
  assert.deepEqual(nameParts("  Prince  "), { firstName: "Prince" });
});

test("nameParts handles absent and non-string input", () => {
  assert.deepEqual(nameParts(undefined), {});
  assert.deepEqual(nameParts(""), {});
  assert.deepEqual(nameParts("   "), {});
  assert.deepEqual(nameParts(42), {});
});

test("nameParts collapses runs of whitespace", () => {
  assert.deepEqual(nameParts("Ada\n  Lovelace"), {
    firstName: "Ada",
    lastName: "Lovelace",
  });
});

test("a full application maps every field", () => {
  const props = applicationToProperties({
    id: "app123",
    name: "Ada Lovelace",
    email: "  Ada@Example.COM ",
    age: "16",
    social: "@adabuilds",
    building: "A notation engine",
    boldest: "Cold-emailed 40 professors",
    impact: "Make computation legible",
    problem: "Nobody can read machines",
    plan: "Ship the engine and find 10 users",
    opId: "HA-051",
    queuePos: 51,
    createdAt: Timestamp.fromMillis(Date.UTC(2026, 6, 15, 9, 30)),
  });

  // Email is normalized: it is the dedupe key on both sides.
  assert.equal(props.email, "ada@example.com");
  assert.equal(props.firstname, "Ada");
  assert.equal(props.lastname, "Lovelace");
  assert.equal(props[P.operatorId], "HA-051");
  assert.equal(props[P.queuePosition], "51");
  // Age arrives as a string from the form and must land as a number property.
  assert.equal(props[P.age], "16");
  assert.equal(props[P.social], "@adabuilds");
  assert.equal(props[P.plan], "Ship the engine and find 10 users");
  assert.equal(props[P.appliedAt], "2026-07-15");
  assert.equal(props[P.firestoreAppId], "app123");
  // The mapping never decides a status — that is the sync engine's call, so a
  // re-push can't walk back a decision a human made in the CRM.
  assert.equal(props[P.applicationStatus], undefined);
  assert.equal(props[P.decisionSynced], undefined);
});

test("a LEGACY application omits the fields it never had", () => {
  // Exactly the shape of HA-049/050/051: no social, impact, problem or plan.
  const props = applicationToProperties({
    id: "legacy1",
    name: "Grace Hopper",
    email: "grace@example.com",
    age: "17",
    building: "A compiler",
    boldest: "Shipped it anyway",
    opId: "HA-049",
    queuePos: 49,
    createdAt: Timestamp.fromMillis(Date.UTC(2026, 5, 1)),
  });

  for (const key of [P.social, P.impact, P.problem, P.plan]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(props, key),
      false,
      `${key} must be absent, not present-and-empty`
    );
  }
  // And nothing anywhere in the bag may be the literal string "undefined".
  for (const [key, value] of Object.entries(props)) {
    assert.notEqual(value, "undefined", `${key} stringified an undefined`);
    assert.equal(typeof value, "string");
  }
  // The fields it does have still map.
  assert.equal(props[P.building], "A compiler");
  assert.equal(props[P.operatorId], "HA-049");
});

test("empty-string answers are omitted, not written as blanks", () => {
  // `social` is stored as "" when the applicant skips it.
  const props = applicationToProperties({
    id: "app2",
    name: "Ada Lovelace",
    email: "ada@example.com",
    social: "",
    building: "   ",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(props, P.social), false);
  assert.equal(Object.prototype.hasOwnProperty.call(props, P.building), false);
});

test("an unusable value is dropped rather than coerced to a lie", () => {
  const props = applicationToProperties({
    id: "app3",
    email: "x@example.com",
    age: "not a number",
    queuePos: "oops",
    createdAt: { nope: true },
  });
  assert.equal(props[P.age], undefined);
  assert.equal(props[P.queuePosition], undefined);
  assert.equal(props[P.appliedAt], undefined);
});

test("long answers are truncated in exactly one place", () => {
  const props = applicationToProperties({
    id: "app4",
    email: "x@example.com",
    building: "a".repeat(40_000),
  });
  assert.equal(props[P.building]!.length, 32_000);
});

test("toDateProperty accepts a Timestamp, epoch ms, a Date and an ISO string", () => {
  const ms = Date.UTC(2026, 0, 2, 12, 0, 0);
  assert.equal(toDateProperty(Timestamp.fromMillis(ms)), "2026-01-02");
  assert.equal(toDateProperty(ms), "2026-01-02");
  assert.equal(toDateProperty(new Date(ms)), "2026-01-02");
  assert.equal(toDateProperty("2026-01-02T12:00:00.000Z"), "2026-01-02");
  assert.equal(toDateProperty(undefined), undefined);
  assert.equal(toDateProperty("not a date"), undefined);
});

test("an approved member maps role, activation and decision date", () => {
  // addedAt is epoch ms on script-created docs...
  const operator = approvedMemberToProperties(
    { email: "ada@example.com", role: "operator", name: "Ada Lovelace", addedAt: Date.UTC(2026, 6, 1) },
    false
  );
  assert.equal(operator[P.memberRole], MEMBER_ROLE.operator);
  assert.equal(operator[P.memberStatus], MEMBER_STATUS.approvedMember);
  assert.equal(operator[P.platformActivated], YES_NO.no);
  assert.equal(operator[P.decidedAt], "2026-07-01");
  assert.equal(operator.firstname, "Ada");

  // ...and a Timestamp on some hand-created ones. Both must work.
  const mentor = approvedMemberToProperties(
    {
      email: "josh@high-agency.io",
      role: "mentor",
      name: "Josh N.",
      addedAt: Timestamp.fromMillis(Date.UTC(2026, 6, 2)),
    },
    true
  );
  assert.equal(mentor[P.memberRole], MEMBER_ROLE.mentor);
  // Activated wins: a signed-in member is more than an approved one.
  assert.equal(mentor[P.memberStatus], MEMBER_STATUS.activeOperator);
  assert.equal(mentor[P.platformActivated], YES_NO.yes);
  assert.equal(mentor[P.decidedAt], "2026-07-02");
});

test("an unknown or missing role defaults to operator", () => {
  const missing = approvedMemberToProperties({ email: "a@example.com" }, false);
  assert.equal(missing[P.memberRole], MEMBER_ROLE.operator);
  const junk = approvedMemberToProperties(
    { email: "a@example.com", role: "admin" },
    false
  );
  assert.equal(junk[P.memberRole], MEMBER_ROLE.operator);
});

test("an allowlist note never overwrites ha_sync_note", () => {
  // ha_sync_note is how the sync warns a human; a staff note must not clobber
  // a live warning.
  const props = approvedMemberToProperties(
    { email: "a@example.com", role: "operator", note: "friend of Josh" },
    false
  );
  assert.equal(props[P.syncNote], undefined);
});

/* ------------------------------------------------------------------ */
/* Referral attribution + marketing consent (still pure)               */
/* ------------------------------------------------------------------ */

test("an application maps its referral attribution and its consent", () => {
  const props = applicationToProperties(
    {
      id: "app5",
      email: "ada@example.com",
      referralCode: "K7M2QX",
      referredBy: "PQR3WY",
      marketingConsent: true,
      marketingConsentAt: Timestamp.fromMillis(Date.UTC(2026, 7, 18, 10, 0)),
      marketingConsentSource: MARKETING_CONSENT_SOURCE,
    },
    { source: REFERRAL_SOURCE.staff, confirmed: 4 }
  );

  assert.equal(props[P.referralCode], "K7M2QX");
  assert.equal(props[P.referredBy], "PQR3WY");
  assert.equal(props[P.referralSource], REFERRAL_SOURCE.staff);
  assert.equal(props[P.referralConfirmed], "4");
  assert.equal(props[P.marketingConsent], YES_NO.yes);
  assert.equal(props[P.marketingConsentAt], "2026-08-18");
  assert.equal(props[P.marketingConsentSource], MARKETING_CONSENT_SOURCE);

  // Still no status anywhere: adding fields must not have added a way for a
  // re-push to reset a decision a human made.
  assert.equal(props[P.applicationStatus], undefined);
  assert.equal(props[P.decisionSynced], undefined);
  assert.equal(props[P.memberStatus], undefined);
});

test("arriving cold is recorded as an empty referrer, not as an absent one", () => {
  const props = applicationToProperties(
    { id: "app6", email: "a@example.com", referralCode: "K7M2QX", referredBy: "" },
    { source: REFERRAL_SOURCE.direct }
  );
  // "" is a fact — nobody referred them. An ABSENT field would mean the
  // application predates referrals, which is a different claim.
  assert.equal(props[P.referredBy], "");
  assert.equal(props[P.referralSource], REFERRAL_SOURCE.direct);
  // No count was resolved, so none is written — 0 would be a guess.
  assert.equal(
    Object.prototype.hasOwnProperty.call(props, P.referralConfirmed),
    false
  );
});

test("a legacy application gets no referral or consent properties at all", () => {
  const props = applicationToProperties({
    id: "legacy2",
    name: "Grace Hopper",
    email: "grace@example.com",
    building: "A compiler",
  });
  for (const key of [
    P.referralCode,
    P.referredBy,
    P.referralSource,
    P.referralConfirmed,
    P.marketingConsent,
    P.marketingConsentAt,
    P.marketingConsentSource,
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(props, key),
      false,
      `${key} must be absent on a document that never had it`
    );
  }
});

test("a declined consent is a 'no' with no timestamp behind it", () => {
  const props = applicationToProperties({
    id: "app7",
    email: "a@example.com",
    marketingConsent: false,
    // A timestamp on a declined consent is malformed data the rules refuse,
    // but the mapping must not launder it into the CRM either.
    marketingConsentAt: Timestamp.fromMillis(Date.UTC(2026, 7, 18)),
    marketingConsentSource: MARKETING_CONSENT_SOURCE,
  });
  assert.equal(props[P.marketingConsent], YES_NO.no);
  assert.equal(
    Object.prototype.hasOwnProperty.call(props, P.marketingConsentAt),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(props, P.marketingConsentSource),
    false
  );
});

test("consent FAILS CLOSED — no proof, no Yes, in every broken shape", () => {
  const at = Timestamp.fromMillis(Date.UTC(2026, 7, 18));
  const broken: Array<[string, Record<string, unknown>]> = [
    ["no timestamp", { marketingConsent: true, marketingConsentSource: MARKETING_CONSENT_SOURCE }],
    ["no source", { marketingConsent: true, marketingConsentAt: at }],
    ["wrong source", { marketingConsent: true, marketingConsentAt: at, marketingConsentSource: "partner-import" }],
    ["source cased differently", { marketingConsent: true, marketingConsentAt: at, marketingConsentSource: "Waitlist" }],
    ["unreadable timestamp", { marketingConsent: true, marketingConsentAt: { nope: true }, marketingConsentSource: MARKETING_CONSENT_SOURCE }],
    ["no proof at all", { marketingConsent: true }],
  ];

  for (const [label, fields] of broken) {
    const props = applicationToProperties({ id: "x", email: "a@example.com", ...fields });
    // The one thing that must never happen: a Yes we cannot back up.
    assert.notEqual(props[P.marketingConsent], YES_NO.yes, label);
    // And it is omitted rather than downgraded to a "No" they never said.
    for (const key of [P.marketingConsent, P.marketingConsentAt, P.marketingConsentSource]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(props, key),
        false,
        `${label}: ${key} should be omitted`
      );
    }
  }
});

test("a complete opt-in still maps to Yes with both proofs", () => {
  const props = applicationToProperties({
    id: "x",
    email: "a@example.com",
    marketingConsent: true,
    marketingConsentAt: Timestamp.fromMillis(Date.UTC(2026, 7, 18, 10, 0)),
    marketingConsentSource: MARKETING_CONSENT_SOURCE,
  });
  assert.equal(props[P.marketingConsent], YES_NO.yes);
  assert.equal(props[P.marketingConsentAt], "2026-08-18");
  assert.equal(props[P.marketingConsentSource], MARKETING_CONSENT_SOURCE);
});

test("marketingConsentState keeps 'never asked' and 'declined' apart", () => {
  assert.equal(marketingConsentState(undefined, undefined, undefined), "unknown");
  assert.equal(marketingConsentState("yes", MARKETING_CONSENT_SOURCE, "2026-08-18"), "unknown");
  assert.equal(marketingConsentState(false, undefined, undefined), "declined");
  // A declined record carrying proof is still just declined — never granted.
  assert.equal(marketingConsentState(false, MARKETING_CONSENT_SOURCE, "2026-08-18"), "declined");
  assert.equal(marketingConsentState(true, MARKETING_CONSENT_SOURCE, "2026-08-18"), "granted");
});

test("a malformed referral code never reaches a property staff filters on", () => {
  const props = applicationToProperties({
    id: "app8",
    email: "a@example.com",
    referralCode: "nope",
    referredBy: "k7m2qx  ",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(props, P.referralCode),
    false
  );
  // Lowercase is a real link people retype — it normalizes rather than drops.
  assert.equal(props[P.referredBy], "K7M2QX");
});

test("referralSourceFor separates a staff link from an applicant's from neither", () => {
  assert.equal(referralSourceFor("", null), REFERRAL_SOURCE.direct);
  assert.equal(
    referralSourceFor("K7M2QX", { kind: "staff" }),
    REFERRAL_SOURCE.staff
  );
  assert.equal(referralSourceFor("K7M2QX", {}), REFERRAL_SOURCE.applicant);
  // A code that resolves to nothing is not a referrer — the write path does not
  // credit one either, so reporting `applicant` would be inventing a person.
  assert.equal(referralSourceFor("K7M2QX", null), REFERRAL_SOURCE.direct);
  assert.equal(referralSourceFor("nope", null), REFERRAL_SOURCE.direct);
});

test("the referral-count refresh writes ONLY the count", () => {
  assert.deepEqual(referralCountProperties(3), { [P.referralConfirmed]: "3" });
});

/* ------------------------------------------------------------------ */
/* Part 2 — pullDecisions against the emulator, HubSpot mocked         */
/* ------------------------------------------------------------------ */

interface MockContact {
  id: string;
  properties: Record<string, string>;
}

interface RecordedPatch {
  /** Email or object id the patch was addressed to. */
  target: string;
  properties: Record<string, string>;
}

const realFetch = globalThis.fetch;
let searchResults: MockContact[] = [];
let patches: RecordedPatch[] = [];
/** Every HubSpot request the code made, so a test can assert on ZERO of them. */
let hubspotCalls: string[] = [];
/** Contacts GET-by-email should find. Anything else 404s, which is what makes
 *  a fresh applicant land on the "create" branch of the upsert. */
let existingContacts: Record<string, MockContact> = {};

/**
 * Stand in for the HubSpot API only — anything else (the Firestore emulator does
 * not use fetch, but be safe) goes to the real implementation. Asserts the
 * Authorization header is present so a regression that drops auth is visible.
 *
 * The base URL comes from the client, so this also proves the client and the
 * mock cannot disagree about where requests go.
 */
function installFetchMock() {
  const base = hubspotBaseUrl();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(base)) {
      return realFetch(input as string, init);
    }

    const auth = new Headers(init?.headers).get("authorization");
    assert.equal(auth, "Bearer test-token-not-a-real-pat");

    const path = url.slice(base.length);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    hubspotCalls.push(`${init?.method ?? "GET"} ${path}`);

    if (path.startsWith("/crm/v3/objects/contacts/search")) {
      return Response.json({
        total: searchResults.length,
        results: searchResults,
      });
    }

    if ((init?.method ?? "GET") === "GET") {
      const [, rawTarget = ""] = path.match(/\/crm\/v3\/objects\/contacts\/([^?]+)/) ?? [];
      const target = decodeURIComponent(rawTarget);
      const found = existingContacts[target];
      return found
        ? Response.json(found)
        : new Response("{}", { status: 404 });
    }

    if (init?.method === "PATCH") {
      // /crm/v3/objects/contacts/<email-or-id>?idProperty=email
      const [, rawTarget = ""] = path.match(/\/crm\/v3\/objects\/contacts\/([^?]+)/) ?? [];
      const target = decodeURIComponent(rawTarget);
      patches.push({ target, properties: body.properties ?? {} });
      return Response.json({ id: `contact-for-${target}` });
    }

    throw new Error(`unexpected HubSpot call in test: ${init?.method} ${path}`);
  }) as typeof fetch;
}

function patchFor(target: string): RecordedPatch | undefined {
  return patches.find((p) => p.target === target);
}

async function clearAll() {
  for (const col of [APPLICATIONS, APPROVED_MEMBERS, REFERRALS_COLLECTION]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  searchResults = [];
  patches = [];
  hubspotCalls = [];
  existingContacts = {};
  installFetchMock();
  await clearAll();
});

after(async () => {
  globalThis.fetch = realFetch;
  await clearAll();
});

/** A contact carrying an unapplied decision, as the search would return it. */
function decidedContact(
  overrides: Partial<Record<string, string>> & { email: string },
  id = "1001"
): MockContact {
  return {
    id,
    properties: {
      [P.decisionSynced]: DECISION_SYNCED.pending,
      ...overrides,
    } as Record<string, string>,
  };
}

test("an approval writes the allowlist entry and marks it hubspot-sourced", async () => {
  const appRef = await db.collection(APPLICATIONS).add({
    name: "Ada Lovelace",
    email: "ada@example.com",
    age: "16",
    building: "A notation engine",
    boldest: "Cold-emailed 40 professors",
    createdAt: Timestamp.now(),
  });

  searchResults = [
    decidedContact({
      email: "ada@example.com",
      firstname: "Ada",
      lastname: "Lovelace",
      [P.applicationStatus]: APPLICATION_STATUS.approved,
      [P.memberRole]: MEMBER_ROLE.operator,
      [P.firestoreAppId]: appRef.id,
    }),
  ];

  const summary = await pullDecisions(db);
  assert.equal(summary.approvals, 1);
  assert.equal(summary.declines, 0);
  assert.deepEqual(summary.errors, []);

  const member = await db.collection(APPROVED_MEMBERS).doc("ada@example.com").get();
  assert.equal(member.exists, true);
  assert.equal(member.data()?.role, "operator");
  assert.equal(member.data()?.name, "Ada Lovelace");
  // The marker that licenses a later decline to remove this entry.
  assert.equal(member.data()?.source, HUBSPOT_SOURCE);
  assert.equal(typeof member.data()?.addedAt, "number");

  const app = await appRef.get();
  assert.equal(app.data()?.status, "approved");
  assert.ok(app.data()?.decidedAt);

  // And the decision is marked synced so it is never applied twice.
  const patch = patchFor("ada@example.com");
  assert.equal(patch?.properties[P.decisionSynced], DECISION_SYNCED.synced);
  assert.equal(patch?.properties[P.memberStatus], MEMBER_STATUS.approvedMember);
  assert.equal(patch?.properties[P.syncNote], "");
});

test("an approval honours the mentor role", async () => {
  searchResults = [
    decidedContact({
      email: "mentor@example.com",
      [P.applicationStatus]: APPLICATION_STATUS.approved,
      [P.memberRole]: MEMBER_ROLE.mentor,
    }),
  ];
  await pullDecisions(db);
  const member = await db.collection(APPROVED_MEMBERS).doc("mentor@example.com").get();
  assert.equal(member.data()?.role, "mentor");
});

test("an approval with no role set defaults to operator", async () => {
  searchResults = [
    decidedContact({
      email: "norole@example.com",
      [P.applicationStatus]: APPLICATION_STATUS.approved,
    }),
  ];
  await pullDecisions(db);
  const member = await db.collection(APPROVED_MEMBERS).doc("norole@example.com").get();
  assert.equal(member.data()?.role, "operator");
});

test("re-approving an entry someone added by hand does NOT claim it", async () => {
  // Merging role/name is fine; stamping `source: "hubspot"` on it is not —
  // that marker is what a later decline uses to justify deletion.
  await db.collection(APPROVED_MEMBERS).doc("josh@high-agency.io").set({
    role: "mentor",
    name: "Josh N.",
    addedAt: Date.now(),
  });

  searchResults = [
    decidedContact({
      email: "josh@high-agency.io",
      firstname: "Josh",
      lastname: "N.",
      [P.applicationStatus]: APPLICATION_STATUS.approved,
      [P.memberRole]: MEMBER_ROLE.mentor,
    }),
  ];
  await pullDecisions(db);

  const member = await db.collection(APPROVED_MEMBERS).doc("josh@high-agency.io").get();
  assert.equal(member.exists, true);
  assert.equal(member.data()?.source, undefined);
});

test("a decline REMOVES a hubspot-sourced allowlist entry", async () => {
  const appRef = await db.collection(APPLICATIONS).add({
    name: "Test Applicant",
    email: "declineme@example.com",
    createdAt: Timestamp.now(),
  });
  await db.collection(APPROVED_MEMBERS).doc("declineme@example.com").set({
    role: "operator",
    addedAt: Date.now(),
    source: HUBSPOT_SOURCE,
  });

  searchResults = [
    decidedContact({
      email: "declineme@example.com",
      [P.applicationStatus]: APPLICATION_STATUS.declined,
      [P.declineReason]: "Not a fit for batch 1",
      [P.firestoreAppId]: appRef.id,
    }),
  ];

  const summary = await pullDecisions(db);
  assert.equal(summary.declines, 1);
  assert.deepEqual(summary.errors, []);

  const member = await db.collection(APPROVED_MEMBERS).doc("declineme@example.com").get();
  assert.equal(member.exists, false);

  const app = await appRef.get();
  assert.equal(app.data()?.status, "declined");
  assert.equal(app.data()?.declineReason, "Not a fit for batch 1");

  const patch = patchFor("declineme@example.com");
  assert.equal(patch?.properties[P.decisionSynced], DECISION_SYNCED.synced);
  assert.equal(patch?.properties[P.memberStatus], MEMBER_STATUS.declined);
  // Nothing needed a human, so no warning.
  assert.equal(patch?.properties[P.syncNote], "");
});

test("a decline PRESERVES a hand-added allowlist entry and warns staff", async () => {
  // THE GUARDRAIL. A CRM edit must never silently destroy the entry that lets a
  // real mentor sign in.
  await db.collection(APPROVED_MEMBERS).doc("josh@high-agency.io").set({
    role: "mentor",
    name: "Josh N.",
    addedAt: Date.now(),
    note: "portal owner",
  });

  searchResults = [
    decidedContact({
      email: "josh@high-agency.io",
      [P.applicationStatus]: APPLICATION_STATUS.declined,
    }),
  ];

  const summary = await pullDecisions(db);
  assert.equal(summary.declines, 1);

  const member = await db.collection(APPROVED_MEMBERS).doc("josh@high-agency.io").get();
  assert.equal(member.exists, true, "hand-added entry must survive a CRM decline");
  assert.equal(member.data()?.role, "mentor");
  assert.equal(member.data()?.note, "portal owner");

  // And the human is told, in HubSpot, why nothing was revoked.
  const patch = patchFor("josh@high-agency.io");
  assert.equal(patch?.properties[P.decisionSynced], DECISION_SYNCED.synced);
  assert.match(patch?.properties[P.syncNote] ?? "", /added by hand/);
});

test("a decline for someone with no allowlist entry is a clean no-op", async () => {
  searchResults = [
    decidedContact({
      email: "stranger@example.com",
      [P.applicationStatus]: APPLICATION_STATUS.declined,
    }),
  ];
  const summary = await pullDecisions(db);
  assert.equal(summary.declines, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(patchFor("stranger@example.com")?.properties[P.syncNote], "");
});

test("the application is found by contact id when the app-id link is absent", async () => {
  // Covers a contact created before ha_firestore_app_id existed: the doc still
  // carries hubspotContactId from its own push, which is an exact match and
  // immune to email casing.
  const appRef = await db.collection(APPLICATIONS).add({
    name: "Ada Lovelace",
    email: "Ada@Example.com", // as typed by the applicant
    hubspotContactId: "2002",
    createdAt: Timestamp.now(),
  });

  searchResults = [
    decidedContact(
      {
        email: "ada@example.com",
        [P.applicationStatus]: APPLICATION_STATUS.approved,
      },
      "2002"
    ),
  ];

  await pullDecisions(db);
  assert.equal((await appRef.get()).data()?.status, "approved");
});

test("one bad record does not abort the run", async () => {
  searchResults = [
    decidedContact({ email: "", [P.applicationStatus]: APPLICATION_STATUS.approved }, "3001"),
    decidedContact(
      { email: "good@example.com", [P.applicationStatus]: APPLICATION_STATUS.approved },
      "3002"
    ),
  ];

  const summary = await pullDecisions(db);
  assert.equal(summary.approvals, 1, "the good record still applied");
  assert.equal(summary.errors.length, 1);
  // The error names the contact id, never an email.
  assert.equal(summary.errors[0].ref, "contact:3001");
  assert.match(summary.errors[0].message, /email/);
  // The unusable one is still marked synced (addressed by object id) so it does
  // not come back every five minutes forever.
  assert.equal(patchFor("3001")?.properties[P.decisionSynced], DECISION_SYNCED.synced);
  assert.equal((await db.collection(APPROVED_MEMBERS).get()).size, 1);
});

test("pullDecisions is a no-op when HubSpot is not configured", async () => {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  try {
    const summary = await pullDecisions(db);
    assert.equal(summary.skipped, "hubspot-not-configured");
    assert.equal(summary.approvals, 0);
    assert.equal(summary.declines, 0);
    assert.deepEqual(summary.errors, []);
    assert.equal(patches.length, 0, "no HubSpot call may be attempted");
  } finally {
    process.env.HUBSPOT_ACCESS_TOKEN = token;
  }
});

/* ------------------------------------------------------------------ */
/* Part 3 — referral attribution through the real sync path            */
/* ------------------------------------------------------------------ */

/** An applicant's own counter, as the signup transaction writes it. */
async function seedApplicantCounter(code: string, confirmed = 0) {
  await db.collection(REFERRALS_COLLECTION).doc(code).set({
    code,
    opId: "HA-052",
    basePos: 52,
    confirmed,
    credited: Math.min(confirmed, 5),
    pos: Math.max(1, 52 - Math.min(confirmed, 5) * 10),
  });
}

/** A staff lead-source counter, as scripts/staff-referrals.js writes it. */
async function seedStaffCounter(code: string, confirmed = 0) {
  await db
    .collection(REFERRALS_COLLECTION)
    .doc(code)
    .set({ ...staffCounterFields(code), confirmed });
}

test("resolveReferralFacts names the staff code that brought someone in", async () => {
  await seedStaffCounter("STAFF2", 12);
  await seedApplicantCounter("MYCDE2", 2);

  const facts = await resolveReferralFacts(
    { id: "x", referralCode: "MYCDE2", referredBy: "STAFF2" },
    db
  );
  assert.equal(facts.source, REFERRAL_SOURCE.staff);
  // The count is the applicant's OWN, never the referrer's.
  assert.equal(facts.confirmed, 2);
});

test("resolveReferralFacts tells an applicant referral from a cold arrival", async () => {
  await seedApplicantCounter("THEYR2", 1);

  assert.equal(
    (await resolveReferralFacts({ id: "x", referredBy: "THEYR2" }, db)).source,
    REFERRAL_SOURCE.applicant
  );
  assert.equal(
    (await resolveReferralFacts({ id: "x", referredBy: "" }, db)).source,
    REFERRAL_SOURCE.direct
  );
  // A code that resolves to nothing is not credited by the write path either.
  assert.equal(
    (await resolveReferralFacts({ id: "x", referredBy: "GHXST2" }, db)).source,
    REFERRAL_SOURCE.direct
  );
});

test("an application with no referral fields reports no source at all", async () => {
  // The three legacy records. `direct` would be a claim about how they arrived
  // that nobody is in a position to make.
  const facts = await resolveReferralFacts({ id: "legacy" }, db);
  assert.equal(facts.source, undefined);
  assert.equal(facts.confirmed, undefined);
});

test("a push puts the staff code on the contact, queryable from HubSpot", async () => {
  await seedStaffCounter("STAFF2", 12);
  await seedApplicantCounter("MYCDE2", 0);
  const appRef = await db.collection(APPLICATIONS).add({
    name: "Ada Lovelace",
    email: "Ada@Example.com",
    age: "16",
    building: "A notation engine",
    boldest: "Cold-emailed 40 professors",
    referralCode: "MYCDE2",
    referredBy: "STAFF2",
    marketingConsent: true,
    marketingConsentAt: Timestamp.fromMillis(Date.UTC(2026, 7, 18)),
    marketingConsentSource: MARKETING_CONSENT_SOURCE,
    createdAt: Timestamp.now(),
  });

  const result = await pushApplication(appRef.id, db);
  assert.equal(result.status, "pushed");

  const props = patchFor("ada@example.com")!.properties;
  // This is the whole ask: from a contact, you can see which staff link it was.
  assert.equal(props[P.referredBy], "STAFF2");
  assert.equal(props[P.referralSource], REFERRAL_SOURCE.staff);
  assert.equal(props[P.referralCode], "MYCDE2");
  assert.equal(props[P.marketingConsent], YES_NO.yes);
  // A contact we are creating still gets its starting statuses.
  assert.equal(props[P.applicationStatus], APPLICATION_STATUS.new);

  // The staff counter itself is untouched by the CRM — Firestore stays the
  // authority on referral resolution.
  const counter = await db.collection(REFERRALS_COLLECTION).doc("STAFF2").get();
  assert.equal(counter.data()?.confirmed, 12);
});

test("a re-push never resets a decision a human already made", async () => {
  await seedApplicantCounter("MYCDE2", 0);
  const appRef = await db.collection(APPLICATIONS).add({
    name: "Ada Lovelace",
    email: "ada@example.com",
    referralCode: "MYCDE2",
    referredBy: "",
    createdAt: Timestamp.now(),
  });
  // The contact already exists and a human has approved it.
  existingContacts["ada@example.com"] = {
    id: "9001",
    properties: {
      [P.applicationStatus]: APPLICATION_STATUS.approved,
      [P.decisionSynced]: DECISION_SYNCED.synced,
      [P.memberStatus]: MEMBER_STATUS.approvedMember,
    },
  };

  await pushApplication(appRef.id, db);

  const props = patchFor("ada@example.com")!.properties;
  assert.equal(props[P.applicationStatus], undefined);
  assert.equal(props[P.decisionSynced], undefined);
  assert.equal(props[P.memberStatus], undefined);
  // …while the new attribution fields still land.
  assert.equal(props[P.referralCode], "MYCDE2");
});

/* -------------------- the periodic refresh -------------------- */

/** An application already pushed to HubSpot, with a referral counter behind it. */
async function seedPushedApplicant(code: string, confirmed: number, mirror?: number) {
  await seedApplicantCounter(code, confirmed);
  return db.collection(APPLICATIONS).add({
    name: "Ada Lovelace",
    email: "ada@example.com",
    referralCode: code,
    referredBy: "",
    createdAt: Timestamp.now(),
    hubspotContactId: "9001",
    ...(mirror === undefined ? {} : { [REFERRAL_MIRROR_FIELD]: mirror }),
  });
}

test("the refresh makes NO HubSpot call when nothing has changed", async () => {
  await seedPushedApplicant("MYCDE2", 3, 3);
  hubspotCalls = [];

  const summary = await refreshReferralCounts(db);

  assert.equal(summary.refreshed, 0);
  assert.equal(summary.unchanged, 1);
  assert.deepEqual(summary.errors, []);
  // The claim that makes a five-minute cadence affordable.
  assert.deepEqual(hubspotCalls, []);
});

test("the refresh patches only the count, once, when it actually moves", async () => {
  const appRef = await seedPushedApplicant("MYCDE2", 4, 3);
  hubspotCalls = [];

  const summary = await refreshReferralCounts(db);
  assert.equal(summary.refreshed, 1);

  const props = patchFor("ada@example.com")!.properties;
  assert.equal(props[P.referralConfirmed], "4");
  // Nothing else on the record is touched — not the answers, not the status.
  assert.deepEqual(Object.keys(props).sort(), [P.referralConfirmed, "email"].sort());
  assert.equal((await appRef.get()).data()?.[REFERRAL_MIRROR_FIELD], 4);

  // Second pass: the mirror now matches, so there is nothing left to do.
  patches = [];
  hubspotCalls = [];
  const again = await refreshReferralCounts(db);
  assert.equal(again.refreshed, 0);
  assert.equal(again.unchanged, 1);
  assert.deepEqual(hubspotCalls, []);
});

test("a counter that has never been pushed is left for the push to carry", async () => {
  await seedApplicantCounter("MYCDE2", 2);
  await db.collection(APPLICATIONS).add({
    email: "ada@example.com",
    referralCode: "MYCDE2",
    createdAt: Timestamp.now(),
    // No hubspotContactId: patching would mint a bare contact.
  });
  hubspotCalls = [];

  const summary = await refreshReferralCounts(db);
  assert.equal(summary.refreshed, 0);
  assert.deepEqual(hubspotCalls, []);
});

test("the refresh ignores staff counters and untouched counters entirely", async () => {
  // A busy staff code, which is nobody's application and therefore never a
  // candidate, plus an applicant counter nobody has used.
  await seedStaffCounter("STAFF2", 40);
  await seedPushedApplicant("MYCDE2", 0, 0);
  hubspotCalls = [];

  const summary = await refreshReferralCounts(db);
  assert.equal(summary.refreshed, 0);
  // The applicant IS looked at (one batched read by id) and found to agree with
  // HubSpot; the staff counter is not reachable from any application at all.
  assert.equal(summary.unchanged, 1);
  // Which is the point: looking costs Firestore reads, never a HubSpot call.
  assert.deepEqual(hubspotCalls, []);
});

test("a staff code sitting in an applicant's own-code field is never refreshed", async () => {
  // Wrong data — a staff counter cannot be an applicant's own code — but if it
  // happens, reporting a staff lead count as somebody's personal referral
  // total would be worse than reporting nothing.
  await seedStaffCounter("STAFF2", 40);
  await db.collection(APPLICATIONS).add({
    email: "ada@example.com",
    referralCode: "STAFF2",
    createdAt: Timestamp.now(),
    hubspotContactId: "9001",
  });
  hubspotCalls = [];

  const summary = await refreshReferralCounts(db);
  assert.equal(summary.refreshed, 0);
  assert.deepEqual(hubspotCalls, []);
});

/**
 * The starvation regression.
 *
 * `referrals` is public and unauthenticated-writable — that is a requirement,
 * not an oversight: a signed-out visitor on a ?ref= link has to be able to
 * resolve and credit a counter. So anyone can create counters carrying
 * `confirmed > 0`.
 *
 * The refresh used to find its work with `referrals where confirmed > 0` under
 * a `limit()`. Firestore applies that limit BEFORE any ownership filtering and
 * orders stably (by the inequality field, then by name), so a flood of
 * ownerless counters occupies the whole first page on every pass, forever, and
 * no real applicant's count is ever refreshed again. A cursor does not save it:
 * the flood outnumbers the real rows on every page too.
 *
 * Candidates now come from `applications` instead, and counters are read BY ID.
 * A counter nobody's application points at is never even looked at.
 */

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Distinct, rules-valid 6-character codes for decoy counters. */
function decoyCode(n: number): string {
  let out = "";
  let rest = n;
  for (let i = 0; i < 5; i++) {
    out += CODE_ALPHABET[rest % CODE_ALPHABET.length];
    rest = Math.floor(rest / CODE_ALPHABET.length);
  }
  return `B${out}`;
}

/** More ownerless counters than the refresh will ever consider, each one
 *  cheaper to sort first than the real applicant's (confirmed: 1 < 4). */
async function floodOwnerlessCounters(count: number) {
  let batch = db.batch();
  for (let i = 0; i < count; i++) {
    const code = decoyCode(i);
    batch.set(db.collection(REFERRALS_COLLECTION).doc(code), {
      code,
      opId: "HA-999",
      basePos: 999,
      confirmed: 1,
      credited: 1,
      pos: 989,
    });
    // Firestore caps a batch at 500 writes.
    if ((i + 1) % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
}

test("a flood of ownerless public counters cannot starve a real applicant", async () => {
  const decoys = REFERRAL_REFRESH_LIMIT + 20;
  await floodOwnerlessCounters(decoys);
  assert.equal(
    (await db.collection(REFERRALS_COLLECTION).get()).size,
    decoys,
    "the flood is in place"
  );

  const appRef = await seedPushedApplicant("MYCDE2", 4, 3);
  hubspotCalls = [];

  const summary = await refreshReferralCounts(db);

  // The real applicant is found and refreshed despite being buried under more
  // decoys than the old query would ever have paged past.
  assert.equal(summary.refreshed, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(patchFor("ada@example.com")?.properties[P.referralConfirmed], "4");
  assert.equal((await appRef.get()).data()?.[REFERRAL_MIRROR_FIELD], 4);

  // And not one of the decoys cost a HubSpot call — they are not candidates.
  assert.equal(
    hubspotCalls.filter((c) => c.startsWith("PATCH")).length,
    1,
    "exactly one contact was written"
  );
});

test("consecutive passes over the flood stay correct and stay quiet", async () => {
  await floodOwnerlessCounters(REFERRAL_REFRESH_LIMIT + 20);
  const appRef = await seedPushedApplicant("MYCDE2", 4, 3);

  const first = await refreshReferralCounts(db);
  assert.equal(first.refreshed, 1);

  // Second pass: the mirror now agrees, so there is nothing to do — and the
  // applicant is still reachable, not pushed off a page by the decoys.
  patches = [];
  hubspotCalls = [];
  const second = await refreshReferralCounts(db);
  assert.equal(second.refreshed, 0);
  assert.equal(second.unchanged, 1);
  assert.deepEqual(hubspotCalls, []);

  // Third pass, after a new referral lands: it is picked up immediately.
  await db.collection(REFERRALS_COLLECTION).doc("MYCDE2").update({ confirmed: 5 });
  const third = await refreshReferralCounts(db);
  assert.equal(third.refreshed, 1);
  assert.equal((await appRef.get()).data()?.[REFERRAL_MIRROR_FIELD], 5);
});

test("HubSpot writes are capped per pass, and the next pass finishes the job", async () => {
  // Everything changed at once — the shape of a first run after the property
  // was added. It must not turn into an unbounded burst of API calls.
  const total = REFERRAL_REFRESH_MAX_WRITES + 1;
  for (let i = 0; i < total; i++) {
    const code = decoyCode(i);
    await db.collection(REFERRALS_COLLECTION).doc(code).set({
      code, opId: "HA-052", basePos: 52, confirmed: 2, credited: 2, pos: 32,
    });
    await db.collection(APPLICATIONS).add({
      email: `applicant${i}@example.com`,
      referralCode: code,
      createdAt: Timestamp.fromMillis(Date.UTC(2026, 7, 18) + i),
      hubspotContactId: `contact-${i}`,
      [REFERRAL_MIRROR_FIELD]: 0,
    });
  }

  const first = await refreshReferralCounts(db);
  assert.equal(first.refreshed, REFERRAL_REFRESH_MAX_WRITES);
  assert.equal(first.truncated, true, "the cap is reported, not hidden");

  // Progress is guaranteed: what was written now compares equal and is skipped,
  // so the next pass reaches the remainder instead of redoing the same work.
  const second = await refreshReferralCounts(db);
  assert.equal(second.refreshed, total - REFERRAL_REFRESH_MAX_WRITES);
  assert.equal(second.truncated, false);

  const third = await refreshReferralCounts(db);
  assert.equal(third.refreshed, 0);
  assert.equal(third.unchanged, total);
});

test("the refresh is a no-op when HubSpot is not configured", async () => {
  await seedPushedApplicant("MYCDE2", 9, 1);
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  hubspotCalls = [];
  try {
    const summary = await refreshReferralCounts(db);
    assert.equal(summary.skipped, "hubspot-not-configured");
    assert.equal(summary.refreshed, 0);
    assert.deepEqual(hubspotCalls, []);
  } finally {
    process.env.HUBSPOT_ACCESS_TOKEN = token;
  }
});
