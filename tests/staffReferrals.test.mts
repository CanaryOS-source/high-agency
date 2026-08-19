/**
 * Staff lead-source referral codes. Run with:
 *
 *   npm run test:staff
 *
 * (wraps `tsx --test` in `firebase emulators:exec --only firestore`, same as
 * the consent, mentor-invite and hubspot suites).
 *
 * Two halves:
 *
 * 1. The pure decision layer (app/lib/staffReferrals.ts) — roster validation
 *    and planStaffCode, with no I/O at all. The load-bearing claim is that a
 *    database state which disagrees with itself produces a REFUSAL, not a
 *    repair: a staff code may already be printed in somebody's post, and
 *    silently re-minting one would detach every click that link has earned.
 *
 * 2. Provisioning against the emulator, through the real code path
 *    (app/lib/staffReferralsServer.ts — the same functions the CLI calls). The
 *    claims that matter to a human: running it twice hands back the SAME code,
 *    a dry run writes nothing, and provisioning creates a counter and a mapping
 *    and NOTHING else — no auth user, no profile, no allowlist entry, no
 *    application.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { adminDb } from "../app/lib/firebaseAdmin.ts";
import {
  REFERRALS_COLLECTION,
  REFERRAL_CODE_RE,
  STAFF_BASE_POS,
  STAFF_COUNTER_KIND,
  STAFF_OP_ID,
  effectivePos,
  isStaffCounter,
  staffCounterFields,
} from "../app/lib/referral.ts";
import {
  STAFF_CODES_COLLECTION,
  STAFF_ROSTER,
  planStaffCode,
  validateRoster,
  type StaffMember,
} from "../app/lib/staffReferrals.ts";
import {
  mintStaffCode,
  provisionStaffCodes,
} from "../app/lib/staffReferralsServer.ts";

const db = adminDb();

const ALICE: StaffMember = {
  slug: "ada-lovelace",
  name: "Ada Lovelace",
  slackId: "U01ADALOVE1",
};

/* ------------------------------------------------------------------ */
/* Part 1 — the roster and the plan, pure                              */
/* ------------------------------------------------------------------ */

test("the shipped roster is exactly the five approved people, and it validates", () => {
  assert.deepEqual(validateRoster(), []);
  assert.equal(STAFF_ROSTER.length, 5);
  assert.deepEqual(
    STAFF_ROSTER.map((m) => m.slackId),
    [
      "U09CSHVBLBZ", // Evelyn Qiao
      "U09DFU5N5D4", // Dhairya Shah
      "U09DC7UQMS8", // Mahathi (Mahi) Dharmavaram
      "U09DU715ZFB", // Kejun Liu
      "U09E18UGD5E", // Harish Ramasubramanian
    ]
  );
});

test("roster validation catches the mistakes a hand edit actually makes", () => {
  assert.ok(
    validateRoster([{ ...ALICE, slug: "Ada Lovelace" }]).some((p) =>
      p.includes("not a valid slug")
    )
  );
  assert.ok(
    validateRoster([{ ...ALICE, slackId: "ada@example.com" }]).some((p) =>
      p.includes("Slack id")
    )
  );
  assert.ok(
    validateRoster([ALICE, { ...ALICE, name: "Ada L." }]).some((p) =>
      p.includes("duplicate slug")
    )
  );
  assert.ok(
    validateRoster([ALICE, { ...ALICE, slug: "ada-l" }]).some((p) =>
      p.includes("duplicate Slack id")
    )
  );
});

/** A mapping/counter pair in the state a successful provision leaves behind. */
function goodPair(code = "K7M2QX") {
  return {
    mapping: { slug: ALICE.slug, name: ALICE.name, slackId: ALICE.slackId, code },
    counter: staffCounterFields(code),
  };
}

test("no mapping means mint one", () => {
  assert.deepEqual(planStaffCode(ALICE, null, null), {
    action: "create",
    member: ALICE,
  });
});

test("a healthy pair is left alone and reports its lead count", () => {
  const { mapping, counter } = goodPair();
  const plan = planStaffCode(ALICE, mapping, { ...counter, confirmed: 7 });
  assert.equal(plan.action, "exists");
  assert.equal(plan.action === "exists" && plan.code, "K7M2QX");
  assert.equal(plan.action === "exists" && plan.confirmed, 7);
});

test("every way the pair can disagree with itself is a refusal, not a repair", () => {
  const { mapping, counter } = goodPair();

  const cases: Array<[string, Parameters<typeof planStaffCode>[1], Parameters<typeof planStaffCode>[2], string]> = [
    ["code isn't a code", { ...mapping, code: "nope" }, counter, "not a valid referral code"],
    ["belongs to someone else", { ...mapping, slackId: "U0DIFFERENT" }, counter, "Slack id"],
    // Identity that cannot be checked is not identity that passes. An absent
    // or non-string slackId proves nothing about whose code this is, and
    // treating "can't tell" as "matches" is how a code changes hands.
    ["no slackId at all", { ...mapping, slackId: undefined }, counter, "no usable Slack id"],
    ["slackId is empty", { ...mapping, slackId: "" }, counter, "no usable Slack id"],
    ["slackId is not a string", { ...mapping, slackId: 12345 }, counter, "no usable Slack id"],
    ["slackId is null", { ...mapping, slackId: null }, counter, "no usable Slack id"],
    ["mapping names another slug", { ...mapping, slug: "someone-else" }, counter, "names slug"],
    ["counter is missing", mapping, null, "half-written"],
    ["counter id mismatch", mapping, { ...counter, code: "AAAAAA" }, "instead of"],
    ["counter is an applicant's", mapping, { ...counter, kind: undefined }, "not a staff counter"],
    ["counter has a queue position", mapping, { ...counter, basePos: 52 }, "no queue position"],
    // A malformed count must not be laundered into a confident 0 — "nobody
    // clicked" is a different and far more actionable claim than "broken".
    ["confirmed is absent", mapping, { ...counter, confirmed: undefined }, "not a count"],
    ["confirmed is a string", mapping, { ...counter, confirmed: "3" }, "not a count"],
    ["confirmed is null", mapping, { ...counter, confirmed: null }, "not a count"],
    ["confirmed is NaN", mapping, { ...counter, confirmed: Number.NaN }, "not a count"],
    ["confirmed is negative", mapping, { ...counter, confirmed: -1 }, "not a count"],
    ["confirmed is fractional", mapping, { ...counter, confirmed: 2.5 }, "not a count"],
  ];

  for (const [label, m, c, needle] of cases) {
    const plan = planStaffCode(ALICE, m, c);
    assert.equal(plan.action, "conflict", label);
    assert.ok(
      plan.action === "conflict" && plan.reason.includes(needle),
      `${label}: expected reason to mention "${needle}", got ${
        plan.action === "conflict" ? plan.reason : plan.action
      }`
    );
  }
});

test("a staff counter is inert as a queue position at every credit level", () => {
  const counter = staffCounterFields("K7M2QX");
  assert.equal(counter.basePos, STAFF_BASE_POS);
  assert.equal(counter.opId, STAFF_OP_ID);
  assert.ok(isStaffCounter(counter));
  assert.ok(!isStaffCounter({ kind: undefined }));
  // The whole reason basePos is 1: the shared arithmetic never moves it, so
  // the rules need no branch for staff counters and `pos` cannot drift.
  for (let credited = 0; credited <= 12; credited++) {
    assert.equal(effectivePos(counter.basePos, credited), STAFF_BASE_POS);
  }
});

/* ------------------------------------------------------------------ */
/* Part 2 — provisioning against the emulator                          */
/* ------------------------------------------------------------------ */

const TEST_ROSTER: StaffMember[] = [
  ALICE,
  { slug: "grace-hopper", name: "Grace Hopper", slackId: "U02GRACEHOP" },
];

async function clearAll() {
  for (const col of [REFERRALS_COLLECTION, STAFF_CODES_COLLECTION, "applications"]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(clearAll);
after(clearAll);

async function provision(apply: boolean) {
  return provisionStaffCodes({
    apply,
    roster: TEST_ROSTER,
    origin: "https://high-agency.io",
    db,
  });
}

test("a dry run plans everything and writes nothing", async () => {
  const summary = await provision(false);

  assert.equal(summary.mode, "dry-run");
  assert.ok(summary.ok);
  assert.deepEqual(
    summary.staff.map((r) => r.action),
    ["would-create", "would-create"]
  );
  // No link is offered for a code that does not exist yet — printing one would
  // invite somebody to share a dead link.
  assert.deepEqual(summary.staff.map((r) => r.link), [null, null]);

  for (const col of [REFERRALS_COLLECTION, STAFF_CODES_COLLECTION]) {
    assert.equal((await db.collection(col).get()).size, 0, `${col} was written`);
  }
});

test("--apply mints a counter and a mapping, and nothing else", async () => {
  const summary = await provision(true);
  assert.ok(summary.ok);
  assert.deepEqual(
    summary.staff.map((r) => r.action),
    ["created", "created"]
  );

  for (const row of summary.staff) {
    assert.match(row.code!, REFERRAL_CODE_RE);
    assert.equal(row.link, `https://high-agency.io/?ref=${row.code}`);

    const counter = (
      await db.collection(REFERRALS_COLLECTION).doc(row.code!).get()
    ).data()!;
    // Exactly the applicant shape plus the one marker, so the shared read path
    // and the shared update rule both apply unchanged.
    assert.deepEqual([...Object.keys(counter)].sort(), [
      "basePos",
      "code",
      "confirmed",
      "createdAt",
      "credited",
      "kind",
      "opId",
      "pos",
      "updatedAt",
    ]);
    assert.equal(counter.kind, STAFF_COUNTER_KIND);
    assert.equal(counter.basePos, STAFF_BASE_POS);
    assert.equal(counter.pos, STAFF_BASE_POS);
    assert.equal(counter.confirmed, 0);
    assert.equal(counter.credited, 0);
    // No name, no Slack id, no email: this document is world-readable.
    assert.equal(counter.opId, STAFF_OP_ID);

    const mapping = (
      await db.collection(STAFF_CODES_COLLECTION).doc(row.slug).get()
    ).data()!;
    assert.equal(mapping.code, row.code);
    assert.equal(mapping.slackId, row.slackId);
  }

  // The point of the whole design: staff get a link, not an account.
  for (const col of ["applications", "profiles", "approvedMembers"]) {
    assert.equal((await db.collection(col).get()).size, 0, `${col} was written`);
  }
});

test("re-running returns the SAME codes and mints nothing new", async () => {
  const first = await provision(true);
  const second = await provision(true);
  const third = await provision(false);

  assert.deepEqual(
    second.staff.map((r) => r.action),
    ["exists", "exists"]
  );
  assert.deepEqual(
    first.staff.map((r) => r.code),
    second.staff.map((r) => r.code)
  );
  assert.deepEqual(
    first.staff.map((r) => r.code),
    third.staff.map((r) => r.code)
  );
  assert.equal((await db.collection(REFERRALS_COLLECTION).get()).size, 2);
  assert.equal((await db.collection(STAFF_CODES_COLLECTION).get()).size, 2);
});

test("an existing code keeps its lead count across runs", async () => {
  const first = await provision(true);
  const code = first.staff[0].code!;
  // Simulate three people applying through the link — the same +1 the waitlist
  // write path makes.
  await db.collection(REFERRALS_COLLECTION).doc(code).update({ confirmed: 3 });

  const again = await provision(false);
  assert.equal(again.staff[0].confirmed, 3);
  assert.equal(again.staff[0].action, "exists");
});

test("a half-written pair is refused, and the other person still gets provisioned", async () => {
  const first = await provision(true);
  const orphaned = first.staff[0].code!;
  // The failure mode a crashed run would leave: mapping without counter.
  await db.collection(REFERRALS_COLLECTION).doc(orphaned).delete();

  const summary = await provision(true);
  assert.equal(summary.ok, false);
  assert.equal(summary.staff[0].action, "conflict");
  assert.match(summary.staff[0].reason!, /half-written/);
  assert.equal(summary.conflicts.length, 1);
  // The healthy row is untouched, not collateral damage.
  assert.equal(summary.staff[1].action, "exists");
  assert.equal(summary.staff[1].code, first.staff[1].code);
  // And the conflicting slug was NOT re-minted behind our back.
  assert.equal(
    (await db.collection(STAFF_CODES_COLLECTION).doc(ALICE.slug).get()).data()
      ?.code,
    orphaned
  );
});

test("a code pointing at a real applicant's counter is refused outright", async () => {
  const first = await provision(true);
  const code = first.staff[0].code!;
  // Someone hand-edits the counter into an applicant shape. Re-minting over
  // this would hand an applicant's referrals to a staff member.
  await db
    .collection(REFERRALS_COLLECTION)
    .doc(code)
    .set({ code, opId: "HA-052", basePos: 52, confirmed: 2, credited: 2, pos: 32 });

  const summary = await provision(true);
  assert.equal(summary.ok, false);
  assert.match(summary.staff[0].reason!, /not a staff counter/);
  // Untouched.
  assert.equal(
    (await db.collection(REFERRALS_COLLECTION).doc(code).get()).data()?.opId,
    "HA-052"
  );
});

test("mintStaffCode never overwrites a mapping that appeared mid-flight", async () => {
  const { code: firstCode } = await mintStaffCode(db, ALICE);
  const { code: secondCode, raced } = await mintStaffCode(db, ALICE);

  assert.equal(secondCode, firstCode);
  assert.equal(raced, true);
  assert.equal((await db.collection(REFERRALS_COLLECTION).get()).size, 1);
});

/**
 * The race that matters. A mapping can appear between planning and the
 * transaction — another run, another person, or a transaction retry. The old
 * code returned that mapping's `code` on sight, so whatever the other writer
 * left behind was reported as a healthy `exists`. If they left a half-written
 * or malformed pair, that is a link handed out that credits nobody.
 */
const RACE_CASES: Array<[string, Record<string, unknown>, boolean]> = [
  ["no code field", { slug: ALICE.slug, name: ALICE.name, slackId: ALICE.slackId }, false],
  ["code isn't a code", { slug: ALICE.slug, slackId: ALICE.slackId, code: "nope" }, false],
  ["no slackId", { slug: ALICE.slug, name: ALICE.name, code: "K7M2QX" }, false],
  ["someone else's slackId", { slug: ALICE.slug, slackId: "U0DIFFERENT", code: "K7M2QX" }, false],
  ["counter never written", { slug: ALICE.slug, slackId: ALICE.slackId, code: "K7M2QX" }, false],
];

for (const [label, mapping, shouldSucceed] of RACE_CASES) {
  test(`a mapping that appears mid-transaction is validated: ${label}`, async () => {
    // Another writer got there first and left this behind.
    await db.collection(STAFF_CODES_COLLECTION).doc(ALICE.slug).set(mapping);

    await assert.rejects(
      () => mintStaffCode(db, ALICE),
      (err: Error) => {
        assert.ok(err.message.length > 0, "the refusal says why");
        return true;
      },
      `${label} must not be reported as a usable code`
    );
    assert.equal(shouldSucceed, false);

    // Nothing was written over the top of the other writer's document.
    const after = await db.collection(STAFF_CODES_COLLECTION).doc(ALICE.slug).get();
    assert.deepEqual(after.data(), mapping);
  });
}

test("a mapping that appears mid-transaction with a VALID pair is accepted", async () => {
  // The benign race: the other writer finished the job properly. Re-validating
  // must not turn a healthy pair into a conflict.
  const code = "K7M2QX";
  await db
    .collection(REFERRALS_COLLECTION)
    .doc(code)
    .set({ ...staffCounterFields(code), createdAt: new Date(), updatedAt: new Date() });
  await db
    .collection(STAFF_CODES_COLLECTION)
    .doc(ALICE.slug)
    .set({ slug: ALICE.slug, name: ALICE.name, slackId: ALICE.slackId, code });

  const result = await mintStaffCode(db, ALICE);
  assert.deepEqual(result, { code, raced: true });
  // No second counter was minted.
  assert.equal((await db.collection(REFERRALS_COLLECTION).get()).size, 1);
});

test("a raced malformed mapping surfaces as a conflict row, not a bad link", async () => {
  // Through the real entry point the CLI uses: the throw becomes the same
  // conflict a plan would have produced, and the healthy person still gets done.
  await db
    .collection(STAFF_CODES_COLLECTION)
    .doc(ALICE.slug)
    .set({ slug: ALICE.slug, slackId: ALICE.slackId, code: "K7M2QX" });

  const summary = await provisionStaffCodes({
    apply: true,
    roster: TEST_ROSTER,
    db,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.staff[0].action, "conflict");
  assert.equal(summary.staff[0].code, null, "no link is offered for a broken pair");
  assert.equal(summary.conflicts.length, 1);
  // The other roster entry is unaffected.
  assert.equal(summary.staff[1].action, "created");
  assert.match(summary.staff[1].code!, REFERRAL_CODE_RE);
});

test("provisioning refuses a roster it cannot trust, before writing anything", async () => {
  await assert.rejects(
    () =>
      provisionStaffCodes({
        apply: true,
        roster: [{ ...ALICE, slackId: "not-a-slack-id" }],
        db,
      }),
    /roster .* is invalid/s
  );
  assert.equal((await db.collection(REFERRALS_COLLECTION).get()).size, 0);
});
