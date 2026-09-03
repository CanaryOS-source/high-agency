// Shared plumbing for the local admin scripts that talk to the app's own
// TypeScript modules — scripts/hubspot-*.js and scripts/staff-referrals.js.
// Local admin tooling only.
//
// Three jobs:
//   1. Load .env / .env.local without a dependency (nothing in this repo has
//      dotenv, and this integration adds no packages).
//   2. Load the property registry from app/lib/hubspotSchema.ts, so the scripts
//      and the app cannot disagree about what a property is called. Node ≥22.18
//      strips types on require; older Node falls back to the tsx devDependency.
//   3. Refuse to run, loudly and specifically, when a required secret is
//      missing — which is the state today for HUBSPOT_ACCESS_TOKEN.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------------ */
/* .env                                                                */
/* ------------------------------------------------------------------ */

// Minimal KEY=VALUE reader: handles quotes, `export ` prefixes, comments and
// blank lines. Deliberately does NOT expand variables — a service-account JSON
// containing a "$" must survive verbatim.
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Load .env and .env.local into process.env. Never overwrites a var that is
 *  already set, so `HUBSPOT_ACCESS_TOKEN=... node scripts/...` wins. */
function loadEnv() {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnv(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Schema registry                                                     */
/* ------------------------------------------------------------------ */

let tsxRegistered = false;

/**
 * Register tsx's require hook so these CommonJS scripts can require the app's
 * own TypeScript modules directly.
 *
 * Why the hook and not Node's built-in type stripping: Node strips types fine,
 * but it then applies strict ESM resolution, which rejects the extensionless
 * `import "./hubspotSchema"` that every file in app/lib uses. tsx is already a
 * devDependency (the test suites run on it), so this adds nothing to install.
 */
function registerTsx() {
  if (tsxRegistered) return;
  try {
    require("tsx/cjs");
    tsxRegistered = true;
  } catch {
    fail(
      "the tsx devDependency isn't installed, so app/lib/*.ts can't be loaded.\n" +
        "  Run `npm install` in the repo root first."
    );
  }
}

/**
 * Load a TypeScript module from the app. This is how the scripts stay honest:
 * they run the SAME mapping and sync code the deployed app runs, instead of a
 * second copy that drifts.
 */
function loadTsModule(relPath) {
  registerTsx();
  return require(path.join(ROOT, relPath));
}

/** The property registry — single source of truth for every `ha_` property. */
function loadSchema() {
  return loadTsModule("app/lib/hubspotSchema.ts");
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

function fail(message) {
  console.error(`\nerror: ${message}\n`);
  process.exit(1);
}

/**
 * The portal token. We do not have one yet — private apps need a Super Admin
 * and the ask is out to Josh — so this message has to say what to do, not just
 * that something is missing.
 */
function requireHubspotToken() {
  loadEnv();
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    fail(
      "HUBSPOT_ACCESS_TOKEN is not set, so there is nothing to talk to.\n\n" +
        "  Get one from the High Agency portal (2410150):\n" +
        "    Settings → Integrations → Private Apps → Create a private app\n" +
        "    Scopes needed: crm.objects.contacts.read, crm.objects.contacts.write,\n" +
        "                   crm.schemas.contacts.read, crm.schemas.contacts.write\n" +
        "  Creating one requires Super Admin in that portal.\n\n" +
        "  Then either put it in .env as\n" +
        "    HUBSPOT_ACCESS_TOKEN=pat-na1-...\n" +
        "  or pass it inline:\n" +
        "    HUBSPOT_ACCESS_TOKEN=pat-na1-... node scripts/<script>.js"
    );
  }
  return token;
}

/**
 * Admin-SDK credentials for the scripts that read Firestore. Accepts either
 * env shape firebaseAdmin.ts accepts, or GOOGLE_APPLICATION_CREDENTIALS.
 */
function requireFirebaseCredentials() {
  loadEnv();
  const hasServiceAccount = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);
  const hasSplit = Boolean(
    process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
  );
  const hasAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  // Fourth tier, same as firebaseAdmin.ts: against the emulator the Admin SDK
  // needs no credentials at all. Keeps the scripts exercisable locally.
  const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  if (!hasServiceAccount && !hasSplit && !hasAdc && !hasEmulator) {
    fail(
      "no Firebase Admin credentials found, so Firestore can't be read.\n\n" +
        "  Put ONE of these in .env:\n" +
        "    FIREBASE_SERVICE_ACCOUNT={...the whole service-account JSON...}\n" +
        "    FIREBASE_CLIENT_EMAIL=... and FIREBASE_PRIVATE_KEY=...\n" +
        "    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json\n\n" +
        "  These are the same variables the Vercel deployment uses — copy the\n" +
        "  value out of the Vercel project settings rather than minting a new key."
    );
  }
}

/** Plain-text table of key: value lines, aligned. Used by both scripts. */
function printPairs(pairs, indent = "    ") {
  const width = pairs.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [key, value] of pairs) {
    console.log(`${indent}${key.padEnd(width)}  ${value}`);
  }
}

module.exports = {
  ROOT,
  fail,
  loadEnv,
  loadSchema,
  loadTsModule,
  printPairs,
  requireFirebaseCredentials,
  requireHubspotToken,
};
