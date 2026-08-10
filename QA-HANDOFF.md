# QA handoff — giving Josh the mentor + student views

Everything you need to hand High Agency to someone outside the repo and have them
test both sides of the product end to end.

**What changed:** there is no preview deploy any more. Production
(`high-agency.io`) goes live with the platform switched **on**, and is kept safe
for strangers by a **founding-batch access gate** — only an email on the
`approvedMembers` allowlist can get an account at all. Josh QAs on production,
against a real account, like a real founding member. §1 is the go-live checklist.

---

## 1. Going live behind the access gate

Production stops being waitlist-only. `/login` is no longer a sign-in form: it
asks for one email, and either mails a single-use sign-in link (if that email is
on the allowlist) or says "you're not in the batch yet" and points at the
waitlist. There is **no Google button and no password field** — either would mint
an account for someone who isn't on the list.

> **This gate is temporary.** It exists for the founding batch and is built to be
> deleted in one commit — everything lives in files named `access*` plus the
> `approvedMembers` rules block. See `app/lib/accessGate.ts` for the removal
> checklist.

### 1a. Add someone to the allowlist — Firebase Console

The doc ID **is** the email, trimmed and lowercased. Anything else and the lookup
misses.

1. Firebase Console → project **`highagency-62e67`** → **Firestore Database**
2. Collection **`approvedMembers`** (→ **Start collection** the first time)
3. **Add document**
4. **Document ID** = the email, all lowercase — e.g. `josh@example.com`
5. Add field **`role`** · type **string** · value **`operator`** or **`mentor`**
6. Optional: `name` (string), `note` (string), `addedAt` (number, epoch ms).
   **All three are optional** — code that reads a hand-made doc must not, and
   does not, depend on them.
7. **Save**

That's the whole grant. They can now request a link at `/login`.

### 1b. Or from the terminal

```bash
firebase login                                        # as info@high-agency.io
node scripts/approve.js josh@example.com mentor "Josh N."
node scripts/approve.js someone@example.com operator
node scripts/approve.js someone@example.com --remove  # revoke
```

Same collection, same doc-ID convention — Console and script entries are
interchangeable. Removing an entry stops **new** sign-in links and blocks a fresh
profile; it does not delete an account that already exists.

### 1c. Production checklist — do all of this before flipping the flag

**Vercel → project `high-agency` → Settings → Environment Variables → Production:**

| Variable | Value / note |
|---|---|
| `NEXT_PUBLIC_PLATFORM_ENABLED` | `true` — this is the switch that opens the platform |
| `FIREBASE_SERVICE_ACCOUNT` | full service-account JSON (or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) |
| `NEXT_PUBLIC_APP_URL` | `https://high-agency.io` — sign-in and consent links are built from this |
| `RESEND_API_KEY` | without it **no sign-in emails are sent**; the link is written to the Vercel function log instead |
| `ACCESS_EMAIL_FROM` | sender for sign-in links; falls back to `CONSENT_EMAIL_FROM` |
| `CONSENT_EMAIL_FROM` | sender for parental-consent emails |
| `CRON_SECRET` | the daily unclaimed-squads sweep 503s without it |

Missing Admin credentials is the loud one: **every** server-authoritative flow —
sign-in link generation, the allowlist claim, parental consent, mentor-invite
redemption — 500s without them.

**Firebase Console → Authentication → Sign-in method:**

- ⚠️ **Enable "Email link (passwordless sign-in)".** *This is currently DISABLED
  and it is a hard blocker* — `/api/access/request` fails with
  `auth/operation-not-allowed` and nobody can sign in at all. Verified against the
  live project on 2026-08-03.
- Leave email/password enabled — `/mentor/join?code=…` (break-glass) still uses it.

**Firebase Console → Authentication → Settings → Authorized domains:**

- Add `high-agency.io` **and** `www.high-agency.io`. Email-link sign-in refuses to
  complete on a domain that isn't listed.

**Firestore:**

```bash
firebase deploy --only firestore:rules
```

The gate is enforced in the rules too, not just the UI: creating a
`profiles/{uid}` doc now requires the caller's token email to be on the
allowlist. A repo rules file is not a deployed rules file — deploy it, or the
production database is still running the old rules.

### 1d. Testing locally instead

```bash
git clone <repo> && cd high-agency
npm install
npm run dev        # http://localhost:3000
```

`next dev` turns the platform on automatically — no env var needed. Server routes
need Firebase Admin credentials (`gcloud auth application-default login`, or a
`FIREBASE_SERVICE_ACCOUNT` in `.env`). **With no `RESEND_API_KEY`, no email is
sent — the sign-in URL is printed to the dev-server console**, which is the
intended way to test the flow locally. Look for:

```
[access] No RESEND_API_KEY set — would email you@example.com a sign-in link.
[access] Sign-in link: http://localhost:3000/login/verify?...
```

Paste that URL into the browser to complete sign-in.

> **Heads-up: every environment writes to the same live Firestore project
> (`highagency-62e67`).** There is no staging database. Whatever Josh creates —
> accounts, squads, workshops, build logs — is real data in the real project.
> Name his test squads something obvious (`QA — Josh`) and clean up afterwards with
> `node scripts/cleanup-test.js <cohortId>`.

---

## 2. Giving Josh a mentor account

Mentors can never self-promote — the Firestore rules block clients from ever
writing `role: "mentor"`, so every route below is server-side.

**The normal way now: allowlist him as a mentor.** Add `josh@example.com` with
`role: "mentor"` (§1a or §1b), then he goes to `high-agency.io/login`, enters that
email, opens the link we mail him, and fills the same 3-step mentor onboarding
(name, country, headline, expertise, what he can coach) → lands on `/mentor`.

```bash
node scripts/approve.js josh@example.com mentor "Josh N."
```

**Break-glass #1 — the invite code.** Still works, unchanged, and does not need
the allowlist at all. Useful if the email gate itself is what's broken:

```bash
firebase login                              # as info@high-agency.io
node scripts/mentor-invite.js "Josh — QA" 14
```

The script prints a `/mentor/join?code=…` URL. Swap the host if you're testing
somewhere other than production. The code is printed **once** and never stored in
readable form — lose it and you mint a new one. It's single-use: the moment Josh
redeems it, it's dead.

**Break-glass #2 — promote in place.** If you just need him mentor-shaped: have
him sign up as a normal student first, get his UID from Firebase Console →
Authentication, then:

```bash
node scripts/admin-set.js <uid> mentor
```

A promoted account keeps its operator onboarding data (age band, etc.), so the
allowlist path is the more faithful test.

---

## 3. Giving Josh a student account

He still needs to be on the allowlist — that's the whole point of the gate.

1. Add him as an operator: `node scripts/approve.js josh+student@example.com operator`
   (or by hand in the Console, §1a).
2. Go to `high-agency.io/login` → enter that email → **Send me a sign-in link**.
3. Open the emailed link → operator onboarding runs exactly as before.
4. **Worth testing the reject path too:** enter an email that is *not* on the list.
   He should get "You're not in the batch yet" and an **Apply to join** button that
   lands on the waitlist — no account created, no email sent.
5. **Date of birth matters.** Under 18 puts the account into `consentStatus: pending`
   until a parent approves, which blocks applying to squads, submitting proof and
   posting build logs. For a first pass, have him use an 18+ DOB. Then do a second
   account with a minor DOB specifically to test the consent gate.
6. To unblock a minor test account without email:
   ```bash
   node scripts/admin-set.js <uid> consent
   ```
   …or grant it from the mentor account: **Squads → Parental consent → Grant**.

> A second test account needs a second allowlist entry. Gmail's `+` addressing
> (`josh+student@…`) is the cheap way to get one — but add the address exactly as
> typed, lowercased, since that's the doc ID the lookup uses.

**He'll want a squad to test against.** Either:
- Seed the demo data — `node scripts/seed.js` creates squads, operator profiles,
  workshops and build logs (idempotent, safe to re-run), or
- Have him create his own squad from **Squads → Start one**. Note it stays `forming`
  until it has **3+ members AND a mentor** — so his mentor account has to adopt it
  from **Mentor → Squads → Needs a mentor → Take it on** before it goes live.

---

## 4. Run both roles at once

The mentor↔student loops (submit proof → verify; ask for a check-in → set a time)
need two accounts signed in simultaneously.

- **Window 1 (normal):** the student account.
- **Window 2 (incognito, or a second Chrome profile):** the mentor account.

Firebase Auth stores its session in browser storage, so two normal windows share one
session and will fight each other. Incognito or a separate profile is required.

---

## 5. What changed — what Josh is checking

The headline change: **a mentor is no longer a student account with an extra admin
page.** The whole app swaps based on role.

| | Student (Operator) | Mentor |
|---|---|---|
| Sidebar | Home · Squads · Learn · You | **Home · Workshops · Squads · You** |
| XP / level / streak HUD | Yes — it's the game | **Never shown** |
| Squads tab shows | Squads to apply to | **Squads to take on and look after** |
| Workshops | Enroll in them | **A month calendar of every session + authoring** |
| "You" page | Player card: level, XP bar, progress to next level | **Expertise, what he can coach, squads, sessions ahead — no game state** |
| `/admin` | — | **Deleted.** Its work moved into Workshops and Squads |
| Getting in | Email → sign-in link (allowlist only) | Same gate, same link |

Also: default workshop seats changed **30 → 15**, and redundant labels were pruned
across the app (duplicate level chips, "why matched" chips that repeated a squad's
own tags, XP labels shown to mentors who don't earn XP).

---

## 6. QA checklist

### The access gate (do this first — nothing else is reachable without it)
- [ ] The waitlist at `/` shows a **Log in** link in the top nav (it only appears
      when the platform is enabled — its absence means the flag didn't take).
- [ ] `/login` shows **one email field and one button**. No Google button, no
      password field, no "create one" toggle.
- [ ] An email **not** on the allowlist → "You're not in the batch yet", and
      **Apply to join** goes to `/`. No email arrives.
- [ ] An email **on** the allowlist → "Check your inbox", naming that exact
      address, plus a **use a different email** link that resets the form.
- [ ] The emailed link signs him in and lands him in the right place: operator →
      `/onboarding`, mentor → mentor onboarding → `/mentor`, returning user →
      `/dashboard` or `/mentor`.
- [ ] Opening the **same link a second time** shows "This link has expired" with a
      **Get a new link** button (they're single-use).
- [ ] Opening the link in a **different browser** than it was requested from
      prompts for the email first, then completes.
- [ ] Requesting ~6 links for the same email in a few minutes starts returning a
      friendly "too many attempts" message rather than an error.
- [ ] `/mentor/join?code=…` still works end to end, independently of the gate.

### Mentor — sidebar and shell
- [ ] Sidebar reads **Home · Workshops · Squads · You**, in that order.
- [ ] **No streak flame, no level ring** anywhere in the rail or the mobile top bar.
- [ ] Manually visiting `/dashboard`, `/learn`, `/cohorts` or `/profile` redirects to
      the mentor equivalent. Visiting `/admin` 404s.
- [ ] Mobile (narrow window): the bottom tab bar shows the same four mentor tabs.

### Mentor — Home (`/mentor`)
- [ ] "Needs you" shows counters only for queues with work in them; nothing waiting →
      "Nothing waiting on you."
- [ ] Each counter links to the surface that resolves it.
- [ ] "You're on" merges his workshops and confirmed squad check-ins into one
      chronological list, with a **Join** button when there's a meet link.
- [ ] "Your squads" lists only squads he mentors.

### Mentor — Workshops (`/mentor/workshops`)
- [ ] Week calendar — the same vertical day-by-day layout operators see on their
      dashboard — shows **every** session, not just his, with times.
- [ ] **His sessions are visibly different** (ember fill) from other mentors' (grey).
      The legend says which is which.
- [ ] `‹` / `›` change week; **This week** appears once you've navigated away.
- [ ] **New session** (top right) and the **+** on any day both open the form; the
      per-day one pre-fills that date.
- [ ] **Seats defaults to 15.** Typing `500` clamps to 200; `1` clamps to 2.
- [ ] Editing a session with people enrolled shows "N already claimed" and **does not
      wipe the roster** — check the seat count is unchanged after saving.
- [ ] Edit / Delete appear **only on his own** sessions. Other mentors' rows are
      read-only.
- [ ] Deleting a session with enrolled operators warns how many will lose a seat.
- [ ] Saving a session dated in another week jumps the calendar to that week.
- [ ] Narrow window: session rows wrap and the page never scrolls sideways.

### Mentor — Squads (`/mentor/squads`)
- [ ] "Proof to verify" lists **only milestones 4–7** from squads he mentors
      (1–3 are the squad peer-lead's job and must not appear).
- [ ] **Proof** opens the evidence link; **Review** goes to the squad page.
- [ ] "Asked for time" → **Set a time** → date + minutes + meet link → **Confirm**.
      The student's squad page should immediately show the booked check-in.
- [ ] "Needs a mentor" lists unadopted squads. Each row says in plain words either
      "Ready — taking it on starts their season" or "Needs N more members before the
      season can start". **Take it on** claims it — and a squad with 3+ members flips
      from `forming` to live in the same action.
- [ ] Clicking a squad's row opens a dossier: full mission, the weekly ritual slot
      with an **ⓘ** explaining it's a proposal that usually moves, focus tags, what
      they're recruiting, and every member with their headline and what they're
      building. Clicking a member opens their full profile on top.
- [ ] Two mentors racing for the same squad: the loser's row just disappears (no error).
- [ ] **Parental consent** is a collapsed section at the bottom with a count.
      **Resend** and **Grant** both work; Grant removes the row live.

### Mentor — You (`/mentor/you`)
- [ ] **No level badge, no XP bar, no "300 to L2 Builder", no streak freezes.**
- [ ] Shows Mentor · country · timezone, plus squad and session counts.
- [ ] No student-only fields: no venture "Stage" chips (idea/building/launched/revenue).
- [ ] Expertise and "Can coach" accept preset chips **and** custom typed tags.
- [ ] Save persists; reload shows the new values.

### Mentor — squad detail (`/cohorts/[id]`, the one shared screen)
- [ ] He can read the track, submissions and build log for his squads.
- [ ] **Verify** / **Return** work on submitted proof; Return requires a reason.
- [ ] He does **not** see: the "We met +25" ritual button, the build-log composer,
      "Submit proof", the applications panel, or per-milestone `+XP` labels.

### Student — nothing regressed
- [ ] Sidebar still reads Home · Squads · Learn · You, HUD still present.
- [ ] Dashboard: build log posts, streak ticks, "Next up" milestone renders.
- [ ] Squads: matched squads show "why matched" chips **without** a duplicate plain
      chip saying the same thing (e.g. no "Both building ai" *and* an "AI" chip).
- [ ] Learn: a level-gated session he can't enter shows a padlock reading **Locked**,
      with the level named once in the row chip — not twice.
- [ ] Enrolling in a workshop takes a seat; the seat count drops for everyone.
- [ ] Minor account: consent banner appears, and applying / submitting / logging are
      blocked until granted.

### The full loop (both windows)
- [ ] Student creates a squad → mentor adopts it → squad goes live once 3 members join.
- [ ] Student submits proof for milestone 4 → it appears in the mentor's
      "Proof to verify" → mentor verifies → student's XP goes up and the milestone
      shows "Verified by <mentor>".
- [ ] Mentor returns a submission with a reason → student sees "Returned: <reason>"
      and a **Fix & resend** button → resubmit lands back in the mentor queue.
- [ ] Student asks for a check-in → mentor sets a time → both see the booked slot.
- [ ] Mentor creates a workshop → it appears on the student's Learn page → student
      enrolls → the mentor's calendar shows the seat taken.

---

## 7. Things that will look broken but aren't

Tell Josh these up front or he'll file them as bugs:

- **No pricing, checkout or upgrade anywhere.** Monetization is deliberately deferred;
  everything is free for the founding batch.
- **Consent emails may not arrive.** Without `RESEND_API_KEY`, the approval link is
  written to the server log instead of being emailed. The UI says
  "Link logged to server (no email provider set)".
- **Video calls are Google Meet links**, not in-app video. That's v1 by design.
- **Streaks and workshop attendance are self-reported** (client-trusted). "I went"
  awards XP without verification — a known v1 shortcut.
- **The seed data is fake but realistic.** Seeded squads are real-shaped ventures
  (Tempo, Shelfware, Curbside, Northlight Tutoring…) with real-shaped teenage
  operators behind them, but nobody can sign in as them — there are no auth accounts
  for seed UIDs, so their profiles are read-only fixtures.
- **`/admin` is gone.** Old bookmarks 404 on purpose.
- **There is no password anywhere in the main flow.** Sign-in is a mailed link
  every time. That's the gate, not a missing feature.
- **"Not in the batch yet" is not an error.** It's the designed answer for an
  address nobody has approved, and it looks identical whether the address exists
  in Firebase Auth or not — deliberately, so the page can't be used to probe who
  has an account.
- **Sign-in links die after one use.** Reloading `/login/verify`, or opening the
  link twice, correctly shows the expired screen.

---

## 8. What I could not verify before handing this over

Stated plainly so nobody assumes more coverage than exists:

- **The end-to-end magic-link flow was never completed against the live project**,
  because **Email link (passwordless) sign-in is disabled** in the Firebase Console
  (§1c). `generateSignInWithEmailLink` returns `auth/operation-not-allowed`, so no
  link can be minted at all until someone flips that toggle. Verified 2026-08-03.
  Everything *around* it was exercised against live Firestore: an unapproved email
  returns `not-approved`, a malformed one returns 400, the rate limiter returns 429
  on the 6th attempt, the failure is logged server-side and returns a generic
  message with no internals, and with `RESEND_API_KEY` unset the transport logs the
  sign-in URL and reports `"logged"` instead of throwing.
- Consequently **nobody has yet signed in through the gate and landed in
  onboarding** — the first thing to retest once the provider is enabled, for both
  an operator and a mentor.
- The gate's UI states were verified by rendering `/login` (email-only, no Google
  button, no password field) but **not clicked through in a browser**.
- `firestore.rules` **did** change: `approvedMembers` is deny-all, and creating a
  profile now requires the caller's token email to be on the allowlist. This is
  covered by 7 new rules tests, but **the rules are not deployed** — run
  `firebase deploy --only firestore:rules` (§1c).
- The full suite passes: **83/83** (`npm test` — 70 rules, 5 consent, 8
  mentor-invite).
