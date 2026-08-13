/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS admin
   script, run with plain `node`, like everything else in scripts/. */
//
// ============================================================================
// LOCAL VERIFICATION ONLY. THIS IS NOT A PRODUCTION PATH.
// ============================================================================
//
// Drives the whole HubSpot integration end to end against the local stand-in
// (scripts/hubspot-mock-server.js) plus REAL Firestore, and asserts the things
// that actually matter — including the decline guardrail that protects
// hand-added mentors. It exists because there is no portal token yet, so this is
// the only way to know the sync works before it ships.
//
// It writes to Firestore and then removes exactly what it wrote. Every document
// it creates is prefixed E2E_HUBSPOT_ / e2e-hubspot- so it is obviously test
// data at a glance in the Console, and cleanup is verified rather than assumed:
// if a single disposable document survives, the run FAILS.
//
// Usage:
//   node scripts/hubspot-e2e.js                 # boots the mock on :4300
//   node scripts/hubspot-e2e.js --port 4399
//   node scripts/hubspot-e2e.js --no-boot       # use an already-running mock
//   node scripts/hubspot-e2e.js --keep-server   # leave it up to poke at after
//
// Firestore target:
//   • live by default — needs FIREBASE_SERVICE_ACCOUNT / FIREBASE_CLIENT_EMAIL +
//     FIREBASE_PRIVATE_KEY / GOOGLE_APPLICATION_CREDENTIALS, same as the other
//     scripts. The preflight proves connectivity BEFORE anything is written.
//   • against the emulator when FIRESTORE_EMULATOR_HOST is set, e.g.
//       firebase emulators:exec --only firestore --project highagency-62e67 \
//         "node scripts/hubspot-e2e.js"
//     Same code path; nothing about the assertions changes.
const { spawn } = require("child_process");
const path = require("path");
const { loadEnv, loadTsModule } = require("./hubspot-common");

const ROOT = path.join(__dirname, "..");
const MOCK = path.join(ROOT, "scripts", "hubspot-mock-server.js");
const MOCK_TOKEN = "mock-token";

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function value(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.split("=")[1] : fallback;
}

const PORT = Number(value("port", "4300"));
const BOOT = !flag("no-boot");
const KEEP = flag("keep-server");
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------ */
/* Result tracking                                                     */
/* ------------------------------------------------------------------ */

const results = [];
let currentStep = "(none)";

function step(name) {
  currentStep = name;
  console.log(`\n── ${name}`);
}

/** One assertion. Never throws: a failure is recorded and the run continues, so
 *  a single wrong value doesn't hide the other twenty results. */
function check(label, condition, detail) {
  const ok = Boolean(condition);
  results.push({ step: currentStep, label, ok, detail: ok ? "" : detail ?? "" });
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  return ok;
}

function equal(label, actual, expected) {
  return check(
    label,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

/* ------------------------------------------------------------------ */
/* Mock server plumbing                                                */
/* ------------------------------------------------------------------ */

let child = null;

function bootMock() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [MOCK, "--port", String(PORT)], {
      cwd: ROOT,
      env: { ...process.env, HUBSPOT_MOCK_TOKEN: MOCK_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(
      () => reject(new Error("mock server did not start within 10s")),
      10_000
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[mock] ${chunk}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(new Error(`mock server exited with code ${code}`));
      }
    });
  });
}

function stopMock() {
  if (child && !child.killed) child.kill("SIGTERM");
}

async function control(method, route, body) {
  const res = await fetch(`${BASE}/__control${route}`, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`control ${method} ${route} → ${res.status} ${text.slice(0, 200)}`);
  }
  return json;
}

async function mockContacts() {
  const { contacts } = await control("GET", "/contacts");
  const byEmail = new Map();
  for (const contact of contacts) byEmail.set(contact.email, contact);
  return byEmail;
}

/* ------------------------------------------------------------------ */
/* Disposable test data                                                */
/* ------------------------------------------------------------------ */

// One id per run, so two runs (or a run against live data) can never collide,
// and so anything left behind by a crashed run is traceable to when it happened.
const RUN = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${process.pid}`;
const DOC_PREFIX = `E2E_HUBSPOT_${RUN}`;
/** .invalid is reserved by RFC 2606 and can never receive mail. Belt and braces
 *  on top of the approval email being off. */
const emailFor = (who) => `e2e-hubspot-${RUN}-${who}@example.invalid`.toLowerCase();

const APPLICANT_FULL = emailFor("full");
const APPLICANT_LEGACY = emailFor("legacy");
const HAND_ADDED = emailFor("handmentor");

/** Everything this run created, so cleanup is a fact rather than a hope. */
const created = [];
function track(ref) {
  created.push(ref);
  return ref;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  loadEnv();

  // The client reads these at call time, so setting them here is enough.
  process.env.HUBSPOT_BASE_URL = BASE;
  process.env.HUBSPOT_ACCESS_TOKEN = MOCK_TOKEN;
  // Belt and braces: a machine with the approval email switched on must not be
  // able to mail anybody during a test run.
  delete process.env.HUBSPOT_APPROVAL_EMAIL;

  const { adminDb } = loadTsModule("app/lib/firebaseAdmin.ts");
  const { FieldValue, Timestamp } = require("firebase-admin/firestore");
  const hubspot = loadTsModule("app/lib/hubspot.ts");
  const { HA_PROPERTIES, P, APPLICATION_STATUS, DECISION_SYNCED, MEMBER_ROLE, MEMBER_STATUS, YES_NO } =
    loadTsModule("app/lib/hubspotSchema.ts");
  const { APPLICATIONS, reconcile, HUBSPOT_SOURCE } = loadTsModule(
    "app/lib/hubspotSync.ts"
  );
  const { APPROVED_MEMBERS } = loadTsModule("app/lib/accessGate.ts");

  const db = adminDb();
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  const projectId =
    process.env.FIREBASE_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
    "highagency-62e67";

  console.log("HubSpot end-to-end verification (local mock + Firestore)");
  console.log(`  mock:      ${BASE}${BOOT ? " (booting)" : " (assumed running)"}`);
  console.log(
    `  firestore: ${emulator ? `EMULATOR ${emulator}` : "LIVE"} — project ${projectId}`
  );
  console.log(`  run id:    ${RUN}`);
  console.log(`  test docs: ${DOC_PREFIX}*, ${emailFor("*")}`);

  /* ---------------- step 0: preflight ---------------- */

  step("0. Preflight");
  try {
    // A read, not a write: prove we can reach Firestore before touching it.
    await db.collection(APPLICATIONS).limit(1).get();
    check("Firestore is reachable", true);
  } catch (err) {
    console.error(
      `\nerror: cannot reach Firestore — nothing was written.\n\n  ${err.message}\n\n` +
        "  Fix ONE of these, then re-run:\n" +
        "    • re-authorise local credentials:  gcloud auth application-default login\n" +
        "    • or export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json\n" +
        "    • or put FIREBASE_SERVICE_ACCOUNT=... in .env\n" +
        "    • or run against the emulator:\n" +
        "        firebase emulators:exec --only firestore --project " +
        projectId +
        ' "node scripts/hubspot-e2e.js"\n'
    );
    process.exit(1);
  }

  if (BOOT) await bootMock();
  const health = await control("GET", "/health");
  check("mock server is up", health.ok === true);

  /* ---------------- step 1: auth path ---------------- */

  step("1. Bearer token is enforced");
  const badAuth = await fetch(`${BASE}/crm/v3/properties/contacts?archived=false`, {
    headers: { Authorization: "Bearer wrong-token" },
  });
  equal("a wrong bearer is rejected", badAuth.status, 401);
  const goodAuth = await fetch(`${BASE}/crm/v3/properties/contacts?archived=false`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });
  equal("the right bearer is accepted", goodAuth.status, 200);

  /* ---------------- step 2: provisioning ---------------- */

  step("2. Property provisioning is idempotent");
  const first = await hubspot.ensureProperties(HA_PROPERTIES);
  equal("first run creates the group", first.createdGroup, true);
  equal("first run creates every property", first.created.length, HA_PROPERTIES.length);
  equal("first run skips nothing", first.skipped.length, 0);

  const second = await hubspot.ensureProperties(HA_PROPERTIES);
  equal("second run creates no group", second.createdGroup, false);
  equal("second run creates nothing", second.created.length, 0);
  equal("second run skips everything", second.skipped.length, HA_PROPERTIES.length);

  // Force the conflict path: an archived property still owns its name in HubSpot
  // but vanishes from the archived=false listing, so ensureProperties will POST
  // it and must read the 409 as "already exists" rather than aborting.
  await control("POST", "/archive-property", { name: P.operatorId });
  const third = await hubspot.ensureProperties(HA_PROPERTIES);
  equal("a 409 conflict counts as skipped, not fatal", third.created.length, 0);
  equal("still skips every property", third.skipped.length, HA_PROPERTIES.length);

  /* ---------------- step 2b: search paging ---------------- */

  // The client's pagination loop is otherwise never exercised: batch 1 has fewer
  // decided contacts than one page holds, so a broken cursor would go unnoticed
  // until the batch grew. Seed past the 100-per-page limit and prove the loop
  // walks every page. These contacts live only in the mock's memory and are
  // deliberately inert (in_review is a status the sync never acts on).
  step("2b. Search pagination walks every page");
  const PAGE_TAG = "E2E-PAGING";
  const SEEDED = 101;
  for (let i = 0; i < SEEDED; i++) {
    await control("POST", "/contacts", {
      email: `e2e-hubspot-${RUN}-page${i}@example.invalid`,
      properties: {
        [P.operatorId]: PAGE_TAG,
        [P.applicationStatus]: APPLICATION_STATUS.inReview,
      },
    });
  }
  const paged = await hubspot.searchAllContacts({
    filterGroups: [
      { filters: [{ propertyName: P.operatorId, operator: "EQ", value: PAGE_TAG }] },
    ],
    properties: ["email", P.operatorId],
  });
  equal(`all ${SEEDED} contacts came back across pages`, paged.contacts.length, SEEDED);
  equal("the result was not truncated", paged.truncated, false);
  equal(
    "every contact is distinct (the cursor advanced)",
    new Set(paged.contacts.map((c) => c.id)).size,
    SEEDED
  );

  /* ---------------- step 3: seed Firestore ---------------- */

  step("3. Seed disposable Firestore documents");

  // Snapshot which application docs are unsynced BEFORE reconcile touches them.
  // reconcile() pushes every unsynced application, which on live data means it
  // will stamp real documents — those stamps get reverted in cleanup so the run
  // genuinely leaves Firestore as it found it.
  const preexistingUnsynced = new Set();
  const allAppsBefore = await db.collection(APPLICATIONS).get();
  for (const doc of allAppsBefore.docs) {
    if (!doc.data().hubspotSyncedAt) preexistingUnsynced.add(doc.id);
  }
  console.log(
    `   note: ${preexistingUnsynced.size} pre-existing unsynced application(s) will be ` +
      `pushed and un-stamped again in cleanup`
  );

  const fullRef = track(db.collection(APPLICATIONS).doc(`${DOC_PREFIX}_full`));
  await fullRef.set({
    name: "Ada Lovelace",
    email: APPLICANT_FULL,
    age: "16",
    social: "@adabuilds",
    building: "A notation engine for machines",
    boldest: "Cold-emailed forty professors and got three replies",
    impact: "Make computation legible to people who were told they can't",
    problem: "Nobody can read what machines actually do",
    plan: "Ship the engine and find ten real users",
    opId: "HA-901",
    queuePos: 901,
    source: "waitlist",
    createdAt: Timestamp.now(),
  });

  // Exactly the shape of HA-049/050/051: no social/impact/problem/plan at all.
  const legacyRef = track(db.collection(APPLICATIONS).doc(`${DOC_PREFIX}_legacy`));
  await legacyRef.set({
    name: "Grace Hopper",
    email: APPLICANT_LEGACY,
    age: "17",
    building: "A compiler that reads like English",
    boldest: "Shipped it before anyone approved it",
    opId: "HA-902",
    queuePos: 902,
    source: "waitlist",
    createdAt: Timestamp.now(),
  });

  // A mentor "typed in by hand" — no source marker. This is the document the
  // guardrail exists to protect.
  const handRef = track(db.collection(APPROVED_MEMBERS).doc(HAND_ADDED));
  await handRef.set({
    role: "mentor",
    name: "Hand Added",
    addedAt: Date.now(),
    note: "e2e: stands in for josh@high-agency.io",
  });

  check("seeded 2 applications + 1 hand-added allowlist entry", created.length === 3);

  /* ---------------- step 4: push ---------------- */

  step("4. reconcile() pushes Firestore → HubSpot");
  const push = await reconcile(db);
  check(
    "reconcile ran without per-record errors",
    push.errors.length === 0,
    JSON.stringify(push.errors)
  );
  check(
    `pushed at least our 2 applications (reported ${push.pushedApplications})`,
    push.pushedApplications >= 2
  );
  check(
    `pushed at least our 1 member (reported ${push.pushedMembers})`,
    push.pushedMembers >= 1
  );

  let contacts = await mockContacts();
  const full = contacts.get(APPLICANT_FULL);
  const legacy = contacts.get(APPLICANT_LEGACY);
  const hand = contacts.get(HAND_ADDED);

  if (check("the full application became a contact", Boolean(full))) {
    equal("  firstname", full.properties.firstname, "Ada");
    equal("  lastname", full.properties.lastname, "Lovelace");
    equal("  ha_operator_id", full.properties[P.operatorId], "HA-901");
    equal("  ha_queue_position", full.properties[P.queuePosition], "901");
    equal("  ha_age", full.properties[P.age], "16");
    equal("  ha_social", full.properties[P.social], "@adabuilds");
    equal(
      "  ha_plan",
      full.properties[P.plan],
      "Ship the engine and find ten real users"
    );
    equal("  ha_firestore_app_id", full.properties[P.firestoreAppId], fullRef.id);
    equal(
      "  ha_application_status starts at new",
      full.properties[P.applicationStatus],
      APPLICATION_STATUS.new
    );
    equal(
      "  ha_decision_synced starts pending",
      full.properties[P.decisionSynced],
      DECISION_SYNCED.pending
    );
    equal(
      "  ha_member_status starts applicant",
      full.properties[P.memberStatus],
      MEMBER_STATUS.applicant
    );
    check("  ha_applied_at is a date", /^\d{4}-\d{2}-\d{2}$/.test(full.properties[P.appliedAt] ?? ""));
  }

  if (check("the LEGACY application became a contact", Boolean(legacy))) {
    equal("  ha_building still maps", legacy.properties[P.building], "A compiler that reads like English");
    for (const [label, prop] of [
      ["ha_social", P.social],
      ["ha_impact", P.impact],
      ["ha_problem", P.problem],
      ["ha_plan", P.plan],
    ]) {
      check(
        `  ${label} is absent, not "undefined"`,
        legacy.properties[prop] === undefined,
        `got ${JSON.stringify(legacy.properties[prop])}`
      );
    }
    check(
      "  no property anywhere is the string \"undefined\"",
      !Object.values(legacy.properties).includes("undefined")
    );
  }

  if (check("the hand-added member became a contact", Boolean(hand))) {
    equal("  ha_member_role", hand.properties[P.memberRole], MEMBER_ROLE.mentor);
    equal(
      "  ha_member_status",
      hand.properties[P.memberStatus],
      MEMBER_STATUS.approvedMember
    );
    equal("  ha_platform_activated", hand.properties[P.platformActivated], YES_NO.no);
    equal(
      "  already-approved member is marked synced",
      hand.properties[P.decisionSynced],
      DECISION_SYNCED.synced
    );
  }

  const fullAfterPush = (await fullRef.get()).data() ?? {};
  check("the application doc was stamped hubspotContactId", Boolean(fullAfterPush.hubspotContactId));
  check("the application doc was stamped hubspotSyncedAt", Boolean(fullAfterPush.hubspotSyncedAt));

  /* ---------------- step 5: approve ---------------- */

  step("5. An APPROVE in HubSpot reaches Firestore");
  await control("POST", "/decide", {
    email: APPLICANT_FULL,
    status: "approved",
    role: MEMBER_ROLE.operator,
  });

  const approveRun = await reconcile(db);
  check(
    "reconcile ran without per-record errors",
    approveRun.errors.length === 0,
    JSON.stringify(approveRun.errors)
  );
  equal("exactly one approval applied", approveRun.approvals, 1);

  const memberRef = track(db.collection(APPROVED_MEMBERS).doc(APPLICANT_FULL));
  const memberSnap = await memberRef.get();
  if (check("approvedMembers/{email} now exists", memberSnap.exists)) {
    const member = memberSnap.data();
    equal("  role", member.role, "operator");
    equal("  source marker", member.source, HUBSPOT_SOURCE);
    check("  addedAt is epoch ms", typeof member.addedAt === "number");
  }

  const appAfterApprove = (await fullRef.get()).data() ?? {};
  equal("the application doc is marked approved", appAfterApprove.status, "approved");
  check("the application doc has decidedAt", Boolean(appAfterApprove.decidedAt));

  contacts = await mockContacts();
  const fullAfter = contacts.get(APPLICANT_FULL);
  equal(
    "the contact is marked synced",
    fullAfter?.properties[P.decisionSynced],
    DECISION_SYNCED.synced
  );
  equal(
    "the contact is an approved member",
    fullAfter?.properties[P.memberStatus],
    MEMBER_STATUS.approvedMember
  );
  equal("no warning was written", fullAfter?.properties[P.syncNote], "");

  // The decision must not be applied twice.
  const idempotentRun = await reconcile(db);
  equal("a second reconcile re-applies nothing", idempotentRun.approvals, 0);

  /* ---------------- step 6: decline ---------------- */

  step("6. A DECLINE in HubSpot reaches Firestore");
  await control("POST", "/decide", {
    email: APPLICANT_LEGACY,
    status: "declined",
    declineReason: "e2e: not a fit for batch 1",
  });

  const declineRun = await reconcile(db);
  check(
    "reconcile ran without per-record errors",
    declineRun.errors.length === 0,
    JSON.stringify(declineRun.errors)
  );
  equal("exactly one decline applied", declineRun.declines, 1);

  const legacyAfter = (await legacyRef.get()).data() ?? {};
  equal("the application doc is marked declined", legacyAfter.status, "declined");
  equal("the decline reason was recorded", legacyAfter.declineReason, "e2e: not a fit for batch 1");
  check("the application doc has decidedAt", Boolean(legacyAfter.decidedAt));
  check(
    "a decline created no allowlist entry",
    !(await db.collection(APPROVED_MEMBERS).doc(APPLICANT_LEGACY).get()).exists
  );

  /* ---------------- step 7: the guardrail ---------------- */

  step("7. GUARDRAIL: a decline cannot destroy a hand-added allowlist entry");
  // resetSynced mirrors the one documented case where staff edit the marker:
  // "to re-run a decision, set Decision Synced → Pending".
  await control("POST", "/decide", {
    email: HAND_ADDED,
    status: "declined",
    resetSynced: true,
  });

  const guardRun = await reconcile(db);
  equal("the decline was processed", guardRun.declines, 1);

  const handAfter = await handRef.get();
  if (check("the hand-added entry SURVIVED", handAfter.exists)) {
    const data = handAfter.data();
    equal("  role is untouched", data.role, "mentor");
    equal("  note is untouched", data.note, "e2e: stands in for josh@high-agency.io");
    check("  it was never claimed by the CRM", data.source === undefined, `source=${data.source}`);
  }

  contacts = await mockContacts();
  const handNote = contacts.get(HAND_ADDED)?.properties[P.syncNote] ?? "";
  check(
    "a note explaining it was written back to the contact",
    /added by hand/.test(handNote),
    `ha_sync_note=${JSON.stringify(handNote)}`
  );

  /* ---------------- step 8: cleanup ---------------- */

  step("8. Cleanup leaves Firestore as it was found");
  await cleanup(db, FieldValue, {
    APPLICATIONS,
    preexistingUnsynced,
  });
}

/**
 * Remove every disposable document, then PROVE it. Also reverts the push stamps
 * reconcile() wrote onto documents this run did not create — without that, a run
 * against live data would leave the three real applications altered, and
 * "leaves Firestore exactly as it found it" would be a false claim.
 */
async function cleanup(db, FieldValue, ctx) {
  let restored = 0;
  const snap = await db.collection(ctx.APPLICATIONS).get();
  for (const doc of snap.docs) {
    if (!ctx.preexistingUnsynced.has(doc.id)) continue;
    if (created.some((ref) => ref.id === doc.id)) continue; // ours, deleted below
    if (!doc.data().hubspotSyncedAt) continue;
    await doc.ref.update({
      hubspotSyncedAt: FieldValue.delete(),
      hubspotContactId: FieldValue.delete(),
    });
    restored++;
  }
  check(
    `un-stamped ${restored} pre-existing application(s) touched by the push`,
    restored === ctx.preexistingUnsynced.size,
    `expected ${ctx.preexistingUnsynced.size}, un-stamped ${restored}`
  );

  for (const ref of created) {
    await ref.delete().catch(() => {});
  }

  let survivors = [];
  for (const ref of created) {
    if ((await ref.get()).exists) survivors.push(`${ref.parent.id}/${ref.id}`);
  }
  check(
    `all ${created.length} disposable document(s) deleted`,
    survivors.length === 0,
    `SURVIVED: ${survivors.join(", ")}`
  );

  // Nothing this run created may be left anywhere, under any name.
  const leftoverMembers = (await db.collection("approvedMembers").get()).docs.filter((d) =>
    d.id.includes(`e2e-hubspot-${RUN}`)
  );
  const leftoverApps = (await db.collection(ctx.APPLICATIONS).get()).docs.filter((d) =>
    d.id.startsWith(DOC_PREFIX)
  );
  check(
    "no e2e document remains in either collection",
    leftoverMembers.length === 0 && leftoverApps.length === 0,
    `${leftoverApps.map((d) => d.id).join(", ")} ${leftoverMembers.map((d) => d.id).join(", ")}`
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

function summarise() {
  const failed = results.filter((r) => !r.ok);
  const bySteps = new Map();
  for (const r of results) {
    const entry = bySteps.get(r.step) ?? { pass: 0, fail: 0 };
    entry[r.ok ? "pass" : "fail"]++;
    bySteps.set(r.step, entry);
  }

  console.log(`\n${"=".repeat(66)}`);
  console.log("SUMMARY");
  for (const [name, { pass, fail }] of bySteps) {
    console.log(`  ${fail ? "FAIL" : "PASS"}  ${name}  (${pass} passed, ${fail} failed)`);
  }
  console.log("-".repeat(66));
  console.log(
    `  ${results.length - failed.length}/${results.length} assertions passed — ` +
      `${failed.length ? "FAILED" : "ALL PASS"}`
  );
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - [${f.step}] ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  console.log(`${"=".repeat(66)}\n`);
  return failed.length === 0;
}

main()
  .then(() => {
    const ok = summarise();
    if (!KEEP) stopMock();
    else console.log(`mock left running at ${BASE} (--keep-server)`);
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`\nerror during "${currentStep}": ${err.message}`);
    console.error(err.stack?.split("\n").slice(1, 4).join("\n") ?? "");
    // A crash mid-run must not leave test documents behind. Best effort, and the
    // exit code is non-zero either way.
    Promise.all(created.map((ref) => ref.delete().catch(() => {})))
      .then(() => {
        if (created.length) {
          console.error(
            `attempted cleanup of ${created.length} disposable document(s) — VERIFY MANUALLY: ${DOC_PREFIX}*`
          );
        }
      })
      .finally(() => {
        summarise();
        stopMock();
        process.exit(1);
      });
  });
