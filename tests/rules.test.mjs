/**
 * Firestore security-rules tests: parental-consent enforcement, the
 * founding-batch gate, workshops (server-only writes), squad check-ins,
 * mentor adoption + the activation gate, and the mentor-owned track. Run
 * against the Firestore emulator:
 *
 *   npm run test:rules
 *
 * which wraps `node --test` in `firebase emulators:exec --only firestore`, so
 * the emulator is up and FIRESTORE_EMULATOR_HOST is set for us.
 *
 * The core claim under test: a minor whose consentStatus is "pending" is
 * DENIED — at the rules level — from every community write (create cohort,
 * apply, post build log, tick the ritual), while a "granted"
 * operator succeeds at the identical writes. Plus: a pending minor can't
 * self-grant consent, and the consentTokens collection is fully locked to
 * clients.
 */
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  arrayUnion,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";

const PROJECT_ID = "highagency-rules-test";

/** A fully rules-valid profile, parameterised by consent state. */
function profile(uid, consentStatus, role = "operator") {
  return {
    uid,
    name: "Test O.",
    role,
    ageBand: consentStatus === "granted" ? "18+" : "13-15",
    country: "Canada",
    timezone: "America/Toronto",
    headline: "Building something real",
    building: "An app",
    stage: "building",
    domains: ["AI"],
    skills: ["Coding"],
    consentStatus,
    plan: "free",
    streak: 1,
    streakFreezes: 0,
    lastActiveDay: "2026-07-10",
    pendingApplications: [],
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  };
}

/** A rules-valid cohort doc — every required field present, so update tests
 *  exercise the gate under test rather than tripping on shape. */
function fullCohort(overrides = {}) {
  return {
    name: "Test Squad",
    mission: "Ship something real",
    tags: ["AI"],
    lookingFor: ["Coding"],
    meetingSlot: "Sundays 7pm ET",
    timezone: "America/Toronto",
    state: "forming",
    founderUid: "founder",
    founderName: "Test O.",
    memberUids: ["founder", "granted", "minor"],
    memberNames: { founder: "Test O.", granted: "Test O.", minor: "Test O." },
    open: true,
    weeklyStreak: 0,
    lastRitualWeek: "",
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

/** A check-in on cohorts/mentored, owned by mentorA and asked for by a member. */
function checkIn(overrides = {}) {
  return {
    cohortId: "mentored",
    requestedByUid: "granted",
    requestedByName: "Test O.",
    note: "Stuck on pricing",
    status: "requested",
    mentorUid: "mentorA",
    mentorName: "Mentor A.",
    startsAt: null,
    durationMins: 30,
    meetLink: "",
    createdAt: serverTimestamp(),
    confirmedAt: null,
    ...overrides,
  };
}

/** A workshop owned by mentorA, shaped like the server writes it. */
function workshop(overrides = {}) {
  return {
    title: "The Cold Ask",
    mentorName: "Mentor A.",
    mentorUid: "mentorA",
    description: "",
    startsAt: Timestamp.fromMillis(Date.now() + 86400000),
    durationMins: 60,
    meetLink: "https://meet.example/x",
    capacity: 3,
    enrolledUids: [],
    recordingUrl: "",
    ...overrides,
  };
}

/** One step of a mentor-written track. */
function step(i, done = false) {
  return { id: `s${i}`, title: `Step ${i}`, detail: "", dueDay: "", doneAt: done ? Date.now() : null };
}

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed with rules bypassed: two operators (one pending minor, one granted),
  // a squad they both belong to, and a separate open squad to apply into.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "profiles/minor"), profile("minor", "pending"));
    await setDoc(doc(db, "profiles/granted"), profile("granted", "granted"));
    await setDoc(doc(db, "profiles/founder"), profile("founder", "granted"));
    // Two mentors: mentorA owns things, mentorB is the "other mentor" every
    // ownership test needs to be denied.
    await setDoc(doc(db, "profiles/mentorA"), profile("mentorA", "granted", "mentor"));
    await setDoc(doc(db, "profiles/mentorB"), profile("mentorB", "granted", "mentor"));

    // A squad both test users are members of (so membership-gated writes reach
    // the consent check). Only the fields the rules read are needed.
    await setDoc(doc(db, "cohorts/squad"), {
      founderUid: "founder",
      memberUids: ["founder", "minor", "granted"],
      weeklyStreak: 2,
      lastRitualWeek: "2026-W27",
    });
    // TEMPORARY — founding-batch access gate. Profile CREATE now also requires
    // the caller's token email to be on this allowlist. Seeded with rules
    // bypassed, exactly as staff writes it (Console / scripts/approve.js).
    await setDoc(doc(db, "approvedMembers/approved@example.com"), {
      role: "operator",
      name: "Approved O.",
      addedAt: Date.now(),
    });
    // Hand-created-in-the-Console shape: role only, no addedAt. Must still work.
    await setDoc(doc(db, "approvedMembers/wannabe@example.com"), {
      role: "operator",
    });

    // A different squad neither is a member of, to apply into.
    await setDoc(doc(db, "cohorts/openSquad"), {
      founderUid: "founder",
      memberUids: ["founder"],
      weeklyStreak: 0,
    });

    /* ---- mentor-sessions fixtures ---- */

    // Fully rules-valid squads for the activation-gate + adoption tests.
    await setDoc(doc(db, "cohorts/unclaimed"), fullCohort()); // 3 members, no mentor
    await setDoc(doc(db, "cohorts/tiny"), fullCohort({ memberUids: ["founder"] }));
    await setDoc(
      doc(db, "cohorts/claimed"),
      fullCohort({ mentorUid: "mentorA", mentorName: "Mentor A." })
    );
    // Squad with a mentor, used for the check-in flow.
    await setDoc(
      doc(db, "cohorts/mentored"),
      fullCohort({ mentorUid: "mentorA", mentorName: "Mentor A.", state: "active" })
    );
    await setDoc(doc(db, "cohorts/mentored/checkIns/req1"), checkIn());
    // A confirmed one, to prove it can't be re-edited.
    await setDoc(
      doc(db, "cohorts/mentored/checkIns/done1"),
      checkIn({ status: "confirmed", startsAt: Timestamp.now(), meetLink: "https://m/x" })
    );

    // mentorA's session with two seats, one already taken.
    await setDoc(doc(db, "workshops/owned"), workshop({ enrolledUids: ["someone"] }));
  });
});

/* ---- shared write attempts, parameterised by the acting uid ---- */

function createCohort(db, uid) {
  return addDoc(collection(db, "cohorts"), {
    name: "New Squad",
    mission: "Ship something",
    meetingSlot: "Sundays 7pm ET",
    timezone: "America/Toronto",
    state: "forming",
    founderUid: uid,
    founderName: "Test O.",
    memberUids: [uid],
    memberNames: { [uid]: "Test O." },
    open: true,
    weeklyStreak: 0,
    createdAt: serverTimestamp(),
  });
}

function applyToOpenSquad(db, uid) {
  return setDoc(doc(db, "cohorts/openSquad/applications", uid), {
    applicantUid: uid,
    applicantName: "Test O.",
    pitch: "Let me in",
    hours: "3-5",
    status: "pending",
    declineReason: null,
    createdAt: serverTimestamp(),
  });
}

function postBuildLog(db, uid) {
  return addDoc(collection(db, "cohorts/squad/logs"), {
    uid,
    name: "Test O.",
    text: "Shipped the landing page",
    day: "2026-07-10",
    createdAt: serverTimestamp(),
  });
}

function tickRitual(db) {
  return updateDoc(doc(db, "cohorts/squad"), {
    weeklyStreak: 3,
    lastRitualWeek: "2026-W28",
  });
}

/* ================= pending minor: every community write DENIED ============ */

test("pending minor is denied: create cohort", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(createCohort(db, "minor"));
});

test("pending minor is denied: create application", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(applyToOpenSquad(db, "minor"));
});

test("pending minor is denied: post build log", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(postBuildLog(db, "minor"));
});

test("pending minor is denied: ritual update", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(tickRitual(db));
});

/* ================= granted operator: identical writes SUCCEED ============= */

test("granted operator is allowed: create cohort", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(createCohort(db, "granted"));
});

test("granted operator is allowed: create application", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(applyToOpenSquad(db, "granted"));
});

test("granted operator is allowed: post build log", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(postBuildLog(db, "granted"));
});

test("granted member is allowed: ritual update", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(tickRitual(db));
});

/* ================= consent can't be self-granted ========================= */

test("pending minor cannot self-grant consent via profile update", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(
    updateDoc(doc(db, "profiles/minor"), {
      consentStatus: "granted",
      updatedAt: serverTimestamp(),
    })
  );
});

test("operator can still edit their own profile (consent unchanged)", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(
    updateDoc(doc(db, "profiles/granted"), {
      headline: "New headline",
      updatedAt: serverTimestamp(),
    })
  );
});

/* ================= consentTokens are server-only ========================= */

test("clients cannot read or write consentTokens", async () => {
  const authed = testEnv.authenticatedContext("minor").firestore();
  await assertFails(getDoc(doc(authed, "consentTokens/abc")));
  await assertFails(setDoc(doc(authed, "consentTokens/abc"), { uid: "minor" }));

  const anon = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, "consentTokens/abc")));
});

test("clients cannot read or write mentorInvites", async () => {
  const authed = testEnv.authenticatedContext("minor").firestore();
  await assertFails(getDoc(doc(authed, "mentorInvites/abc")));
  await assertFails(setDoc(doc(authed, "mentorInvites/abc"), { used: false }));

  const anon = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, "mentorInvites/abc")));
});

test("client cannot create a profile with role mentor (invite route only)", async () => {
  // Allowlisted, so the ONLY thing under test here is the role restriction —
  // otherwise the access gate would fail this write for the wrong reason.
  const db = testEnv
    .authenticatedContext("wannabe", { email: "wannabe@example.com" })
    .firestore();
  await assertFails(
    setDoc(doc(db, "profiles/wannabe"), {
      ...profile("wannabe", "granted"),
      role: "mentor",
    })
  );
});

/* ============ TEMPORARY: founding-batch access gate ====================== *
 * Delete this block together with approvedMembers / isApprovedMember().
 * ========================================================================= */

test("GATE: an allowlisted user can create their own profile", async () => {
  const db = testEnv
    .authenticatedContext("newbie", { email: "approved@example.com" })
    .firestore();
  await assertSucceeds(
    setDoc(doc(db, "profiles/newbie"), profile("newbie", "granted"))
  );
});

test("GATE: the allowlist is matched case-insensitively", async () => {
  // Doc ids are lowercased; a token carrying the address as typed must still
  // match, or anyone who signed up with a capital letter is locked out.
  const db = testEnv
    .authenticatedContext("shouty", { email: "Approved@Example.com" })
    .firestore();
  await assertSucceeds(
    setDoc(doc(db, "profiles/shouty"), profile("shouty", "granted"))
  );
});

test("GATE: a non-allowlisted user cannot create a profile", async () => {
  const db = testEnv
    .authenticatedContext("stranger", { email: "stranger@example.com" })
    .firestore();
  await assertFails(
    setDoc(doc(db, "profiles/stranger"), profile("stranger", "granted"))
  );
});

test("GATE: a caller with no email on the token cannot create a profile", async () => {
  const db = testEnv.authenticatedContext("tokenless").firestore();
  await assertFails(
    setDoc(doc(db, "profiles/tokenless"), profile("tokenless", "granted"))
  );
});

test("GATE: an allowlisted user still cannot create somebody else's profile", async () => {
  const db = testEnv
    .authenticatedContext("newbie", { email: "approved@example.com" })
    .firestore();
  await assertFails(
    setDoc(doc(db, "profiles/someoneelse"), profile("someoneelse", "granted"))
  );
});

test("GATE: the gate does not block profile UPDATES for existing members", async () => {
  // Only create is gated. An operator seeded before the gate existed (no email
  // on their context at all) must still be able to edit their own profile.
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(
    updateDoc(doc(db, "profiles/granted"), {
      headline: "Still building",
      updatedAt: serverTimestamp(),
    })
  );
});

test("GATE: clients cannot read or write approvedMembers", async () => {
  const authed = testEnv
    .authenticatedContext("newbie", { email: "approved@example.com" })
    .firestore();
  await assertFails(getDoc(doc(authed, "approvedMembers/approved@example.com")));
  await assertFails(
    setDoc(doc(authed, "approvedMembers/self@example.com"), { role: "mentor" })
  );
  await assertFails(
    deleteDoc(doc(authed, "approvedMembers/approved@example.com"))
  );
  // Not even listable — the list is a roster of real people's addresses.
  await assertFails(getDocs(collection(authed, "approvedMembers")));

  const anon = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, "approvedMembers/approved@example.com")));
  await assertFails(
    setDoc(doc(anon, "approvedMembers/x@example.com"), { role: "mentor" })
  );
});

/* ================= sanity: reads stay open while pending ================= */

test("pending minor can still READ (sees the waiting-on-consent state)", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertSucceeds(getDoc(doc(db, "profiles/minor")));
  await assertSucceeds(getDoc(doc(db, "cohorts/squad")));
});

/* ========================================================================= *
 *  A. Workshops — readable by everyone signed in, written only by the server
 * ========================================================================= */

test("WORKSHOPS: a signed-in operator can read the catalog", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(getDoc(doc(db, "workshops/owned")));
});

test("WORKSHOPS: a signed-out visitor cannot read it", async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, "workshops/owned")));
});

test("WORKSHOPS: an operator cannot enroll from the browser (server route only)", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), { enrolledUids: arrayUnion("granted") })
  );
});

test("WORKSHOPS: a mentor cannot author a session from the browser", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(addDoc(collection(db, "workshops"), workshop()));
});

test("WORKSHOPS: a mentor cannot edit or delete their own session from the browser", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(updateDoc(doc(db, "workshops/owned"), { title: "v2" }));
  await assertFails(deleteDoc(doc(db, "workshops/owned")));
});

test("GOOGLE TOKENS: clients cannot read or write a mentor's calendar token", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(getDoc(doc(db, "googleTokens/mentorA")));
  await assertFails(setDoc(doc(db, "googleTokens/mentorA"), { refreshTokenEnc: "x" }));
});

/* ========================================================================= *
 *  B. Squad check-ins — squad-scoped, mentor-confirmed
 * ========================================================================= */

const requestCheckIn = (db, uid) =>
  addDoc(collection(db, "cohorts/mentored/checkIns"), {
    ...checkIn(),
    requestedByUid: uid,
  });

test("CHECK-IN: a member of a mentored squad can request one", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(requestCheckIn(db, "granted"));
});

test("CHECK-IN: a pending minor cannot request one", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(requestCheckIn(db, "minor"));
});

test("CHECK-IN: a non-member cannot request one", async () => {
  const db = testEnv.authenticatedContext("outsider").firestore();
  await assertFails(requestCheckIn(db, "outsider"));
});

test("CHECK-IN: you cannot request one in someone else's name", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(requestCheckIn(db, "founder"));
});

test("CHECK-IN: a squad with no mentor cannot request one", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    addDoc(collection(db, "cohorts/unclaimed/checkIns"), {
      ...checkIn(),
      cohortId: "unclaimed",
      mentorUid: "mentorA",
    })
  );
});

test("READ SCOPING: squad members and their own mentor can read check-ins", async () => {
  const member = testEnv.authenticatedContext("granted").firestore();
  const mentor = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(getDoc(doc(member, "cohorts/mentored/checkIns/req1")));
  await assertSucceeds(getDoc(doc(mentor, "cohorts/mentored/checkIns/req1")));
  await assertSucceeds(getDocs(collection(member, "cohorts/mentored/checkIns")));
});

test("READ SCOPING: an unrelated mentor cannot read another squad's check-ins", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(getDoc(doc(db, "cohorts/mentored/checkIns/req1")));
  await assertFails(getDocs(collection(db, "cohorts/mentored/checkIns")));
});

test("READ SCOPING: a random operator cannot read a squad's check-ins", async () => {
  const db = testEnv.authenticatedContext("outsider").firestore();
  await assertFails(getDoc(doc(db, "cohorts/mentored/checkIns/req1")));
});

const confirm = (db) =>
  updateDoc(doc(db, "cohorts/mentored/checkIns/req1"), {
    status: "confirmed",
    startsAt: Timestamp.fromMillis(Date.now() + 86400000),
    durationMins: 30,
    meetLink: "https://meet.example/checkin",
    confirmedAt: serverTimestamp(),
  });

test("CONFIRM: even the assigned mentor cannot confirm from the browser (server route only)", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(confirm(db));
});

test("CONFIRM: another mentor cannot confirm it either", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(confirm(db));
});

test("CONFIRM: a squad member cannot confirm their own request", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(confirm(db));
});

test("CHECK-IN: the requester may withdraw while it is still a request", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(deleteDoc(doc(db, "cohorts/mentored/checkIns/req1")));
});

test("CHECK-IN: another member cannot delete someone's request", async () => {
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertFails(deleteDoc(doc(db, "cohorts/mentored/checkIns/req1")));
});

/* ========================================================================= *
 *  C. Mentor adoption + the activation gate
 * ========================================================================= */

const adopt = (db, cohortId, extra = {}) =>
  updateDoc(doc(db, `cohorts/${cohortId}`), {
    mentorUid: "mentorA",
    mentorName: "Mentor A.",
    ...extra,
  });

test("ADOPT: a mentor may claim an unassigned squad", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(adopt(db, "unclaimed"));
});

test("ADOPT: claiming a ready squad activates it in the same write", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(adopt(db, "unclaimed", { state: "active" }));
});

test("ADOPT: a squad under 3 members cannot be activated on adoption", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(adopt(db, "tiny", { state: "active" }));
  // …but adopting it without activating is fine — it activates on the 3rd member.
  await assertSucceeds(adopt(db, "tiny"));
});

test("ADOPT: a mentor cannot steal a squad that already has one", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/claimed"), {
      mentorUid: "mentorB",
      mentorName: "Mentor B.",
    })
  );
});

test("ADOPT: a mentor cannot assign someone else as the mentor", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/unclaimed"), {
      mentorUid: "mentorB",
      mentorName: "Mentor B.",
    })
  );
});

test("ADOPT: an operator cannot appoint themselves mentor of a squad", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/unclaimed"), {
      mentorUid: "granted",
      mentorName: "Test O.",
    })
  );
});

test("ADOPT: the founder cannot write a mentor onto their own squad", async () => {
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/unclaimed"), {
      mentorUid: "founder",
      mentorName: "Test O.",
    })
  );
});

test("ADOPT: the founder cannot drop the mentor off a claimed squad", async () => {
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/claimed"), { mentorUid: "", mentorName: "" })
  );
});

test("GATE: a founder cannot activate a mentorless squad", async () => {
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertFails(updateDoc(doc(db, "cohorts/unclaimed"), { state: "active" }));
});

test("GATE: a founder CAN activate once the squad has 3 members and a mentor", async () => {
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertSucceeds(updateDoc(doc(db, "cohorts/claimed"), { state: "active" }));
});

test("GATE: a mentored squad under 3 members still cannot activate", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), "cohorts/tiny"),
      fullCohort({ memberUids: ["founder"], mentorUid: "mentorA", mentorName: "Mentor A." })
    );
  });
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertFails(updateDoc(doc(db, "cohorts/tiny"), { state: "active" }));
});

test("GATE: a new squad still cannot be created straight into 'active'", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    addDoc(collection(db, "cohorts"), {
      ...fullCohort({
        founderUid: "granted",
        memberUids: ["granted"],
        memberNames: { granted: "Test O." },
        state: "active",
        mentorUid: "mentorA",
        mentorName: "Mentor A.",
      }),
    })
  );
});

/* ========================================================================= *
 *  D. The track — written by the squad's mentor, read by the squad
 * ========================================================================= */

const writeTrack = (db, cohortId, track) =>
  updateDoc(doc(db, `cohorts/${cohortId}`), { track, trackUpdatedAt: serverTimestamp() });

test("TRACK: the assigned mentor can write the squad's track", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(writeTrack(db, "mentored", [step(1), step(2)]));
});

test("TRACK: the assigned mentor can mark a step done", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(writeTrack(db, "mentored", [step(1, true), step(2)]));
});

test("TRACK: another mentor cannot write it", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(writeTrack(db, "mentored", [step(1)]));
});

test("TRACK: the founder cannot write it", async () => {
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertFails(writeTrack(db, "mentored", [step(1)]));
});

test("TRACK: a member cannot write it", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(writeTrack(db, "mentored", [step(1)]));
});

test("TRACK: a mentor cannot write a track onto a squad nobody has adopted", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(writeTrack(db, "unclaimed", [step(1)]));
});

test("TRACK: more than 20 steps is denied", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  const many = Array.from({ length: 21 }, (_, i) => step(i + 1));
  await assertFails(writeTrack(db, "mentored", many));
});

test("TRACK: the mentor cannot smuggle other fields in with the track", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/mentored"), {
      track: [step(1)],
      trackUpdatedAt: serverTimestamp(),
      name: "Renamed",
    })
  );
});

test("TRACK: the founder's own edits leave the track untouched", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), "cohorts/mentored"),
      fullCohort({ mentorUid: "mentorA", mentorName: "Mentor A.", state: "active", track: [step(1)] })
    );
  });
  const db = testEnv.authenticatedContext("founder").firestore();
  await assertSucceeds(updateDoc(doc(db, "cohorts/mentored"), { mission: "New mission" }));
  await assertFails(updateDoc(doc(db, "cohorts/mentored"), { mission: "New mission", track: [] }));
});

test("TRACK: a new squad cannot be created with a track already on it", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    addDoc(collection(db, "cohorts"), {
      name: "New Squad",
      mission: "Ship something",
      meetingSlot: "Sundays 7pm ET",
      timezone: "America/Toronto",
      state: "forming",
      founderUid: "granted",
      founderName: "Test O.",
      memberUids: ["granted"],
      memberNames: { granted: "Test O." },
      open: true,
      weeklyStreak: 0,
      createdAt: serverTimestamp(),
      track: [step(1)],
    })
  );
});
