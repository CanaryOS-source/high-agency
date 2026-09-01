// Dev-only: build / repair / inspect the permanent local-QA fixture.
//
// The fixture is two allowlisted accounts and one squad that ties them together:
//   saiamartya19+qa-operator@gmail.com → operator, founder + peer-lead of "QA Squad"
//   saiamartya19+qa-mentor@gmail.com   → mentor of "QA Squad"
//   + two seed operators (seed-dev, seed-lena) so the squad clears
//     COHORT_MIN_TO_ACTIVATE and can be `active`.
//
// Everything is idempotent — run it whenever the fixture looks off. It never
// deletes anything (use scripts/cleanup-test.js <cohortId> for that).
//
// Usage:
//   node scripts/qa-setup.js            # ensure allowlist + squad membership, print status
//   node scripts/qa-setup.js --status   # read-only report
//   node scripts/qa-setup.js --adopt    # also make the QA mentor the squad's mentor
//                                       # (normally do this through the UI:
//                                       #  Mentor → Squads → Needs a mentor → Take it on)
//   node scripts/qa-setup.js --link operator|mentor|<email>
//                                       # mint a sign-in link for that account and print
//                                       # it — no email, no dev-server log needed. Open it
//                                       # in the browser; it lands on /login/verify.
//
// Auth: firebase-tools CLI OAuth token (IAM bypasses the rules) — run
// `firebase login` as info@high-agency.io first. Same mechanism as seed.js.
// The sign-in links themselves come from the dev server: see docs/qa-e2e.md.
const { getAccessToken } = require("./fb-token");

const PROJECT = "highagency-62e67";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`;
const OOB = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:sendOobCode`;
/** Where a minted link lands. Operator = localhost, mentor = 127.0.0.1 so both can be
 *  signed in at once (one Firebase session per origin) — see docs/qa-e2e.md. */
const ORIGINS = { operator: "http://localhost:3000", mentor: "http://127.0.0.1:3000" };

const QA = {
  operator: { email: "saiamartya19+qa-operator@gmail.com", name: "QA Operator" },
  mentor: { email: "saiamartya19+qa-mentor@gmail.com", name: "QA Mentor" },
};
const SQUAD_NAME = "QA Squad";
/** Doc id used only when the squad has to be created from scratch. */
const SQUAD_ID = "qa-squad";
/** Real-content seed profiles (scripts/seed.js) borrowed as extra members. */
const EXTRA_MEMBERS = { "seed-dev": "Dev P.", "seed-lena": "Lena F." };

const s = (v) => ({ stringValue: String(v) });
const arr = (vals) => ({ arrayValue: { values: vals.map(s) } });
const map = (obj) => ({
  mapValue: { fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, s(v)])) },
});
const decode = (v) => {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  if ("mapValue" in v)
    return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  return v;
};
const decodeDoc = (d) =>
  d && d.fields
    ? { id: d.name.split("/").pop(), ...Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, decode(v)])) }
    : null;

async function main() {
  const flags = new Set(process.argv.slice(2));
  const readOnly = flags.has("--status");
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  /* ---- --link: mint a sign-in link (same Identity Toolkit call the app's
   *      /api/access/request makes, minus the email) ---- */
  const linkIdx = process.argv.indexOf("--link");
  if (linkIdx !== -1) {
    const who = process.argv[linkIdx + 1];
    const email = QA[who]?.email ?? who;
    if (!email || !email.includes("@")) throw new Error("--link needs operator, mentor, or an email");
    const origin = ORIGINS[who] ?? ORIGINS.operator;
    const res = await fetch(OOB, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestType: "EMAIL_SIGNIN",
        email,
        returnOobLink: true,
        // Only localhost is an authorized domain in Firebase Auth; the code itself
        // is origin-agnostic, so the printed link below can point at 127.0.0.1.
        continueUrl: "http://localhost:3000/login/verify",
        canHandleCodeInApp: true,
      }),
    });
    if (!res.ok) throw new Error(`sendOobCode: ${res.status} ${await res.text()}`);
    const { oobLink } = await res.json();
    const u = new URL(oobLink);
    const direct = `${origin}/login/verify?apiKey=${u.searchParams.get("apiKey")}&mode=signIn&oobCode=${u.searchParams.get("oobCode")}&lang=en`;
    console.log(`Sign-in link for ${email} (single-use, short-lived).`);
    console.log(`Open it in the browser; it will ask for the email once, then sign you in:\n\n  ${direct}\n`);
    if (who in ORIGINS) console.log(`(${who} → ${origin}; keep the other role on the other origin.)`);
    return;
  }

  async function get(path) {
    const res = await fetch(`${BASE}/${path}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
    return decodeDoc(await res.json());
  }
  async function patch(path, fields, maskPaths) {
    const qs = maskPaths ? "?" + maskPaths.map((p) => `updateMask.fieldPaths=${p}`).join("&") : "";
    const res = await fetch(`${BASE}/${path}${qs}`, { method: "PATCH", headers, body: JSON.stringify({ fields }) });
    if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${await res.text()}`);
    console.log("  wrote", path);
  }
  async function lookupUid(email) {
    const res = await fetch(AUTH, { method: "POST", headers, body: JSON.stringify({ email: [email] }) });
    if (!res.ok) throw new Error(`auth lookup ${email}: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.users?.[0]?.localId ?? null;
  }
  async function findSquad(founderUid) {
    const res = await fetch(`${BASE}:runQuery`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "cohorts" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                { fieldFilter: { field: { fieldPath: "founderUid" }, op: "EQUAL", value: s(founderUid) } },
                { fieldFilter: { field: { fieldPath: "name" }, op: "EQUAL", value: s(SQUAD_NAME) } },
              ],
            },
          },
          limit: 1,
        },
      }),
    });
    if (!res.ok) throw new Error(`runQuery: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return decodeDoc(rows.find((r) => r.document)?.document);
  }

  /* ---- 1. Allowlist ---- */
  console.log("Allowlist (approvedMembers):");
  for (const [role, { email, name }] of Object.entries(QA)) {
    const existing = await get(`approvedMembers/${encodeURIComponent(email)}`);
    if (existing?.role === role) console.log(`  ok    ${email} → ${role}`);
    else if (readOnly) console.log(`  MISSING ${email} (would add as ${role})`);
    else
      await patch(`approvedMembers/${encodeURIComponent(email)}`, {
        role: s(role),
        name: s(name),
        addedAt: { integerValue: String(Date.now()) },
        note: s("Local QA fixture — scripts/qa-setup.js"),
      });
  }

  /* ---- 2. Accounts + profiles ---- */
  console.log("Accounts:");
  const uids = {};
  for (const [role, { email }] of Object.entries(QA)) {
    const uid = await lookupUid(email);
    uids[role] = uid;
    if (!uid) {
      console.log(`  none  ${email} — sign in once at /login to create it (docs/qa-e2e.md)`);
      continue;
    }
    const profile = await get(`profiles/${uid}`);
    console.log(
      `  ${profile ? "ok   " : "NO PROFILE"} ${email}\n        uid ${uid}` +
        (profile ? ` · ${profile.name} · role ${profile.role} · consent ${profile.consentStatus}` : " — finish onboarding in the browser")
    );
    if (profile && profile.role !== role) console.log(`        !! profile role is ${profile.role}, expected ${role}`);
  }
  if (!uids.operator) return console.log("\nNo operator account yet — nothing more to do until it exists.");

  /* ---- 3. The squad ---- */
  console.log(`Squad ("${SQUAD_NAME}"):`);
  let squad = await findSquad(uids.operator);
  if (!squad) {
    if (readOnly) return console.log("  MISSING — run without --status to create it, or create it from Squads → Start one.");
    const founder = await get(`profiles/${uids.operator}`);
    if (!founder) return console.log("  cannot create: the operator has no profile yet.");
    const fields = {
      name: s(SQUAD_NAME),
      mission: s("Permanent QA squad for end-to-end testing of the operator and mentor apps. Not a real venture."),
      tags: arr(["AI"]),
      lookingFor: arr(["Coding"]),
      meetingSlot: s("Sundays 7pm ET"),
      timezone: s(founder.timezone ?? "America/Toronto"),
      state: s("forming"),
      founderUid: s(uids.operator),
      founderName: s(founder.name),
      peerLeadUid: s(uids.operator),
      memberUids: arr([uids.operator]),
      memberNames: map({ [uids.operator]: founder.name }),
      open: { booleanValue: true },
      weeklyStreak: { integerValue: "0" },
      lastRitualWeek: s(""),
      createdAt: { timestampValue: new Date().toISOString() },
    };
    await patch(`cohorts/${SQUAD_ID}`, fields);
    squad = await get(`cohorts/${SQUAD_ID}`);
  }
  console.log(`  id ${squad.id} · state ${squad.state} · members ${squad.memberUids.length} · mentor ${squad.mentorName ?? "—"}`);

  // Membership: founder + the borrowed seed operators.
  const wantUids = [...new Set([...squad.memberUids, ...Object.keys(EXTRA_MEMBERS)])];
  const wantNames = { ...squad.memberNames, ...EXTRA_MEMBERS };
  const membersMissing = wantUids.length !== squad.memberUids.length;
  if (membersMissing) {
    if (readOnly) console.log(`  MISSING members: ${Object.keys(EXTRA_MEMBERS).filter((u) => !squad.memberUids.includes(u)).join(", ")}`);
    else {
      await patch(`cohorts/${squad.id}`, { memberUids: arr(wantUids), memberNames: map(wantNames) }, ["memberUids", "memberNames"]);
      squad.memberUids = wantUids;
    }
  }

  // Mentor: normally adopted through the mentor UI so that path gets exercised.
  if (flags.has("--adopt") && uids.mentor) {
    const mentor = await get(`profiles/${uids.mentor}`);
    if (!mentor) console.log("  cannot adopt: the mentor has no profile yet.");
    else if (squad.mentorUid === uids.mentor) console.log("  ok    already mentored by the QA mentor");
    else {
      const active = squad.memberUids.length >= 3;
      await patch(
        `cohorts/${squad.id}`,
        { mentorUid: s(uids.mentor), mentorName: s(mentor.name), ...(active ? { state: s("active") } : {}) },
        ["mentorUid", "mentorName", ...(active ? ["state"] : [])]
      );
    }
  } else if (!squad.mentorUid) {
    console.log("  no mentor yet → sign in as the QA mentor: Squads → Needs a mentor → Take it on (or rerun with --adopt)");
  } else if (uids.mentor && squad.mentorUid !== uids.mentor) {
    console.log(`  !! mentored by ${squad.mentorName} (${squad.mentorUid}), not the QA mentor`);
  }

  const final = await get(`cohorts/${squad.id}`);
  console.log(`\n${SQUAD_NAME}: /cohorts/${final.id} · ${final.state} · ${final.memberUids.length} members · mentor ${final.mentorName ?? "—"}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
