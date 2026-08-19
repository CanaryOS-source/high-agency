# HubSpot ⇄ Firebase integration

Two-way sync between the High Agency Firestore data and the High Agency HubSpot
portal (**ID 2410150**, Josh's portal), so that:

- every founding-batch application and every approved member is a HubSpot
  Contact with the full application on the record;
- staff can **approve or decline from inside HubSpot** and Firebase honours it —
  an approval writes the `approvedMembers` allowlist entry that is the only way
  to get an account while the founding-batch gate is up;
- the contact data is clean enough to segment and mail from.

> **Status: live.** `HUBSPOT_ACCESS_TOKEN` is configured in production, the
> property setup and the initial backfill have been run, every application on
> record is stamped synced and present in the portal as a Contact, the approved
> members are represented, and the five-minute GitHub Action reconcile returns
> 200 with no errors.
>
> **Sending is NOT live and is not part of this integration.** The portal is on
> HubSpot's free tools with zero Marketing Contacts, and the billing UI says
> campaign targeting needs Marketing Hub. No list, sender, subscription type,
> workflow or campaign has been configured, and nothing here sends a marketing
> email. The one transactional mail this repo can send (the optional approval
> note) goes out through **Resend**, not HubSpot, and stays off unless
> `HUBSPOT_APPROVAL_EMAIL=on`.
>
> Every code path still degrades to a silent no-op when `HUBSPOT_ACCESS_TOKEN`
> is unset — nothing in the product breaks, 500s, or blocks a user. That
> behaviour is a hard requirement, not a nicety, and it is covered by tests.

---

## What syncs, which way

### Firebase → HubSpot (push)

| Source | Becomes | When |
| --- | --- | --- |
| `applications/{id}` | Contact + `ha_*` application fields | On submit (fire-and-forget ping from the apply form), and on every reconcile for anything not yet stamped `hubspotSyncedAt` |
| `approvedMembers/{email}` | Contact + `ha_member_status`, `ha_member_role`, `ha_platform_activated` | Every reconcile |
| `profiles/{uid}` (existence only) | `ha_platform_activated = yes/no` | Every reconcile |
| `referrals/{code}` (the applicant's own counter) | `ha_referral_confirmed` | On push, then only when the number actually moves — see [Referral attribution](#referral-attribution) |

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

## Referral attribution

The waitlist referral loop is **Firestore-native and stays that way**: a
`?ref=CODE` link resolves against `referrals/{code}`, and crediting a referral is
one increment inside the signup transaction (see the Waitlist referrals section
of `CLAUDE.md` and `app/lib/referral.ts`). HubSpot is told about it **for
analytics only**. Nothing in the signup path calls HubSpot, and no referral
decision has ever depended on it.

| Property | What it is |
| --- | --- |
| `ha_referral_code` | This applicant's **own** share code. Filter contacts by `ha_referred_by` = this to list everyone they brought in. |
| `ha_referred_by` | The code they **arrived on**. `""` means they came in cold; **blank** (no value) means the application predates referrals — those are different claims and are stored differently on purpose. |
| `ha_referral_source` | `Staff promo code` / `Applicant referral` / `Direct`. Derived by the sync from the counter the incoming code resolved to. Editing it in HubSpot has no effect. |
| `ha_referral_confirmed` | How many applications this applicant's own code has brought in. |

**How to answer "how did Evelyn's post do?"** — filter contacts on
`ha_referred_by` = her code (the provisioning script prints it, and
`staffReferralCodes/{slug}` holds it). That gives you the people, not just a
number. `ha_referral_source = Staff promo code` gives the staff-vs-organic split
across the whole batch in one filter, without anyone having to keep a list of
five codes up to date.

### Keeping `ha_referral_confirmed` fresh, cheaply

An application is pushed to HubSpot once, at signup, when its own referral count
is necessarily zero — so without a refresh that property would read 0 forever.
But re-pushing everyone on every five-minute tick would be dozens of API writes
for a number that changes a handful of times a week. `refreshReferralCounts()`
in `app/lib/hubspotSync.ts` is built the other way round:

1. Take the candidates from **`applications`**, not from `referrals` — the ones
   that carry a referral code and have already been pushed.
2. Read those counters **by id**, batched.
3. Compare against `hubspotReferralConfirmed` on the application document — what
   we last told HubSpot. **Equal means no API call at all.** This is the change
   detection that makes the cadence safe.
4. Only then patch the contact — with that one property and nothing else — and
   record the new value so the next pass sees it as unchanged.

**Step 1 is a security property, not a style choice.** `referrals` is public and
unauthenticated-writable, because a signed-out visitor on a `?ref=` link has to
be able to resolve and credit a counter. So anyone can create counters carrying
`confirmed > 0`. Finding work with `referrals where confirmed > 0` under a
`limit()` applies that limit **before** any ownership filtering, and Firestore
orders stably — so a cheap flood of ownerless counters would occupy the first
page on every pass, forever, and no real applicant's count would ever be
refreshed again. A cursor does not fix it: the flood outnumbers the real rows on
every page too. Applications are create-only, carry the applicant's own minted
code, and are stamped with `hubspotContactId` by the Admin SDK, so driving from
them means an ownerless counter is never even a candidate. Regression tests
(`tests/hubspot.test.mts`) bury a real applicant under more decoys than the
limit and assert it still refreshes, across consecutive passes.

When it runs inside `reconcile()` it is handed the application page that pass
already read, so it costs **zero extra application reads** and shares one bound
with the rest of the run. Called standalone it reads its own bounded page
(`REFERRAL_REFRESH_LIMIT`, 200, newest first). HubSpot writes are capped per pass
at `REFERRAL_REFRESH_MAX_WRITES` (50) so a first run after the property is added
cannot become an unbounded burst; hitting either bound sets `truncated`, and the
next pass resumes where this one stopped because everything written now compares
equal. A healthy run reports `refreshedReferrals: 0`.

Staff counters are skipped — they are nobody's application, so they never appear
as candidates at all. Their totals are answerable by filtering contacts on
`ha_referred_by` = the staff code, which is the better number anyway.

**Cost, so nobody is surprised by a Firestore bill.** Inside `reconcile` the
refresh adds only the batched counter reads: **one read per application that has
a code and a contact**, and **zero HubSpot calls** when nothing moved. The
application query is a plain `orderBy(createdAt)` and the counters are fetched
by id, so there is no composite index and nothing to add to
`firestore.indexes.json`.

---

## Marketing consent

The application form carries an **optional, unchecked** box: *"Email me High
Agency updates and future cohort opportunities. Optional — this has no effect on
your application. Unsubscribe anytime."* It gates nothing; an application submits
identically either way.

| Property | What it is |
| --- | --- |
| `ha_marketing_consent` | `Yes` / `No`. **Blank means they applied before the box existed — which is NOT a yes.** |
| `ha_marketing_consent_at` | Date the opt-in was given. Only set when it was. |
| `ha_marketing_consent_source` | Where it was collected. Always exactly `waitlist` today — it is the only source, and both the rules and the mapping check for that string specifically. Only set when consent was given. |

Three things to be clear about:

- **These are plain custom properties, not HubSpot subscription state.** Nothing
  can send off a custom property, so recording an intention here cannot become a
  send by accident. Wiring them to a real subscription type is a separate,
  deliberate act for whoever turns campaigns on.
- **Nothing has been configured to send.** No list, no sender, no subscription
  type, no workflow, no campaign, and no DNS/domain setup. This work recorded
  consent and nothing else.
- **Absent stays absent.** A legacy application never acquires a "no" it never
  gave, because "no" and "never asked" are different segments.

Firestore stores `marketingConsent` (boolean, always written on a new
application), plus `marketingConsentAt` and `marketingConsentSource` **only when
consent was given**.

**An opt-in must carry its proof.** `firestore.rules` enforces one invariant in
both directions:

```
marketingConsent == true
  <=> marketingConsentAt == request.time  &  marketingConsentSource == 'waitlist'
```

The whole block stays optional, so every application already on record still
validates and consent is never required to apply. But a `true` with no timestamp,
no source, a source we do not recognise, or a **client-supplied** timestamp is
refused outright — the comparison is against `request.time`, the value a
`serverTimestamp()` sentinel resolves to, so consent cannot be backdated by
whoever is writing. Proof without an opt-in is refused too: that shape would read
in the CRM as evidence of a consent nobody gave.

**And the mapping fails closed on top of that.** `applicationToProperties` only
emits `Yes` for a record whose proof actually holds up (`marketingConsentState`
in `app/lib/marketingConsent.ts`); anything incoherent maps to **nothing at
all** rather than to a `Yes`, because the failure mode of treating a corrupt row
as consent is mailing somebody who never agreed, and the failure mode of the
reverse is a blank field a human can look into. `'waitlist'` is spelled out in
`firestore.rules` (which cannot import) and pinned to `MARKETING_CONSENT_SOURCE`
by a test.

---

## Staff referral codes

Five people on the team need a referral link they can put in a post. They get a
code and **nothing else** — no Auth user, no profile, no `approvedMembers` entry
and no application. A staff member is not an applicant, and the founding-batch
gate exists precisely to stop accounts appearing for people who were never
approved.

**The representation.** A staff code is the same document as an applicant's
counter — same collection, same alphabet, same update rule — so an incoming
`?ref=` resolves and credits through exactly one code path. Two things make it a
lead-source counter rather than a queue position:

- `kind: "staff"` — **unforgeable from a browser.** The `referrals` create rule
  accepts an exact field list that does not include `kind`, so only the Admin
  SDK can mint one. The update rule only touches `confirmed`/`credited`/`pos`/
  `updatedAt`, so a client can credit a staff code but cannot strip the marker.
- `basePos: 1` — the **fixed point** of the position arithmetic:
  `max(1, 1 − credited×10) == 1` for every value, so the position never drifts
  and the shared rule needs no branch for staff. The only number that means
  anything on a staff counter is `confirmed`.

The private half is `staffReferralCodes/{slug}` — slug → code, plus the name and
Slack id. **Deny-all to clients** (same posture as `mentorInvites`), which is why
the public counter carries neither a name nor a Slack id. Its only job is
idempotency: without it, a second run would mint a second code for the same
person and split their attribution in two.

The public banner also changes for a staff link: "Someone on the High Agency team
sent you this link", rather than promising a referrer a queue jump they have no
position to take.

### Runbook

```bash
# 1. Look before you write. Dry run is the DEFAULT — no flag needed.
node scripts/staff-referrals.js

# 2. Provision. Idempotent: anyone already provisioned is reported and skipped.
node scripts/staff-referrals.js --apply

# 3. Machine-readable, for pasting the links into Slack.
node scripts/staff-referrals.js --apply --json | jq -r '.staff[] | "\(.name)\t\(.link)"'

# Point the links at a local dev server instead of production:
node scripts/staff-referrals.js --origin http://localhost:3000
```

Needs Firebase Admin credentials (the same env the HubSpot scripts and the
Vercel deployment use — see `scripts/hubspot-common.js`). It does **not** touch
HubSpot and it sends no email.

**Output.** Human-readable by default; `--json` prints only JSON on stdout:

```json
{
  "mode": "apply",
  "origin": "https://high-agency.io",
  "staff": [
    { "slug": "evelyn-qiao", "name": "Evelyn Qiao", "slackId": "U09CSHVBLBZ",
      "action": "created", "code": "K7M2QX",
      "link": "https://high-agency.io/?ref=K7M2QX", "confirmed": 0 }
  ],
  "conflicts": [],
  "ok": true
}
```

`action` is one of `would-create` (dry run), `created`, `exists`, `conflict`.
**Exit code is 1 when anything is a conflict**, 0 otherwise.

### Recovery

The script **never overwrites**. A staff code may already be printed in
somebody's post, and detaching it silently loses every click that link has
earned — so a mapping/counter pair that disagrees with itself is reported as a
conflict and left exactly as it was. It refuses when: the mapping's code isn't a
valid code; the mapping is recorded against a different Slack id than the roster;
the counter the mapping points at is missing (a half-written pair); the counter
carries a different code than its own id; the counter is not `kind: "staff"`
(it may belong to a real applicant); or the counter has a real queue position.

To resolve one, in the Firebase Console:

- **Half-written pair** (mapping without counter, e.g. a crashed run): if the
  link was never shared, delete `staffReferralCodes/{slug}` and re-run — a fresh
  code is minted. If it *was* shared, re-create `referrals/{code}` by hand with
  `{code, opId: "HA-STAFF", basePos: 1, confirmed: 0, credited: 0, pos: 1, kind:
  "staff", createdAt, updatedAt}` so the live link keeps working.
- **Counter is an applicant's** — do **not** delete it. Delete the
  `staffReferralCodes/{slug}` mapping only, and re-run to mint a different code.
- **Wrong Slack id** — decide who the code belongs to. Fix the roster in
  `app/lib/staffReferrals.ts` if the roster is wrong; fix the mapping document if
  the mapping is.

**Full rollback** (the codes were never shared): delete the five
`staffReferralCodes/*` documents and the five `referrals/{code}` documents they
point at. Nothing else references them — no application, no profile, no
allowlist entry — so there is nothing else to clean up. If a link *has* been
shared, leave the counter in place: deleting it turns a live link into one that
credits nobody.

Adding a sixth person is: append them to `STAFF_ROSTER` in
`app/lib/staffReferrals.ts` and re-run with `--apply`. Everyone already
provisioned is untouched.

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

**After adding properties to `app/lib/hubspotSchema.ts`** — which the referral
and marketing-consent work did — re-run the same two steps against the live
portal once the change is deployed:

```bash
node scripts/hubspot-setup.js --dry-run   # should list only the NEW properties
node scripts/hubspot-setup.js             # creates what's missing, skips the rest
node scripts/hubspot-backfill.js --dry-run --force
node scripts/hubspot-backfill.js --force  # re-push so existing contacts get them
```

`--force` is what makes the backfill revisit applications already stamped
`hubspotSyncedAt`; without it they are skipped and the new properties stay blank
on contacts that were synced before the properties existed. Both steps are
idempotent — `hubspot-setup.js` creates only what is missing and never modifies a
property that already exists, and a re-push never resets a decision a human made
in the CRM (the mapping writes no status field at all).

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
  "approvals": 1, "declines": 0, "refreshedReferrals": 0,
  "truncated": false, "errors": [] }
```

`errors` holds per-record failures — one bad record never aborts the run, and
the endpoint still returns 200, because a malformed legacy document is a data
problem for a human, not an outage. `errors[].ref` is a document id or a HubSpot
contact id, never an email.

`refreshedReferrals` counts contacts whose referral number actually moved this
pass. **Zero is the normal, healthy reading** — see
[Keeping `ha_referral_confirmed` fresh](#keeping-ha_referral_confirmed-fresh-cheaply).

**Without `HUBSPOT_ACCESS_TOKEN`** (a supported state — any preview deployment,
and how this ran before the token existed) the same endpoint answers 200 with an
explicit reason, so a monitor doesn't read it as an outage and nobody mistakes
it for a working sync:

```
HTTP/1.1 200 OK
content-type: application/json

{"ok":true,"pushedApplications":0,"pushedMembers":0,"approvals":0,"declines":0,"refreshedReferrals":0,"truncated":false,"errors":[],"skipped":"hubspot-not-configured"}
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
- **Don't edit `Member Status`, `Decision Synced`, `Platform Activated`,
  `Sync Note`, `Referral Source` or `Referrals Confirmed`.** They are mirrors of
  platform truth; the sync overwrites them.
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

These predate the portal token and are still the right tool: they exercise the
whole sync end to end without spending a real API call or writing to a live
contact record. Use them before pointing anything at the portal.

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
| `app/lib/hubspotSync.ts` | `pushApplication`, `pushApprovedMember`, `pullDecisions`, `refreshReferralCounts`, `reconcile`. |
| `app/lib/referral.ts` | Referral vocabulary shared by the browser, the write path and the rules tests. Also defines the staff-counter shape (`STAFF_COUNTER_KIND`, `staffCounterFields`). Not a HubSpot file. |
| `app/lib/marketingConsent.ts` | The consent field names, the checkbox copy and the granted/declined shape, in one pure module so the form, the write path, the mapping and the rules tests cannot drift. |
| `app/lib/staffReferrals.ts` | Staff roster + the pure provisioning decisions (`planStaffCode`, `validateRoster`). No I/O. |
| `app/lib/staffReferralsServer.ts` | Admin-SDK half of provisioning: `planMember`, `mintStaffCode`, `provisionStaffCodes`. |
| `scripts/staff-referrals.js` | Provision the staff lead-source codes. Dry run by default, `--apply`, `--json`. |
| `tests/staffReferrals.test.mts` | Roster validation, conflict refusal, and idempotent provisioning against the emulator. |
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

`npm run test:hubspot` runs the CRM suite and `npm run test:staff` the staff-code
suite; both are part of `npm test`. The referral counters, the staff counters and
the optional application fields are enforced by `firestore.rules` and covered by
`npm run test:referral`.

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
   import and its one call site. **Leave the marketing-consent checkbox** — it
   writes to Firestore, not to HubSpot, and the referral loop is likewise
   Firestore-native. Neither depends on this integration.
6. Optional: `docId` on `ApplicationRecord` in `app/lib/firebase.ts` exists only
   to feed that call. Harmless to keep.
7. Unset `HUBSPOT_ACCESS_TOKEN` and `HUBSPOT_APPROVAL_EMAIL` in Vercel, and the
   `APP_URL` GitHub secret. Keep `CRON_SECRET` — `unassigned-squads` uses it.

No Firestore security rules change is needed to add or remove this. Everything
server-side runs through the Admin SDK, which bypasses rules; the new fields it
writes onto `applications/{id}` (`hubspotContactId`, `hubspotSyncedAt`,
`hubspotReferralConfirmed`, `status`, `decidedAt`, `declineReason`, `decidedVia`)
live in a collection that is already **create-only and never client-readable**,
and no client writes them.

The rules changes that shipped alongside this work are **not** HubSpot's and
stay when it goes: the optional marketing-consent validation on `applications`
create, the `staffReferralCodes` deny-all block, and the staff-counter notes on
the `referrals` block.

### Relationship to the temporary access gate

The founding-batch gate (`app/lib/accessGate.ts` and friends) is scheduled for
deletion in one commit when the batch ends. The sync engine imports exactly
three things from it — `APPROVED_MEMBERS`, `normalizeEmail`, `isValidEmail` — so
the allowlist doc-id convention lives in one place. **When the gate is deleted,
`hubspotSync.ts` needs those three re-homed** (they are ~10 lines). Everything
else, including the per-IP rate limiting on the public route, is deliberately a
local copy rather than an import, so the gate's removal doesn't take the CRM
sync with it.
