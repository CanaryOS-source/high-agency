/**
 * Firestore security-rules tests for the waitlist referral counters. Run
 * against the emulator:
 *
 *   npm run test:referral
 *
 * The claim under test: `referrals/{code}` is a PUBLIC counter that anyone may
 * read and that an unauthenticated waitlist form may write — but only in the
 * one shape the referral mechanic needs. Concretely, a caller cannot mint a
 * counter that already has referrals on it, cannot award itself more than one
 * referral per write, cannot push `credited` past REFERRAL_MAX, cannot invent a
 * position that doesn't match the arithmetic, and cannot touch the identity
 * fields (code / opId / basePos) after create.
 *
 * That is what makes the 5-referral cap real rather than a UI convention.
 */
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import assert from "node:assert/strict";
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from "firebase/firestore";
import {
  REFERRAL_MAX as LIB_MAX,
  REFERRAL_JUMP as LIB_JUMP,
  effectivePos,
  newReferralCode,
  normalizeReferralCode,
} from "../app/lib/referral.ts";

const PROJECT_ID = "highagency-referral-test";

// A deliberate second implementation of the position model. firestore.rules
// has a third (it has no min/max, so it spells the same thing out in
// ternaries). Every expectation below is written against THIS one, and the
// first test pins it to the library — so a change to the cap, the jump or the
// floor that lands in only one of the three fails here instead of silently
// handing someone a position the rules will reject.
const REFERRAL_MAX = 5;
const REFERRAL_JUMP = 10;
const pos = (basePos: number, credited: number) =>
  Math.max(1, basePos - Math.min(credited, REFERRAL_MAX) * REFERRAL_JUMP);

let testEnv: Awaited<ReturnType<typeof initializeTestEnvironment>>;

/** A rules-valid brand-new counter. */
function counter(code: string, basePos = 100) {
  return {
    code,
    opId: "HA-" + String(basePos).padStart(3, "0"),
    basePos,
    confirmed: 0,
    credited: 0,
    pos: basePos,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Seed a counter in whatever state a test needs, bypassing the rules. */
async function seed(code: string, fields: Record<string, unknown>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "referrals", code), {
      ...counter(code),
      ...fields,
    });
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

/* ------------------------------------------------------------------ */
/* The model itself                                                    */
/* ------------------------------------------------------------------ */

test("app/lib/referral agrees with the model these tests assert against", () => {
  assert.equal(LIB_MAX, REFERRAL_MAX);
  assert.equal(LIB_JUMP, REFERRAL_JUMP);
  for (const basePos of [1, 8, 47, 100, 999]) {
    for (let credited = 0; credited <= REFERRAL_MAX + 2; credited++) {
      assert.equal(effectivePos(basePos, credited), pos(basePos, credited));
    }
  }
});

test("codes are in the alphabet the rules accept, and round-trip", () => {
  for (let i = 0; i < 200; i++) {
    const code = newReferralCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
    assert.equal(normalizeReferralCode(code), code);
  }
  // Anything else a URL might hand us resolves to "" rather than a bad read.
  for (const junk of ["", "  ", "k7m2q", "K7M2QO", "../../etc", null, 42]) {
    assert.equal(normalizeReferralCode(junk), "");
  }
  // Lowercase links still work — people retype these off a screen.
  assert.equal(normalizeReferralCode(" k7m2qx "), "K7M2QX");
});

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

test("anyone may mint a counter that starts at zero", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(setDoc(doc(db, "referrals", "K7M2QX"), counter("K7M2QX")));
});

test("a counter cannot be born with referrals already on it", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    setDoc(doc(db, "referrals", "K7M2QX"), {
      ...counter("K7M2QX"),
      confirmed: 4,
      credited: 4,
      pos: 60,
    })
  );
});

test("pos must start equal to basePos", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    setDoc(doc(db, "referrals", "K7M2QX"), { ...counter("K7M2QX"), pos: 1 })
  );
});

test("the code field must match the document id", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    setDoc(doc(db, "referrals", "K7M2QX"), { ...counter("K7M2QX"), code: "AAAAAA" })
  );
});

test("a document id outside the code alphabet is refused", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  // 'O', 'I' and lowercase are deliberately not in the alphabet.
  await assertFails(setDoc(doc(db, "referrals", "K7M2QO"), counter("K7M2QO")));
  await assertFails(setDoc(doc(db, "referrals", "k7m2qx"), counter("k7m2qx")));
  await assertFails(setDoc(doc(db, "referrals", "K7M2Q"), counter("K7M2Q")));
});

test("extra fields are refused — the counter carries no PII", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    setDoc(doc(db, "referrals", "K7M2QX"), {
      ...counter("K7M2QX"),
      email: "operator@example.com",
    })
  );
});

/* ------------------------------------------------------------------ */
/* Attribution rides on the application, not on the public counter      */
/* ------------------------------------------------------------------ */

const application = {
  name: "Sam Q.",
  email: "sam@example.com",
  age: "16",
  building: "A tutoring marketplace",
  boldest: "Cold-emailed 40 schools",
};

test("an application may carry its own code and the one that referred it", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(
    setDoc(doc(db, "applications", "a1"), {
      ...application,
      referralCode: "K7M2QX",
      referredBy: "PQR3WY",
    })
  );
  // Arriving cold is the common case: an empty referredBy must pass.
  await assertSucceeds(
    setDoc(doc(db, "applications", "a2"), {
      ...application,
      referralCode: "AAAAAA",
      referredBy: "",
    })
  );
});

test("a malformed code on an application is refused", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    setDoc(doc(db, "applications", "a3"), {
      ...application,
      referralCode: "nope",
      referredBy: "",
    })
  );
  await assertFails(
    setDoc(doc(db, "applications", "a4"), {
      ...application,
      referralCode: "K7M2QX",
      referredBy: "k7m2qx",
    })
  );
});

test("applications stay unreadable even with referrals on them", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "applications", "a5"), {
      ...application,
      referralCode: "K7M2QX",
      referredBy: "PQR3WY",
    });
  });
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, "applications", "a5")));
});

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

test("a signed-out visitor can resolve a code", async () => {
  await seed("K7M2QX", {});
  const db = testEnv.unauthenticatedContext().firestore();
  const snap = await assertSucceeds(getDoc(doc(db, "referrals", "K7M2QX")));
  // Nothing here is PII: a random code, a public operator id, three numbers.
  assertSameKeys(Object.keys(snap.data()), [
    "code",
    "opId",
    "basePos",
    "confirmed",
    "credited",
    "pos",
    "createdAt",
    "updatedAt",
  ]);
});

function assertSameKeys(actual: string[], expected: string[]) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

/* ------------------------------------------------------------------ */
/* Update — one referral at a time, capped, position recomputed         */
/* ------------------------------------------------------------------ */

test("one confirmed referral moves the position by REFERRAL_JUMP", async () => {
  await seed("K7M2QX", {});
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(
    updateDoc(doc(db, "referrals", "K7M2QX"), {
      confirmed: 1,
      credited: 1,
      pos: pos(100, 1),
      updatedAt: new Date(),
    })
  );
});

test("a write cannot award more than one referral", async () => {
  await seed("K7M2QX", {});
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    updateDoc(doc(db, "referrals", "K7M2QX"), {
      confirmed: 3,
      credited: 3,
      pos: pos(100, 3),
      updatedAt: new Date(),
    })
  );
});

test("the position must match the arithmetic exactly", async () => {
  await seed("K7M2QX", {});
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    updateDoc(doc(db, "referrals", "K7M2QX"), {
      confirmed: 1,
      credited: 1,
      pos: 1, // straight to the front, please
      updatedAt: new Date(),
    })
  );
});

test("credited stops at REFERRAL_MAX, and the position stops with it", async () => {
  await seed("K7M2QX", {
    confirmed: REFERRAL_MAX,
    credited: REFERRAL_MAX,
    pos: pos(100, REFERRAL_MAX),
  });
  const db = testEnv.unauthenticatedContext().firestore();

  // A 6th referral is still recorded, but it must not move them again.
  await assertSucceeds(
    updateDoc(doc(db, "referrals", "K7M2QX"), {
      confirmed: REFERRAL_MAX + 1,
      credited: REFERRAL_MAX,
      pos: pos(100, REFERRAL_MAX),
      updatedAt: new Date(),
    })
  );

  // Pushing credited past the cap is refused outright.
  await assertFails(
    updateDoc(doc(db, "referrals", "K7M2QX"), {
      confirmed: REFERRAL_MAX + 1,
      credited: REFERRAL_MAX + 1,
      pos: pos(100, REFERRAL_MAX + 1),
      updatedAt: new Date(),
    })
  );
});

test("the position floors at 1 rather than going negative", async () => {
  // basePos 8 with 5 referrals would arithmetically land on -42.
  await seed("K7M2QX", { basePos: 8, opId: "HA-008", pos: 8 });
  const db = testEnv.unauthenticatedContext().firestore();
  for (let n = 1; n <= REFERRAL_MAX; n++) {
    await assertSucceeds(
      updateDoc(doc(db, "referrals", "K7M2QX"), {
        confirmed: n,
        credited: n,
        pos: pos(8, n),
        updatedAt: new Date(),
      })
    );
  }
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "referrals", "K7M2QX"));
    assert.equal(snap.data()!.pos, 1);
  });
});

test("identity fields are frozen after create", async () => {
  await seed("K7M2QX", {});
  const db = testEnv.unauthenticatedContext().firestore();
  for (const patch of [
    { basePos: 5 },
    { opId: "HA-001" },
    { code: "AAAAAA" },
  ]) {
    await assertFails(
      updateDoc(doc(db, "referrals", "K7M2QX"), {
        ...patch,
        confirmed: 1,
        credited: 1,
        pos: pos(100, 1),
        updatedAt: new Date(),
      })
    );
  }
});

test("confirmed cannot be walked backwards", async () => {
  await seed("K7M2QX", { confirmed: 2, credited: 2, pos: pos(100, 2) });
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    updateDoc(doc(db, "referrals", "K7M2QX"), {
      confirmed: 1,
      credited: 1,
      pos: pos(100, 1),
      updatedAt: new Date(),
    })
  );
});

test("counters cannot be deleted", async () => {
  await seed("K7M2QX", {});
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(deleteDoc(doc(db, "referrals", "K7M2QX")));
});
