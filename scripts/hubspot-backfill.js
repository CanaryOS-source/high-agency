/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS admin
   script, run with plain `node`, like everything else in scripts/. */
// Push every existing application and every approved member into HubSpot.
//
// Run it once after scripts/hubspot-setup.js, and any time you suspect the CRM
// has drifted. It is safe to re-run: each record is an idempotent upsert keyed
// on email, and an application that already carries `hubspotSyncedAt` is only
// re-pushed when you ask for it with --force.
//
// Usage:
//   node scripts/hubspot-backfill.js --dry-run   # print exactly what it would write
//   node scripts/hubspot-backfill.js             # push unsynced applications + all members
//   node scripts/hubspot-backfill.js --force     # also re-push already-synced applications
//
// Needs HUBSPOT_ACCESS_TOKEN and Firebase Admin credentials (both from .env).
//
// PII: the dry run prints applicant answers, because seeing them is the whole
// point of a dry run — it is the one place in this integration that does, and
// only ever to your terminal. Emails are masked even there.
const {
  loadTsModule,
  printPairs,
  requireFirebaseCredentials,
  requireHubspotToken,
} = require("./hubspot-common");

/** ada@example.com → a**@example.com. Enough to recognise a record, not enough
 *  to paste into a scrollback someone else reads. */
function maskEmail(value) {
  const email = String(value ?? "");
  const at = email.indexOf("@");
  if (at < 1) return "(no email)";
  return `${email[0]}**${email.slice(at)}`;
}

function truncate(value, max = 70) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  requireHubspotToken();
  requireFirebaseCredentials();

  const { adminDb } = loadTsModule("app/lib/firebaseAdmin.ts");
  const { applicationToProperties, approvedMemberToProperties } = loadTsModule(
    "app/lib/hubspotMapping.ts"
  );
  const {
    APPLICATIONS,
    pushApplication,
    pushApprovedMember,
    resolveReferralFacts,
  } = loadTsModule("app/lib/hubspotSync.ts");
  const { APPROVED_MEMBERS } = loadTsModule("app/lib/accessGate.ts");

  const db = adminDb();

  console.log(`\nHubSpot backfill${dryRun ? " — DRY RUN, nothing will be written" : ""}`);
  console.log(force ? "mode: --force (already-synced applications included)\n" : "");

  /* -------------------- applications -------------------- */

  const apps = await db.collection(APPLICATIONS).get();
  const appDocs = apps.docs.filter((d) => force || !d.data().hubspotSyncedAt);
  console.log(
    `applications: ${apps.size} on record, ${appDocs.length} to push` +
      `${force ? "" : ` (${apps.size - appDocs.length} already synced)`}`
  );

  let pushedApps = 0;
  const errors = [];

  for (const doc of appDocs) {
    const data = doc.data();
    // Referral attribution costs at most two counter reads and is resolved the
    // same way on a dry run as on a real one, so the printout is what would
    // actually be written rather than a subset of it.
    const app = { ...data, id: doc.id };
    const props = applicationToProperties(app, await resolveReferralFacts(app, db));
    console.log(`\n  ${doc.id}  ${maskEmail(data.email)}`);
    printPairs(
      Object.entries(props).map(([k, v]) => [
        k,
        k === "email" ? maskEmail(v) : truncate(v),
      ]),
      "      "
    );
    // A brand-new contact also gets ha_application_status=new,
    // ha_decision_synced=pending and ha_member_status=applicant; an existing
    // one keeps whatever a human already set. pushApplication decides that.
    if (dryRun) continue;
    try {
      const res = await pushApplication(doc.id, db);
      console.log(
        res.status === "pushed"
          ? `      → pushed as contact ${res.contactId}`
          : `      → skipped (${res.reason})`
      );
      if (res.status === "pushed") pushedApps++;
    } catch (err) {
      console.log(`      → FAILED: ${err.message}`);
      errors.push(`application ${doc.id}: ${err.message}`);
    }
  }

  /* -------------------- approved members -------------------- */

  const members = await db.collection(APPROVED_MEMBERS).get();
  console.log(`\napproved members: ${members.size} on the allowlist`);

  let pushedMembers = 0;

  for (const doc of members.docs) {
    const data = doc.data();
    // hasProfile is resolved for real by the push (Auth lookup); the dry run
    // shows the un-activated shape and says so, rather than doing an Auth call
    // to print a value it isn't going to write.
    const props = approvedMemberToProperties({ ...data, email: doc.id }, false);
    console.log(`\n  ${maskEmail(doc.id)}  role=${data.role ?? "(missing)"}`);
    printPairs(
      Object.entries(props).map(([k, v]) => [
        k,
        k === "email" ? maskEmail(v) : truncate(v),
      ]),
      "      "
    );
    if (dryRun) {
      console.log("      (ha_platform_activated is resolved from Firebase Auth on a real run)");
      continue;
    }
    try {
      const res = await pushApprovedMember(doc.id, db);
      console.log(
        res.status === "pushed"
          ? `      → pushed as contact ${res.contactId}`
          : `      → skipped (${res.reason})`
      );
      if (res.status === "pushed") pushedMembers++;
    } catch (err) {
      console.log(`      → FAILED: ${err.message}`);
      errors.push(`member ${maskEmail(doc.id)}: ${err.message}`);
    }
  }

  /* -------------------- summary -------------------- */

  console.log("\n" + "-".repeat(60));
  if (dryRun) {
    console.log(
      `DRY RUN: would push ${appDocs.length} application(s) and ` +
        `${members.size} member(s). Re-run without --dry-run to apply.`
    );
  } else {
    console.log(
      `pushed ${pushedApps} application(s) and ${pushedMembers} member(s).`
    );
    if (errors.length) {
      console.log(`\n${errors.length} failure(s):`);
      for (const e of errors) console.log(`  - ${e}`);
      console.log("\nRe-run to retry — every operation is idempotent.");
      process.exitCode = 1;
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}\n`);
  process.exit(1);
});
