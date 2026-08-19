@AGENTS.md

# High Agency Platform

> Always-loaded project baseline. `@AGENTS.md` above is a hard rule, not a footnote:
> this is **Next.js 16 with breaking changes** — read the relevant guide in
> `node_modules/next/dist/docs/` before writing framework code.

## What we're building

High Agency is a live cohort coaching program that teaches ambitious students (13–19,
"Operators") "what school can't teach" — agency, real skill, and a network. This repo is
the **platform that productizes that program**: a gamified, cohort-based launchpad where
Operators join a tight squad, progress a track of real-world milestones (ship an MVP,
land first users, reach first revenue), attend live expert workshops, and keep momentum
through streaks and accountability between sessions.

The product thesis: **progress is earned by doing real things and verified by a human, not
by completing solo theory exercises.** Gamification rewards verified real-world output, not
logins or lurking.

**Canonical product spec:** [`prd.md`](prd.md) (PRD v1.0, 2026-06-06). When code and PRD
disagree, that's a flag to raise — except where this file explicitly records a decision or
an open question that supersedes the PRD.

## Current status — Phase 1 MVP, free founding batch

- **Where we are:** building the Phase 1 MVP for a **free founding batch of ~50 students**.
  Both the public waitlist site (`/`) and the authenticated platform (`app/(platform)/...`)
  are substantially built and wired to live Firebase — nearly every screen reads/writes real
  Firestore data (no mock-UI screens), all against the `highagency-62e67` Firebase project.
- **Deployment — waitlist-only, live.** The site is deployed on **Vercel** (project
  `high-agency`, production alias `highagencyio.vercel.app`; custom domain `high-agency.io`
  pending GoDaddy DNS). **Production is intentionally a marketing/waitlist page only** — the
  authenticated platform (`/login` + everything under `app/(platform)/`) is gated OFF in
  production and ON in local `next dev`, via the `PLATFORM_ENABLED` flag
  ([`app/lib/flags.ts`](app/lib/flags.ts)) enforced by [`proxy.ts`](proxy.ts). Flip it on by
  setting `NEXT_PUBLIC_PLATFORM_ENABLED=true` in the Vercel project.
  **This is changing:** the platform is being opened in production for the founding
  batch, made safe for strangers by the temporary access gate below. See
  [`QA-HANDOFF.md`](QA-HANDOFF.md) §1 for the go-live checklist — note that
  **Email link (passwordless) sign-in is still disabled** in the Firebase Console,
  which blocks the gate entirely until someone enables it.
- **Scale target:** low hundreds of concurrent users for v1; architecture shouldn't
  preclude low thousands without a rewrite.
- **This is a small team.** The platform reflects considered product decisions — some of which
  **deliberately diverge from `prd.md`** (see Open questions). Read the code as intentional
  unless flagged otherwise.

## ⏳ TEMPORARY: the founding-batch access gate

Production is open to strangers, but **accounts are not**. Only an email on the
`approvedMembers` allowlist can get in. `/login` is not a sign-in form — it takes one
email and either mails a single-use Firebase sign-in link or says "not in the batch
yet" and points at the waitlist. There is deliberately **no Google button, no password
field and no create-account toggle** there; any of them would mint an account for
someone who isn't approved.

- **`approvedMembers/{email}`** — doc id is the email *trimmed and lowercased* (so staff
  can add one by hand in the Firebase Console). Fields: `role: "operator" | "mentor"`
  (required), optional `name` / `addedAt` (epoch ms) / `note`. **Client access is
  deny-all** — it's read only through the Admin SDK. `exists()` still resolves against
  it in rules, which is what makes the gate enforceable rather than cosmetic.
- **Enforced in two places:** `/api/access/*` (server) and `firestore.rules` — creating
  a `profiles/{uid}` doc requires `isApprovedMember()`. The Admin-SDK mentor paths
  bypass rules, so both mentor flows are unaffected.
- **Two ways to become a mentor**, sharing one onboarding component
  (`app/components/MentorOnboarding.tsx`) and one profile builder
  (`buildMentorProfile`): the allowlist (`/login` → `/login/verify` →
  `/api/access/mentor-profile`) and the break-glass invite code
  (`/mentor/join?code=…` → `/api/mentor/redeem`). **Keep the invite path working.**
- **Ops:** `node scripts/approve.js <email> operator|mentor ["Name"]`, `--remove` to
  revoke. Or the Console click-path in [`QA-HANDOFF.md`](QA-HANDOFF.md) §1a.

**This is meant to be deleted in one commit when the batch ends.** Everything
gate-specific is named `access*` (`app/lib/accessGate.ts`, `accessEmail.ts`,
`accessClient.ts`, `app/api/access/**`, `app/(platform)/login/verify/`,
`scripts/approve.js`) plus the `approvedMembers` rules block and the
`isApprovedMember()` clause on profile create. The removal checklist lives at the top
of [`app/lib/accessGate.ts`](app/lib/accessGate.ts). **Don't entangle new product code
with it** — if you need gate behaviour, import from those modules rather than
spreading allowlist checks around.

## ⚠️ Monetization is deferred until after the MVP ships

This is a standing constraint. The freemium model (free core + paid mentorship tier) is
**designed but not implemented**, and we are **not building it now**:

- **DO NOT** add Stripe, checkout, billing, subscriptions, dunning, refunds, paywall UI,
  or pricing pages. There is no payment integration and none should appear during the MVP.
- **DO** preserve the *entitlement scaffolding* that already exists so the line can be
  switched on later without re-architecture:
  - `Profile.plan: "free" | "pro"` — wired, but everyone is `free` in batch 1.
  - `BATCH1_ALL_FREE = true` in [`app/lib/gamify.ts`](app/lib/gamify.ts) — keep it `true`.
    `canEnroll()` already gates "Pro" workshops but short-circuits to free while this flag
    is on. New gated features should tag free-vs-paid the same way and stay free in batch 1.
- **Everything ships free** for the founding batch. The point of batch 1 is to validate the
  engagement loop and harvest proof (testimonials, shipped outcomes), *then* turn on pricing.
- Tagging a feature as eventually-paid is fine and encouraged (keeps the line movable);
  *implementing the wall* is out of scope.

Access in the MVP is gated by **earned Operator Level**, not by payment ("access you earn,
not buy"). Don't conflate level gates with paywalls.

## Stack & architecture

- **Next.js 16.2.7** (App Router) · **React 19** · **TypeScript 5** · **Tailwind CSS v4**
  (via `@tailwindcss/postcss`). Deployed on **Vercel** (waitlist-only in production — see the
  `PLATFORM_ENABLED` gate in Current status).
- **Firebase 12** (client SDK): **Firestore** for data, **Firebase Auth** (Google SSO +
  email/password) for identity. Firebase project id is **`highagency-62e67`** (display name
  "HighAgency", project number `273177671346`, support email `info@high-agency.io`). The app
  config (`app/lib/firebase.ts`), `.firebaserc`, `firebase.json`, and every `scripts/*` all
  target this one project. (An older `canary-os` project was reused infra during early dev and
  has been fully retired from the config — if you see `canary-os` anywhere, it's stale.)
- **No separate backend service. No Python/Flask. No Vertex AI service.** The PRD's old
  Python assumption is dropped (and `prd.md` is updated to match).
- **Firestore security rules *are* the backend.** All v1 data access goes through the
  Firebase client SDK directly from the browser; [`firestore.rules`](firestore.rules) is
  the substantial, authoritative enforcement layer (validation, ownership, immutability,
  bounded XP writes). Treat the rules as production-critical code — when you change a data
  shape or a write path, update the rules in the same change.
- **Direction of travel:** sensitive / must-not-be-client-trusted logic (entitlement
  decisions, milestone-verification XP payouts, attendance, streak integrity) should
  **migrate into Next.js server actions / route handlers** over time rather than staying
  client-trusted. Several v1 mechanics are explicitly "client-trusted v1" (see Gotchas) and
  are the natural first candidates to move server-side.
- **Mentors get their own app, not the operator app plus an admin tab.** There is no `/admin`
  route. `role == "mentor"` swaps the entire shell: the rail becomes **Home · Workshops ·
  Squads · You** (`app/(platform)/mentor/**`), the XP/streak HUD is hidden, and every operator
  surface (`/dashboard`, `/learn`, `/cohorts`, `/profile`) redirects a mentor to its mentor
  equivalent. The one genuinely shared screen is `/cohorts/[id]` — that's where a mentor
  verifies milestones 4–7 — and it hides the operator-only affordances (XP labels, build-log
  composer, ritual button) from them. Mentor screens read their queues through
  `app/components/mentorData.ts`, so Home and Squads can't disagree about what's outstanding.
  **Break-glass / bootstrap operations still run as local Node scripts** (`scripts/`) — they
  authenticate with the firebase-tools CLI OAuth token (IAM bypasses security rules), which is
  how seed/cleanup run and how a mentor can be promoted directly (`admin-set.js <uid> mentor`).
- **Mentors onboard via single-use invite links, not the operator funnel.** Staff mints a code
  with `scripts/mentor-invite.js "<label>" [days]` and shares the printed
  `/mentor/join?code=…` URL 1:1. The join page (deliberately unlinked from any nav) validates
  the code, signs the mentor in, and runs a **mentor-shaped onboarding** (identity + expertise;
  no DOB/parent email — mentors attest 18+, `ageBand: "18+"`, consent `granted`, no
  privateProfiles doc). Redemption is server-authoritative: `POST /api/mentor/redeem` verifies
  the Firebase ID token and, in one Admin-SDK transaction, consumes the invite and mints
  `role: "mentor"` — or **promotes an existing operator account in place**. Invites live in
  `mentorInvites/{sha256(code)}` (server-only, rules deny-all, mirrors `consentTokens`); the
  raw code is printed once at mint and never stored. Clients remain rules-blocked from ever
  writing `role: "mentor"`.

## Domain model (the vocabulary)

Types live in [`app/lib/types.ts`](app/lib/types.ts); data access in
[`app/lib/db.ts`](app/lib/db.ts).

- **Operator** — an ambitious student member (primary persona). **Mentor** — staff/expert
  who verifies advanced milestones and runs workshops (`Role` is `operator | mentor`;
  mentors join via invite link — `scripts/mentor-invite.js` → `/mentor/join?code=…` — or
  by admin script).
- **Profile** (`profiles/{uid}`) — the public artifact cohorts evaluate. **Privacy by
  construction:** display name is `"First L."`, age is an `AgeBand` (`13-15 | 16-17 | 18+`),
  location is country + IANA timezone. **No email/phone/DOB/exact city ever.** Readable by
  any signed-in user (it *is* the cohort application).
- **PrivateProfile** (`privateProfiles/{uid}`) — DOB, full name, exact city, parent email.
  **Owner-only, both directions, never listed.** This split is a hard minor-PII requirement.
- **Cohort / "squad"** (`cohorts/{id}`) — an accountability squad of **3–8** operators
  (`COHORT_MIN_TO_ACTIVATE = 3`, `COHORT_MAX_MEMBERS = 8`). States: `forming → active →
  stalled → archived`. A founder commits a weekly **ritual** slot (deliberate friction).
  Members share one track and a weekly ritual streak. Subcollections: `applications/`,
  `submissions/`, `logs/`.
- **Milestone track** — the default 8-week **Ignition Track** (7 milestones) in
  [`app/lib/milestones.ts`](app/lib/milestones.ts), from "Mission Locked" to "Demo Day".
  Evidence specs are deliberately brutal-specific to keep verification cheap. Milestones
  **1–3 are verified by the cohort's peer-lead; 4–7 by a mentor.** Custom tracks are batch-2.
- **MilestoneSubmission** (`submissions/{milestoneId}_{uid}`) — **per-operator** evidence
  (doc id enforces one-per-operator-per-milestone; resubmits overwrite). Status
  `submitted → returned | verified`. **Returned ≠ rejected** — it comes back with a specific,
  non-punitive reason and a resubmit path, and never breaks a streak.
- **BuildLog** (`logs/`) — daily one-line "what I shipped" updates; described in code as
  "the sleeper feature." The cheapest qualifying action that keeps a streak alive.
- **Workshop** (`workshops/`, staff-seeded, read-only to clients) — live Google-Meet
  sessions / office hours. The one `open` workshop per season is free to all; others are
  level-gated (and, post-MVP, plan-gated). v1 uses Google Meet links, not in-app video.
- **Gamification** (`app/lib/gamify.ts`): **XP** (≈70% of achievable XP flows through
  verified real-world milestones), **5 Operator Levels** (Cadet → Builder → Operator →
  Closer → Architect) that unlock access/status, and **streaks** with banked freezes (earn
  1 per 7-day run, max 3; a freeze covers exactly one missed day). A "day" is the user's
  **local** day; the weekly ritual cadence is the ISO week.
- **Matching** ([`app/lib/match.ts`](app/lib/match.ts)) — tag overlap + timezone band +
  skills-wanted scoring with "why matched" chips. No embeddings yet (deliberate).

## Waitlist referrals

The public waitlist has a referral loop: share your link, and every person who
applies through it moves you up the queue — up to **5 of them**, **10 places each**
([`app/lib/referral.ts`](app/lib/referral.ts) `REFERRAL_MAX` / `REFERRAL_JUMP`).

**The whole design is "arithmetic on one document, never a re-sort of the queue."**
Every applicant gets one public counter at **`referrals/{code}`** — a random 6-character
code (doc id), the public `opId`, `basePos`, `confirmed`, `credited`, and a denormalised
`pos`. Displayed position is always `max(1, basePos − credited × 10)`, so crediting a
referral is a single increment on a single doc: no fan-out, no query, nobody else's row
moves. Cost is flat as the list grows — **2 reads (3 when referred) and 4 writes per
signup**, one read to resolve an incoming `?ref=`, one read to render the share screen.

- **"Confirmed" means the referred person completed the application**, credited inside the
  same transaction as their own signup. There is no pending state and no confirmation
  email; if double opt-in is wanted later, the hook is a `pending → confirmed` transition
  on the counter.
- **The counter is PII-free and world-readable** — a signed-out visitor on a `?ref=` link
  has to resolve it. Attribution (`referralCode` / `referredBy`) lives on the create-only
  `applications` doc instead, so who referred whom is never a readable graph.
- **Positions are per-operator arithmetic, so two people can show the same number** once
  referrals land. That is the deliberate trade for O(1) writes.
- **Staff lead-source codes share the same collection.** Five team members have a
  `referrals/{code}` counter with `kind: "staff"` and `basePos: 1` — the fixed
  point of the position arithmetic, so their position never drifts and the shared
  rules need no branch. Clients can't forge one (the create rule takes an exact
  field list without `kind`); only `scripts/staff-referrals.js` (Admin SDK) mints
  them, keyed for idempotency by the deny-all `staffReferralCodes/{slug}`. They
  get a link, never an account. See `app/lib/staffReferrals.ts` and
  [`docs/hubspot-integration.md`](docs/hubspot-integration.md) → Staff referral codes.
- **The application carries an optional, unchecked marketing opt-in**
  (`app/lib/marketingConsent.ts`): `marketingConsent` always, plus
  `marketingConsentAt`/`marketingConsentSource` only when granted. It gates
  nothing and **nothing sends off it** — no list, sender, subscription or
  campaign is configured anywhere. Absent ≠ `false`: legacy applications were
  never asked.
- **Three implementations of the position model must agree**: `app/lib/referral.ts`,
  the `referralPos()`/`referralCounted()` helpers in [`firestore.rules`](firestore.rules)
  (rules have no `min`/`max`, so they spell it out in ternaries), and the mirror in
  `tests/referral.test.mts`. The first test in that file pins all three together — change
  the cap or the jump in one place and it fails.

## Codebase map

- `app/page.tsx` + `app/Waitlist.tsx` + `app/components/*` — the public **waitlist /
  marketing** site at `/` (outside the platform shell; writes to the `applications`
  collection via [`app/lib/firebase.ts`](app/lib/firebase.ts) `submitApplication`).
  It also carries the **referral loop**: `?ref=CODE` → banner on the hero →
  `ApplyModal` → `ReferralShare` on the success step. See Waitlist referrals below.
- `app/(platform)/` — the authenticated **product**, wrapped by
  [`app/(platform)/layout.tsx`](app/(platform)/layout.tsx) (AuthProvider + role-aware Shell;
  only `/login`, `/onboarding`, and `/mentor/join` render "bare"). **Operator routes:**
  `/dashboard`, `/cohorts`, `/cohorts/[id]`, `/learn`, `/profile`. **Mentor routes:**
  `/mentor` (home queues), `/mentor/workshops` (month calendar of every session + authoring),
  `/mentor/squads` (verify queue, check-in requests, adoption feed, consent queue),
  `/mentor/you` (mentor profile). Plus `/login` + `/login/verify` (the temporary
  founding-batch access gate — see below), `/onboarding`, and `/mentor/join`
  (invite-only mentor signup, unlinked from nav).
- `app/api/` — the server-authoritative Route Handlers (Node, `firebase-admin`, bypass rules):
  `consent/send` + `consent/approve` (parental consent; approval page at `/consent/[token]`),
  `mentor/peek` + `mentor/redeem` (mentor invites), `cron/unassigned-squads` (daily
  ops sweep, `CRON_SECRET`-gated, scheduled in `vercel.json`), and `access/request` +
  `access/claim` + `access/mentor-profile` (the temporary access gate). Server logic
  lives in `app/lib/firebaseAdmin.ts`, `app/lib/consentServer.ts`,
  `app/lib/mentorInviteServer.ts`, `app/lib/accessGate.ts`, `app/lib/accessEmail.ts` —
  **never import these from client components.**
- `app/styleguide/page.tsx` — the living design-system reference (top-level route, `noindex`).
- `app/components/AuthProvider.tsx` — client auth context (`useAuth()` → `{ user, profile,
  logout }`); `user`/`profile` are `undefined` while resolving, `null` when absent.
- `app/components/mentorData.ts` — the mentor app's guard + queues (`useMentorGate`,
  `useMentoredSquads`, `useUnassignedSquads`, `useConsentQueue`). Every mentor screen reads
  its counts from here; the queues are bounded on purpose (see `CONSENT_QUEUE_LIMIT` and
  `UNASSIGNED_SCAN_LIMIT` in `db.ts`) and the UI says so when a list is truncated.
- `app/lib/` — `types.ts`, `firebase.ts` (config + waitlist), `db.ts` (all Firestore CRUD +
  live `watch*` subscriptions), `gamify.ts` (XP/levels/streaks/entitlements), `milestones.ts`
  (the track), `match.ts` (cohort matching), `referral.ts` (waitlist referral constants +
  position arithmetic, shared by the browser, the write path and the rules tests),
  `flags.ts` (`PLATFORM_ENABLED` build-time flag), `marketingConsent.ts` (the
  optional opt-in vocabulary), `staffReferrals.ts` + `staffReferralsServer.ts`
  (staff lead-source codes: roster/decisions, then the Admin-SDK provisioning).
  Plus the deletable gate trio: `accessGate.ts` (server: allowlist lookup + rate limit),
  `accessEmail.ts` (server: sign-in-link mail), `accessClient.ts` (browser: fetch wrappers).
- `proxy.ts` (repo root) — Next 16 `proxy` (the renamed `middleware`). When `PLATFORM_ENABLED`
  is false (production), it redirects every platform route back to the waitlist at `/`.
- `scripts/` — local admin/dev tooling (Node, REST + firebase CLI OAuth):
  `seed.js` (squads, profiles, workshops, build logs — the Learn page's content is these
  workshops), `admin-set.js` (`<uid> consent|mentor|pro`), `mentor-invite.js` (mint a
  single-use mentor invite link), `approve.js` (add/remove a founding-batch allowlist
  entry), `cleanup-test.js`, `test-applicant.js` (exercises the
  security rules as a real client), `fb-token.js` (token helper). There is no
  `seed-courses.js`.
- `firestore.rules` — the enforcement backend. `design-system.md` — visual SoT (read before
  any UI). `prd.md` — product spec. `High Agency Waitlist (standalone).html` — a standalone
  export of the waitlist (reference artifact).

## Open product questions (record, don't silently resolve)

- **Track model — UNRESOLVED.** `prd.md` describes **one shared track per cohort, mentor-
  verified once per cohort.** The code implements a **per-operator "squad model"**: each
  operator builds their *own* venture and submits *own* evidence per milestone; peer-lead
  verifies 1–3, mentor verifies 4–7; a cohort "completes" a milestone when ~75% of the squad
  is verified (`squadThreshold` in `milestones.ts`). **Neither is locked.** Do not assume one
  over the other or quietly "fix" the code to match the PRD — surface the divergence and let
  the team decide. If a decision gets made, update `prd.md`, this file, and the code together.

## Conventions

- **UI:** [`design-system.md`](design-system.md) ("Operator OS", **light-mode only**) is the
  visual source of truth — read it before touching UI; a living reference renders at
  `/styleguide`. Warm paper canvas with a gentle abstract wash; white cards that **float** on
  soft warm shadows by default. Two accents with one job each: **ember** = action, **lime/green**
  = earned/verified (lime as fill, deep green `--signal-text` for verified text). The primary
  CTA is a tactile **3D push button** (base edge + travel-on-click). **Fraunces** display /
  **Schibsted Grotesk** body / **Geist Mono** for data. Gradients only as same-hue tonal depth
  on small functional surfaces. Left-aligned, asymmetric, body ≥16px, monochrome-outline icons,
  colors via CSS variables in `app/globals.css` (never hardcode hex).
- **Privacy is structural, not incidental.** Never put minor PII (email, DOB, full name,
  exact city) on the public `Profile` or anywhere client-readable; it lives only in
  `privateProfiles/{uid}`. Any new community/cross-cohort surface needs moderation/reporting.
- **Keep the rules in lockstep with the data model.** A data-shape or write-path change is
  incomplete until `firestore.rules` reflects it.
- **Path alias:** `@/*` → repo root (e.g. `@/app/lib/db`).
- **Real-content placeholders** in seed/test data — never striped boxes or lorem.

## Commands

```bash
npm run dev      # next dev (localhost:3000)
npm run build    # next build
npm run lint     # eslint

# Local admin / data tooling (need `firebase login` as info@high-agency.io first):
node scripts/seed.js                        # seed squads, profiles, workshops, build logs
node scripts/admin-set.js <uid> mentor      # promote a mentor directly (also: consent | pro)
node scripts/mentor-invite.js "<label>" 30  # mint a single-use mentor invite link (days opt.)
node scripts/approve.js <email> mentor      # founding-batch allowlist (also: operator | --remove)
node scripts/staff-referrals.js             # staff lead-source codes: DRY RUN (add --apply, --json)
node scripts/cleanup-test.js <cohortId>     # remove smoke-test artifacts

# Tests (wrap the Firestore emulator; pinned firebase-tools@13 devDep):
npm test              # rules + referral + consent + mentor-invite + hubspot + staff-code suites
npm run test:rules    # firestore.rules enforcement (tests/rules.test.mjs)
npm run test:referral # waitlist referral counters, rules + model (tests/referral.test.mts)
npm run test:consent  # server consent-token logic (tests/consent.test.mts)
npm run test:mentor   # server mentor-invite logic (tests/mentorInvite.test.mts)
npm run test:hubspot  # CRM sync logic (tests/hubspot.test.mts)
npm run test:staff    # staff lead-source code provisioning (tests/staffReferrals.test.mts)
```

Beyond those suites, `scripts/` are manual smoke-test + seed/admin helpers.

## Gotchas

- **Firebase project is `highagency-62e67`, support email `info@high-agency.io`.** The account
  that owns it is `info@high-agency.io` — `firebase login` as that identity before running any
  `scripts/*`. The old `canary-os` project is retired; treat any lingering `canary-os` reference
  as a stale bug to fix, not as expected infra.
- **App and tooling now target the same project** (`highagency-62e67`). This was *not* true
  historically — a mid-June config change left `.firebaserc`/scripts on `canary-os` while the app
  moved to `highagency-62e67`; that split has been reconciled. If you re-point the app to a new
  project, re-point `.firebaserc`, `firebase.json`, and every `scripts/*` in the same change.
- **Nothing is deployed.** `firestore.rules` lives in the repo but confirm it's actually
  **deployed** to `highagency-62e67` (`firebase deploy --only firestore:rules`) before trusting
  the live security posture — a repo rules file is not a deployed rules file.
- **The `app/api/**` routes need Firebase Admin credentials in their runtime env.** Locally,
  Application Default Credentials or the emulator suffice; on Vercel, set
  `FIREBASE_SERVICE_ACCOUNT` (or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) or every
  server-authoritative flow — parental consent **and** mentor-invite redemption — 500s. Same
  secret serves both.
- **Firebase web config keys are public by design** (committed in `app/lib/firebase.ts`);
  security comes from Firestore rules, not from hiding keys. Don't "fix" this by removing
  them. They're overridable via `NEXT_PUBLIC_FIREBASE_*` env vars.
- **Several mechanics are "client-trusted v1"** — streak updates, self-reported workshop
  attendance, and verifier XP payouts are written from the client (rules bound XP writes but
  trust the client otherwise). These are intentional shortcuts for the founding batch and the
  prime candidates to move into server actions/route handlers. Don't treat them as airtight.
- **`applications`** (waitlist) is a create-only, never-readable collection (applicant PII);
  the only public readables are the `meta/waitlist` counter and the `referrals/{code}`
  counters. Don't add read paths to `applications` — referral attribution lives on the
  application doc precisely so the referral graph is never client-readable.
- **Referral counters are written unauthenticated** (the waitlist is public). The rules
  bound the *shape* of a write, not who makes it: +1 confirmed per write, `credited`
  capped, `pos` recomputed exactly. A determined caller can still replay the +1 — same
  client-trusted v1 posture as `meta/waitlist`, not an oversight.
