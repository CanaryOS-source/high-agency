/**
 * Firestore security-rules tests for parental-consent enforcement (and the
 * pre-existing write paths it guards). Run against the Firestore emulator:
 *
 *   npm run test:rules
 *
 * which wraps `node --test` in `firebase emulators:exec --only firestore`, so
 * the emulator is up and FIRESTORE_EMULATOR_HOST is set for us.
 *
 * The core claim under test: a minor whose consentStatus is "pending" is
 * DENIED — at the rules level — from every community write (create cohort,
 * apply, submit milestone, post build log, tick the ritual), while a "granted"
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
    xp: 0,
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
    peerLeadUid: "founder",
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

/** A rules-valid workshop owned by mentorA. */
function workshop(overrides = {}) {
  return {
    title: "The Cold Ask",
    mentorName: "Mentor A.",
    mentorUid: "mentorA",
    description: "",
    kind: "workshop",
    startsAt: Timestamp.fromMillis(Date.now() + 86400000),
    durationMins: 60,
    meetLink: "https://meet.example/x",
    capacity: 3,
    enrolledUids: [],
    open: true,
    levelGate: 0,
    milestoneId: 0,
    recordingUrl: "",
    ...overrides,
  };
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
      peerLeadUid: "founder",
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
      peerLeadUid: "founder",
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
    // Sold out.
    await setDoc(
      doc(db, "workshops/full"),
      workshop({ capacity: 2, enrolledUids: ["a", "b"] })
    );
    // Pre-capacity legacy doc: no mentorUid, no capacity, no roster.
    await setDoc(doc(db, "workshops/legacy"), {
      title: "Old session",
      mentorName: "Josh N.",
      kind: "workshop",
      startsAt: Timestamp.now(),
      durationMins: 60,
      open: true,
      levelGate: 0,
      milestoneId: 0,
    });
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
    peerLeadUid: uid,
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

function submitMilestone(db, uid) {
  return setDoc(doc(db, `cohorts/squad/submissions/1_${uid}`), {
    uid,
    name: "Test O.",
    milestoneId: 1,
    evidenceUrl: "https://example.com/proof",
    status: "submitted",
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

test("pending minor is denied: create milestone submission", async () => {
  const db = testEnv.authenticatedContext("minor").firestore();
  await assertFails(submitMilestone(db, "minor"));
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

test("granted operator is allowed: create milestone submission", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(submitMilestone(db, "granted"));
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
 *  A. Workshops — capacity + ownership
 * ========================================================================= */

const enroll = (db, id, uid) =>
  updateDoc(doc(db, `workshops/${id}`), { enrolledUids: arrayUnion(uid) });

test("operator can take a seat while the workshop is under capacity", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(enroll(db, "owned", "granted"));
});

test("CAPACITY: enrolling into a full workshop is denied", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(enroll(db, "full", "granted"));
});

test("CAPACITY: the seat that tips a workshop over the cap is denied", async () => {
  // capacity 3, one seat gone: two more fit, the third does not.
  const a = testEnv.authenticatedContext("granted").firestore();
  const b = testEnv.authenticatedContext("founder").firestore();
  const c = testEnv.authenticatedContext("minor").firestore();
  await assertSucceeds(enroll(a, "owned", "granted"));
  await assertSucceeds(enroll(b, "owned", "founder"));
  await assertFails(enroll(c, "owned", "minor"));
});

test("SELF-ENROLL: an operator cannot enroll somebody else", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(enroll(db, "owned", "founder"));
});

test("SELF-ENROLL: an operator cannot drop an existing enrollee", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  // Swap the seated uid for their own — same list size, so only hasAll() and
  // the size arithmetic together catch it.
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), { enrolledUids: ["granted"] })
  );
});

test("SELF-ENROLL: an operator cannot smuggle a second uid in", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), {
      enrolledUids: ["someone", "granted", "founder"],
    })
  );
});

test("SELF-ENROLL: an operator cannot change anything else on the way in", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), {
      enrolledUids: arrayUnion("granted"),
      capacity: 200,
    })
  );
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), {
      enrolledUids: arrayUnion("granted"),
      title: "Hijacked",
    })
  );
});

test("SELF-ENROLL: enrolling twice is denied (no double seat)", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(enroll(db, "owned", "granted"));
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), {
      enrolledUids: ["someone", "granted", "granted"],
    })
  );
});

test("LEGACY: a pre-capacity workshop stays enrollable (uncapped, not broken)", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertSucceeds(enroll(db, "legacy", "granted"));
});

test("OWNERSHIP: a mentor may edit their own workshop", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(
    updateDoc(doc(db, "workshops/owned"), { title: "The Cold Ask, v2" })
  );
});

test("OWNERSHIP: a mentor may NOT edit another mentor's workshop", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), { title: "Mine now" })
  );
});

test("OWNERSHIP: a mentor may NOT delete another mentor's workshop", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(deleteDoc(doc(db, "workshops/owned")));
});

test("OWNERSHIP: a mentor may delete their own workshop", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(deleteDoc(doc(db, "workshops/owned")));
});

test("OWNERSHIP: nobody may edit an unowned legacy workshop", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(updateDoc(doc(db, "workshops/legacy"), { title: "Adopted" }));
});

test("OWNERSHIP: mentorUid is immutable — ownership can't be handed off", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(
    updateDoc(doc(db, "workshops/owned"), { mentorUid: "mentorB" })
  );
});

test("CREATE: a mentor must stamp themselves as owner", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(addDoc(collection(db, "workshops"), workshop()));
  await assertFails(
    addDoc(collection(db, "workshops"), workshop({ mentorUid: "mentorB" }))
  );
});

test("CREATE: a workshop without a capacity is denied", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  const noCapacity = workshop();
  delete noCapacity.capacity;
  await assertFails(addDoc(collection(db, "workshops"), noCapacity));
});

test("CREATE: capacity outside 2–200 is denied", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(addDoc(collection(db, "workshops"), workshop({ capacity: 1 })));
  await assertFails(addDoc(collection(db, "workshops"), workshop({ capacity: 500 })));
});

test("CREATE: a mentor cannot pre-fill the roster", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(
    addDoc(collection(db, "workshops"), workshop({ enrolledUids: ["granted"] }))
  );
});

test("CREATE: an operator still cannot author a workshop", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(
    addDoc(collection(db, "workshops"), workshop({ mentorUid: "granted" }))
  );
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

test("CONFIRM: the assigned mentor can put a time on a request", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertSucceeds(confirm(db));
});

test("CONFIRM: another mentor cannot confirm it", async () => {
  const db = testEnv.authenticatedContext("mentorB").firestore();
  await assertFails(confirm(db));
});

test("CONFIRM: a squad member cannot confirm their own request", async () => {
  const db = testEnv.authenticatedContext("granted").firestore();
  await assertFails(confirm(db));
});

test("CONFIRM: the mentor cannot rewrite the request itself", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/mentored/checkIns/req1"), {
      status: "confirmed",
      startsAt: Timestamp.now(),
      durationMins: 30,
      meetLink: "",
      note: "rewritten",
    })
  );
});

test("CONFIRM: an already-confirmed check-in cannot be re-confirmed", async () => {
  const db = testEnv.authenticatedContext("mentorA").firestore();
  await assertFails(
    updateDoc(doc(db, "cohorts/mentored/checkIns/done1"), {
      status: "confirmed",
      startsAt: Timestamp.now(),
      durationMins: 90,
      meetLink: "https://meet.example/moved",
    })
  );
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
        peerLeadUid: "granted",
        memberUids: ["granted"],
        memberNames: { granted: "Test O." },
        state: "active",
        mentorUid: "mentorA",
        mentorName: "Mentor A.",
      }),
    })
  );
});
