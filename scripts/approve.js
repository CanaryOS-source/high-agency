// TEMPORARY — founding-batch access gate.
//
// Manage the `approvedMembers` allowlist: the set of emails allowed to get an
// account at all while the founding batch runs. Nothing else lets someone in —
// /login mails a sign-in link only to an address on this list.
//
// OAuth (firebase CLI token) bypasses the security rules, which deny every
// client read and write of this collection. Run `firebase login` as
// info@high-agency.io first.
//
// The doc id is the email, TRIMMED and LOWERCASED — the same convention the
// Firebase Console click-path in QA-HANDOFF.md uses, so entries made either
// way are interchangeable.
//
// Usage:
//   node scripts/approve.js <email> operator                 # add an operator
//   node scripts/approve.js <email> mentor "Josh N."         # add a mentor
//   node scripts/approve.js <email> --remove                 # revoke access
//
// Delete with the rest of the gate (see app/lib/accessGate.ts).
const { getAccessToken } = require("./fb-token");

const PROJECT = "highagency-62e67";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const ROLES = ["operator", "mentor"];

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "Usage:\n" +
      "  node scripts/approve.js <email> operator|mentor [\"Display Name\"]\n" +
      "  node scripts/approve.js <email> --remove"
  );
  process.exit(1);
}

async function main() {
  const [rawEmail, action, name] = process.argv.slice(2);
  if (!rawEmail) usage("an email is required");

  const email = String(rawEmail).trim().toLowerCase();
  if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email)) {
    usage(`"${rawEmail}" doesn't look like an email address`);
  }

  const token = await getAccessToken();
  const url = `${BASE}/approvedMembers/${encodeURIComponent(email)}`;

  if (action === "--remove") {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    console.log(`removed: ${email} is no longer approved.`);
    console.log(
      "note: this does NOT delete an account they already created — it only " +
        "stops new sign-in links and blocks a fresh profile."
    );
    return;
  }

  if (!ROLES.includes(action)) usage("role must be 'operator' or 'mentor'");

  const fields = {
    role: { stringValue: action },
    // Epoch ms. Firestore REST wants integers as strings.
    addedAt: { integerValue: String(Date.now()) },
  };
  if (name) fields.name = { stringValue: String(name).slice(0, 80) };

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

  console.log(`approved: ${email} → ${action}${name ? ` (${name})` : ""}`);
  console.log(
    action === "mentor"
      ? "They can now sign in at /login and will land in the mentor app after setup."
      : "They can now sign in at /login and will go through operator onboarding."
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
