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
  toDateProperty,
} from "../app/lib/hubspotMapping.ts";
import {
  APPLICATIONS,
  HUBSPOT_SOURCE,
  pullDecisions,
} from "../app/lib/hubspotSync.ts";
import { APPROVED_MEMBERS } from "../app/lib/accessGate.ts";
import {
  APPLICATION_STATUS,
  DECISION_SYNCED,
  MEMBER_ROLE,
  MEMBER_STATUS,
  P,
  YES_NO,
} from "../app/lib/hubspotSchema.ts";

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

    if (path.startsWith("/crm/v3/objects/contacts/search")) {
      return Response.json({
        total: searchResults.length,
        results: searchResults,
      });
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
  for (const col of [APPLICATIONS, APPROVED_MEMBERS]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  searchResults = [];
  patches = [];
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
