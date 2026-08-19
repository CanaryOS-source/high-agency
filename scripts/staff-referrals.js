/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS admin
   script, run with plain `node`, like everything else in scripts/. */
// Provision the staff lead-source referral codes.
//
// Five people on the team need a referral link they can put in a post. This
// gives each of them exactly that and NOTHING else: one public counter at
// `referrals/{code}`, plus a private slug → code mapping so a re-run hands back
// the same link instead of minting a second one.
//
// It deliberately does not create an Auth user, a profile, an approvedMembers
// entry or an application. A staff member is not an applicant, and the
// founding-batch gate exists precisely to stop accounts appearing for people
// who were never approved. The model is app/lib/staffReferrals.ts (roster +
// decisions) and app/lib/staffReferralsServer.ts (the reads and writes); this
// file is only the command line over them, which is why the behaviour is
// covered by tests/staffReferrals.test.mts rather than by running it.
//
// Usage:
//   node scripts/staff-referrals.js                     # DRY RUN (default)
//   node scripts/staff-referrals.js --apply             # provision
//   node scripts/staff-referrals.js --json              # machine-readable plan
//   node scripts/staff-referrals.js --apply --json      # machine-readable result
//   node scripts/staff-referrals.js --origin http://localhost:3000
//
// Needs Firebase Admin credentials (same env as the HubSpot scripts and the
// Vercel deployment — see scripts/hubspot-common.js). It does NOT touch
// HubSpot, and nothing here sends an email.
//
// EXIT CODES: 0 = everything consistent. 1 = at least one roster entry is in a
// state this refuses to repair (see "conflicts" in the output). A conflict is
// never overwritten — a code may already be printed in somebody's post, and
// detaching it silently is worse than stopping.
const { loadTsModule, printPairs, requireFirebaseCredentials } = require("./hubspot-common");

const DEFAULT_ORIGIN = "https://high-agency.io";

function parseArgs(argv) {
  const args = { apply: false, json: false, origin: DEFAULT_ORIGIN };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--origin") args.origin = argv[++i] ?? DEFAULT_ORIGIN;
    else if (arg.startsWith("--origin=")) args.origin = arg.slice("--origin=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^https?:\/\/\S+$/.test(args.origin)) {
    throw new Error(`--origin must be an http(s) URL, got "${args.origin}"`);
  }
  return args;
}

/** One aligned status line per roster entry. */
function statusOf(row) {
  if (row.action === "conflict") return `CONFLICT — ${row.reason}`;
  if (row.action === "would-create") return "WOULD CREATE";
  const verb = row.action === "created" ? "CREATED" : "exists ";
  return `${verb}  ${row.code}  (${row.confirmed} referred)`;
}

function printHuman(summary) {
  console.log(
    `\nStaff referral codes — ${summary.staff.length} on the roster` +
      (summary.mode === "apply" ? "" : "\nmode:   DRY RUN — nothing will be written")
  );
  console.log(`origin: ${summary.origin}`);
  console.log(`docs:   ${summary.collections.counters}/{code} + ${summary.collections.mapping}/{slug}\n`);

  printPairs(summary.staff.map((row) => [row.slug, statusOf(row)]));
  console.log("");

  for (const row of summary.staff) {
    if (row.link) console.log(`  ${row.name}\n    ${row.link}\n`);
  }

  if (summary.mode === "dry-run") {
    const toCreate = summary.staff.filter((r) => r.action === "would-create").length;
    const already = summary.staff.filter((r) => r.action === "exists").length;
    console.log(
      `${toCreate} would be created, ${already} already provisioned.` +
        `\nRe-run with --apply to write them.\n`
    );
  }

  if (summary.conflicts.length) {
    console.log(`${summary.conflicts.length} conflict(s) — nothing was overwritten:`);
    for (const c of summary.conflicts) console.log(`  - ${c.slug}: ${c.reason}`);
    console.log(
      "\nResolve each by hand in the Firebase Console, then re-run.\n" +
        "See docs/hubspot-integration.md → Staff referral codes → Recovery.\n"
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFirebaseCredentials();

  const { provisionStaffCodes } = loadTsModule("app/lib/staffReferralsServer.ts");
  const summary = await provisionStaffCodes({
    apply: args.apply,
    origin: args.origin,
  });

  if (args.json) {
    // Only JSON on stdout, so this can be piped straight into jq.
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    printHuman(summary);
  }

  if (!summary.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}\n`);
  process.exit(1);
});
