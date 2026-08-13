# HubSpot ⇄ Firebase integration

Two-way sync between the High Agency Firestore data and the High Agency HubSpot
portal (**ID 2410150**, Josh's portal), so that:

- every founding-batch application and every approved member is a HubSpot
  Contact with the full application on the record;
- staff can **approve or decline from inside HubSpot** and Firebase honours it —
  an approval writes the `approvedMembers` allowlist entry that is the only way
  to get an account while the founding-batch gate is up;
- the contact data is clean enough to segment and mail from.

> **Status: built, not yet switched on.** There is no portal token yet — HubSpot
> only lets Super Admins create private apps, and the ask is out to Josh. Every
> code path degrades to a silent no-op until `HUBSPOT_ACCESS_TOKEN` is set.
> Nothing in the product breaks, 500s, or blocks a user in the meantime. That
> behaviour is a hard requirement, not a nicety, and it is covered by tests.

---

## What syncs, which way

### Firebase → HubSpot (push)

| Source | Becomes | When |
| --- | --- | --- |
| `applications/{id}` | Contact + `ha_*` application fields | On submit (fire-and-forget ping from the apply form), and on every reconcile for anything not yet stamped `hubspotSyncedAt` |
| `approvedMembers/{email}` | Contact + `ha_member_status`, `ha_member_role`, `ha_platform_activated` | Every reconcile |
| `profiles/{uid}` (existence only) | `ha_platform_activated = yes/no` | Every reconcile |

The push also stamps `hubspotContactId` and `hubspotSyncedAt` back onto the
application document, which is how "already synced" is known.

`ha_platform_activated` answers "did this person actually turn up?".
`approvedMembers` is keyed by email and `profiles` deliberately stores **no**
email (minor PII lives only in `privateProfiles`), so the join runs through
Firebase Auth: email → uid → `profiles/{uid}`.

### HubSpot → Firebase (pull)

Poll-based, **not** webhook-based: the portal's tier has no workflow webhook
actions, so there is nothing to subscribe to. Every trigger just calls the same
reconcile endpoint.

The pull looks for contacts where `ha_application_status` is `approved` or
`declined` **and** `ha_decision_synced` is `pending` or unset, then:

- **approved** → writes `approvedMembers/{lowercased email}` with the role from
  `ha_member_role` (default `operator`), the contact's name, `addedAt`, a
  `note`, and `source: "hubspot"`. Updates the linked application document with
  `status: "approved"` and `decidedAt`.
- **declined** → updates the application document with `status: "declined"`,
  `decidedAt` and the decline reason. Removes the `approvedMembers` entry **only
  if it exists and carries `source: "hubspot"`**.
- then writes `ha_decision_synced = synced`, `ha_member_status` and
  `ha_decided_at` back to the contact so the decision is never applied twice.

Firebase is written **first** and the `synced` marker **last**. If a run dies in
between, the next pass re-applies the same decision — harmless, because every
operation is idempotent — whereas marking first could lose a decision.

### The guardrail you need to know about

A decline in the CRM **will not delete an allowlist entry that a human added by
hand.** Mentors like `josh@high-agency.io` are typed straight into the Firebase
Console or added with `scripts/approve.js`, and those entries have no
`source: "hubspot"` marker. When a decline lands on one, the sync leaves it
alone and writes an explanation into `ha_sync_note` on the contact so a person
sees it in HubSpot. Revoking that access is a deliberate manual act
(`node scripts/approve.js <email> --remove`), never a side effect of a CRM edit.

---

## Environment variables

| Variable | Where | Required? | What it does |
| --- | --- | --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | Vercel + `.env` for scripts | No — absent is a supported state | Private-app token. **Everything HubSpot no-ops without it.** |
| `HUBSPOT_BASE_URL` | local only | No | API base, default `https://api.hubapi.com`. Point it at the local stand-in for verification — see [Local verification](#local-verification-mock--e2e). **Never set this in production.** |
| `CRON_SECRET` | Vercel | Yes, to use the cron route | Bearer for `/api/cron/hubspot-sync`. Unset ⇒ the route returns 503 rather than defaulting open. Same secret as `unassigned-squads`. |
| `FIREBASE_SERVICE_ACCOUNT` *or* `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | Vercel + `.env` for scripts | Yes | Admin SDK credentials. Already required by the consent and mentor-invite flows — same secret serves all of them. |
| `NEXT_PUBLIC_APP_URL` | Vercel | Recommended | Base URL used in the approval email. Defaults to `https://high-agency.io`. |
| `HUBSPOT_APPROVAL_EMAIL` | Vercel | No | `on` enables the "you're in" email to newly approved applicants. **Anything else, including absent, sends nothing.** |
| `RESEND_API_KEY` | Vercel | No | Existing Resend key. Without it an enabled approval email is logged to the server console instead of sent. |

**Required GitHub repository secrets** (Settings → Secrets and variables →
Actions), for `.github/workflows/hubspot-sync.yml`:

| Secret | Value |
| --- | --- |
| `CRON_SECRET` | Identical to the `CRON_SECRET` on the Vercel project |
| `APP_URL` | Base URL to sync, no trailing slash — e.g. `https://high-agency.io` |

Until both exist the workflow is **dormant, not broken**: it emits a `::notice::`
saying it isn't configured yet and exits 0, so it doesn't post a red run every
five minutes for an expected state. Once configured, a non-2xx from the endpoint
or a transport error still fails the job loudly.

### Getting the token

In the High Agency portal (2410150): **Settings → Integrations → Private Apps →
Create a private app**. Scopes:

```
crm.objects.contacts.read    crm.objects.contacts.write
crm.schemas.contacts.read    crm.schemas.contacts.write
```

Creating a private app requires **Super Admin** in that portal. Put the
resulting `pat-na1-…` token in the Vercel project env and in a local `.env` for
the scripts.

---

## Setup, in order

```bash
# 1. Provision the property group and the custom properties. Idempotent.
node scripts/hubspot-setup.js --dry-run     # see the plan first
node scripts/hubspot-setup.js

# 2. Push everything already on record. Idempotent, and --dry-run prints
#    exactly what it would write (emails masked).
node scripts/hubspot-backfill.js --dry-run
node scripts/hubspot-backfill.js
#    --force also re-pushes applications that are already stamped as synced.

# 3. Add CRON_SECRET + APP_URL as GitHub repository secrets so the 5-minute
#    workflow can run. Then trigger it once by hand from the Actions tab.
```

Both scripts refuse to run with a specific, actionable message when
`HUBSPOT_ACCESS_TOKEN` (or, for the backfill, Firebase credentials) is missing.

### Scheduling

Two triggers point at `GET /api/cron/hubspot-sync`:

- **`.github/workflows/hubspot-sync.yml`** — every 5 minutes plus manual
  `workflow_dispatch`. This is the real mechanism: it is what makes "approve
  someone in HubSpot and they can sign in" feel immediate.
- **`vercel.json`** — once a day at 05:00 UTC, the safety net. Vercel Hobby caps
  cron jobs at one run per day, which is why the frequent trigger lives in
  GitHub Actions.

Running it more often is safe. The response is a summary:

```json
{ "ok": true, "pushedApplications": 2, "pushedMembers": 5,
  "approvals": 1, "declines": 0, "truncated": false, "errors": [] }
```

`errors` holds per-record failures — one bad record never aborts the run, and
the endpoint still returns 200, because a malformed legacy document is a data
problem for a human, not an outage. `errors[].ref` is a document id or a HubSpot
contact id, never an email.

**What it returns today**, with `CRON_SECRET` set on Vercel and no
`HUBSPOT_ACCESS_TOKEN` yet — a 200, so nothing a monitor watches reads it as an
outage, and an explicit reason so nobody mistakes it for a working sync:

```
HTTP/1.1 200 OK
content-type: application/json

{"ok":true,"pushedApplications":0,"pushedMembers":0,"approvals":0,"declines":0,"truncated":false,"errors":[],"skipped":"hubspot-not-configured"}
```

The two failure shapes worth recognising: `503 {"error":"cron-not-configured"}`
means `CRON_SECRET` is unset **on Vercel** (the route refuses rather than
defaulting open), and `401 {"error":"unauthorized"}` means the caller's bearer
and the Vercel secret disagree.

---

## What a staff member actually clicks

To **approve** someone:

1. Open the contact in HubSpot (search their email).
2. In the **High Agency** property group, set **Application Status → Approved**.
3. Optional: set **Member Role → Mentor** if they should get the mentor app.
   Blank means Operator.
4. Save, and wait up to 5 minutes.

Within one sync cycle: they are on the founding-batch allowlist and can sign in
at `/login`, the contact shows **Member Status → Approved member**, **Decision
Synced → Synced**, and **Decided At** is filled in.

To **decline** someone: same path, set **Application Status → Declined**, and
optionally type a **Decline Reason** (internal — this integration never shows it
to the applicant). The application is marked declined in Firebase and any
CRM-created allowlist entry is removed.

Things worth knowing:

- **`In review` and `Waitlisted` do nothing.** They are there so staff have
  somewhere to park a decision without it reading as a rejection.
- **Don't edit `Member Status`, `Decision Synced`, `Platform Activated` or
  `Sync Note`.** They are mirrors of platform truth; the sync overwrites them.
- **To re-run a decision**, set **Decision Synced → Pending** and save. The next
  sync will apply the current status again.
- **A non-empty `Sync Note` means something needed a human.** The common case is
  the hand-added-entry guardrail above.
- **Nothing is emailed to an applicant on approval** unless
  `HUBSPOT_APPROVAL_EMAIL=on`. These are real 13–18 year olds and Sai signs off
  before any outbound mail.

---

## Local verification (mock + e2e)

> **Local only. Never a production path.** Neither script is imported by
> anything in `app/`, neither is deployed, and `HUBSPOT_BASE_URL` must never be
> set on the Vercel project.

There is no portal token yet, which would otherwise leave the whole integration
unverified against anything real. So there is a stand-in for the API and a
single command that drives the sync end to end against it.

### `scripts/hubspot-mock-server.js`

A dependency-free node HTTP server implementing just enough of the HubSpot v3
contract for **our** client: property-group and property create (with a
409-shaped conflict for a name that already exists), `PATCH
/crm/v3/objects/contacts/{email}?idProperty=email` (404 for an unknown email),
`POST /crm/v3/objects/contacts`, and `POST /crm/v3/objects/contacts/search` with
the exact `IN` / `EQ` / `NOT_HAS_PROPERTY` filter shapes `pullDecisions()` sends,
paged via `after`. `/crm/**` requires the bearer token, so the auth path is
exercised too. Contacts are held in memory, keyed by lowercased email.

```bash
node scripts/hubspot-mock-server.js              # port 4300
node scripts/hubspot-mock-server.js --port 4399
HUBSPOT_MOCK_TOKEN=xyz node scripts/hubspot-mock-server.js

# then point the real client at it
HUBSPOT_BASE_URL=http://127.0.0.1:4300 HUBSPOT_ACCESS_TOKEN=mock-token \
  node scripts/hubspot-setup.js
```

It also exposes a **control surface under `/__control` that is not part of the
real HubSpot API** (unauthenticated, deliberately namespaced so it can never be
mistaken for something the client may call):

| Route | Does |
| --- | --- |
| `GET /__control/health` | liveness + contact count |
| `GET /__control/contacts` | inspect every contact and all its properties |
| `POST /__control/contacts` | seed a contact directly (`{ email, properties }`) |
| `POST /__control/decide` | **simulate a staff decision** — `{ email, status: "approved" \| "declined", role?, declineReason?, resetSynced? }`. Sets exactly the fields a human clicking in HubSpot would set and nothing else; `resetSynced` mirrors the documented "set Decision Synced → Pending to re-run" click. |
| `POST /__control/archive-property` | archive a property, so it keeps its name but vanishes from the `archived=false` listing — this is what makes `ensureProperties()`'s 409 path genuinely reachable |
| `POST /__control/reset` | clear contacts (`{ schema: true }` also clears the schema) |

### `scripts/hubspot-e2e.js`

One repeatable end-to-end run: boots the mock, provisions properties twice to
prove idempotency (and a third time against an archived name to prove the 409
path), seeds disposable documents in **real Firestore**, runs `reconcile()`, then
drives an approve, a decline and the guardrail case through the control surface —
asserting Firestore each time. Prints a PASS/FAIL line per assertion and a
per-step summary, and exits non-zero on any failure.

```bash
node scripts/hubspot-e2e.js                  # boots the mock on :4300
node scripts/hubspot-e2e.js --port 4399
node scripts/hubspot-e2e.js --no-boot        # use an already-running mock
node scripts/hubspot-e2e.js --keep-server    # leave it up to poke at afterwards

# or against the emulator, no credentials needed:
firebase emulators:exec --only firestore --project highagency-62e67 \
  "node scripts/hubspot-e2e.js"
```

What it asserts, in order: the bearer is enforced · provisioning is idempotent
and survives a 409 · search pagination walks every page (it seeds 101 contacts
past the one-page limit) · both applications become contacts with the right
values · **a legacy application's missing fields are absent rather than the
string `"undefined"`** · an approve writes `approvedMembers/{email}` with
`source: "hubspot"` and marks the contact synced · a second reconcile re-applies
nothing · a decline marks the application declined with its reason · **a
hand-added allowlist entry survives a decline and a note is written back to the
contact** · cleanup is complete.

**Safety properties, because this touches live data:**

- Every document it creates is prefixed `E2E_HUBSPOT_<date>_<pid>` (or
  `e2e-hubspot-<date>-<pid>-…@example.invalid` for allowlist ids), so it is
  obviously test data in the Console and two runs can never collide.
- Emails use the RFC-2606 reserved `.invalid` TLD and cannot receive mail. The
  harness also unsets `HUBSPOT_APPROVAL_EMAIL`, so a machine with the approval
  email switched on still can't mail anybody during a test.
- The **preflight reads Firestore before writing anything** and aborts with the
  exact re-auth commands if credentials are stale.
- `reconcile()` pushes *every* unsynced application, which on live data means it
  stamps real documents. The harness snapshots which documents were unsynced
  beforehand and **removes the `hubspotSyncedAt` / `hubspotContactId` stamps it
  caused** during cleanup, so the run genuinely leaves Firestore as it found it.
- Cleanup is **verified, not assumed**: it re-reads every document it created and
  re-scans both collections for its own prefix. A single survivor fails the run.

## Files

| File | Role |
| --- | --- |
| `app/lib/hubspotSchema.ts` | **The single source of truth** for every `ha_` property: name, label, type, options. Nothing else hardcodes a property name. |
| `app/lib/hubspot.ts` | HubSpot v3 client. `fetch` only, no SDK. Timeout, one retry on 429/5xx, errors that never carry the token or a PII-bearing body. Every request is built from `hubspotBaseUrl()` — the one place `api.hubapi.com` appears. |
| `app/lib/hubspotMapping.ts` | Pure Firestore → property-bag mapping. No I/O, so it is unit-tested directly. Truncation happens here and nowhere else. |
| `app/lib/hubspotSync.ts` | `pushApplication`, `pushApprovedMember`, `pullDecisions`, `reconcile`. |
| `app/lib/hubspotEmail.ts` | Optional approval email. Off unless `HUBSPOT_APPROVAL_EMAIL=on`. |
| `app/lib/hubspotClient.ts` | The browser's one fire-and-forget ping. |
| `app/api/hubspot/application/route.ts` | Public post-submit ping. Always 200. |
| `app/api/cron/hubspot-sync/route.ts` | `CRON_SECRET`-protected reconcile. |
| `scripts/hubspot-setup.js` | Provision properties. Idempotent, `--dry-run`. |
| `scripts/hubspot-backfill.js` | Push everything on record. Idempotent, `--dry-run`, `--force`. |
| `scripts/hubspot-common.js` | `.env` loading, secret guards, and the tsx hook that lets these CommonJS scripts run the app's own TypeScript. |
| `scripts/hubspot-mock-server.js` | **Local only.** Stand-in for the HubSpot API + a `/__control` surface. |
| `scripts/hubspot-e2e.js` | **Local only.** One-command end-to-end verification against the mock + real Firestore. |
| `tests/hubspot.test.mts` | Mapping, legacy-document, name-splitter and decline-guardrail tests. The HTTP layer is mocked; no test touches the real API. |

`npm run test:hubspot` runs the suite (it is also part of `npm test`).

### Why the pull is not a webhook

Free/standard HubSpot has no workflow webhook actions, so there is nothing to
push to us. Do not redesign around webhooks unless the portal is upgraded — and
if it ever is, the pull can stay as the backstop.

### Notes on the mapping

- **Legacy applications are the normal case, not an edge case.** HA-049, HA-050
  and HA-051 predate the nine-question form and have no
  `social`/`impact`/`problem`/`plan` fields at all. Those keys are **omitted**
  from the property bag, never written as the string `"undefined"`.
- `addedAt` on an allowlist entry is epoch ms on script-created docs and a
  Firestore `Timestamp` on some Console-created ones. Both are handled.
- Names split on the **last** space; a single-token name goes entirely in
  `firstname`, which is what email personalisation reads.
- Every property is prefixed `ha_` because the portal already has ~287 contact
  properties from other tools.

---

## Removing it

Nothing outside these files knows HubSpot exists, which is deliberate. To tear
the integration out:

1. Delete `app/lib/hubspot.ts`, `hubspotSchema.ts`, `hubspotMapping.ts`,
   `hubspotSync.ts`, `hubspotEmail.ts`, `hubspotClient.ts`.
2. Delete `app/api/hubspot/`, `app/api/cron/hubspot-sync/`.
3. Delete `scripts/hubspot-*.js` (including the mock and e2e harness),
   `tests/hubspot.test.mts`,
   `.github/workflows/hubspot-sync.yml`, and this file.
4. Remove `test:hubspot` from `package.json` (and from the `test` script), and
   the `/api/cron/hubspot-sync` entry from `vercel.json`.
5. In `app/components/ApplyModal.tsx`: drop the `notifyHubspotApplication`
   import and its one call site.
6. Optional: `docId` on `ApplicationRecord` in `app/lib/firebase.ts` exists only
   to feed that call. Harmless to keep.
7. Unset `HUBSPOT_ACCESS_TOKEN` and `HUBSPOT_APPROVAL_EMAIL` in Vercel, and the
   `APP_URL` GitHub secret. Keep `CRON_SECRET` — `unassigned-squads` uses it.

No Firestore security rules change is needed to add or remove this. Everything
server-side runs through the Admin SDK, which bypasses rules; the new fields it
writes onto `applications/{id}` (`hubspotContactId`, `hubspotSyncedAt`,
`status`, `decidedAt`, `declineReason`, `decidedVia`) live in a collection that
is already **create-only and never client-readable**, and no client writes them.

### Relationship to the temporary access gate

The founding-batch gate (`app/lib/accessGate.ts` and friends) is scheduled for
deletion in one commit when the batch ends. The sync engine imports exactly
three things from it — `APPROVED_MEMBERS`, `normalizeEmail`, `isValidEmail` — so
the allowlist doc-id convention lives in one place. **When the gate is deleted,
`hubspotSync.ts` needs those three re-homed** (they are ~10 lines). Everything
else, including the per-IP rate limiting on the public route, is deliberately a
local copy rather than an import, so the gate's removal doesn't take the CRM
sync with it.
