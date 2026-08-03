# QA handoff — giving Josh the mentor + student views

Everything you need to hand High Agency to someone outside the repo and have them
test both sides of the product end to end.

**The one blocker to solve first:** production (`high-agency.io` /
`highagencyio.vercel.app`) is a **waitlist page only**. The authenticated platform
is gated off by `NEXT_PUBLIC_PLATFORM_ENABLED`, so Josh cannot QA anything by
visiting the live site. Pick a path in §1 before you send him anything.

---

## 1. Where Josh actually tests

Three options. **Option B is the recommended one** — Josh gets a URL, and production
stays a waitlist.

| | Setup effort | Josh needs | Prod risk |
|---|---|---|---|
| **A. Local dev** | Low for you, high for him | Node, the repo, a terminal | None |
| **B. Vercel Preview** ✅ | ~15 min, one time | A link | None — preview only |
| **C. Turn on production** | 1 env var | A link | **Real; don't** |

### Option B — a preview deployment with the platform switched on

1. **Add the platform flag to the Preview environment only.** In the Vercel
   dashboard (project `high-agency`) → Settings → Environment Variables, or:

   ```bash
   vercel env add NEXT_PUBLIC_PLATFORM_ENABLED preview
   # value: true
   ```

   Do **not** add it to Production. Production keeps the waitlist.

2. **Add the Firebase Admin credentials to Preview.** Without these, parental
   consent and mentor-invite redemption return 500 — meaning Josh literally cannot
   become a mentor. One of:

   - `FIREBASE_SERVICE_ACCOUNT` — the whole service-account JSON, or
   - `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`

   Optional but useful:
   - `NEXT_PUBLIC_APP_URL` — set to the preview URL so consent links in emails
     point at the preview, not localhost.
   - `RESEND_API_KEY` + `CONSENT_EMAIL_FROM` — without these, consent emails aren't
     sent; the link is logged to the Vercel function logs instead. That's fine for
     QA as long as Josh knows to ask you for the link.

3. **Push a branch and grab the preview URL.**

   ```bash
   git checkout -b qa/mentor-views
   git push -u origin qa/mentor-views
   ```

   Vercel comments the preview URL on the branch, or `vercel ls` shows it.

4. **⚠️ Tell Josh to sign in with email + password, not Google.** Google SSO needs
   the exact domain listed under Firebase Console → Authentication → Settings →
   Authorized domains, and every preview deploy gets a fresh hostname. Email/password
   has no such restriction and works immediately. (If you want SSO to work, add the
   stable alias `high-agency-<team>.vercel.app` to Authorized domains and give Josh
   that URL rather than the per-commit one.)

### Option A — local, if Josh is comfortable in a terminal

```bash
git clone <repo> && cd high-agency
npm install
npm run dev        # http://localhost:3000
```

`next dev` turns the platform on automatically — no env var needed. The server-side
routes (consent, mentor redeem) need Application Default Credentials locally:
`gcloud auth application-default login`.

> **Heads-up: every environment writes to the same live Firestore project
> (`highagency-62e67`).** There is no staging database. Whatever Josh creates —
> accounts, squads, workshops, build logs — is real data in the real project.
> Name his test squads something obvious (`QA — Josh`) and clean up afterwards with
> `node scripts/cleanup-test.js <cohortId>`.

---

## 2. Giving Josh a mentor account

Mentors are **invite-only**. There is no signup link and no way to self-promote —
the Firestore rules block clients from ever writing `role: "mentor"`.

```bash
# Log in as the project owner first (once):
firebase login          # as info@high-agency.io

# Mint a single-use invite valid for 14 days:
node scripts/mentor-invite.js "Josh — QA" 14
```

The script prints two URLs — a localhost one and a `high-agency.io` one. **Neither
is what you send for a preview deploy.** Take the `?code=…` value and paste it onto
the preview host:

```
https://<preview-url>/mentor/join?code=<the-code-it-printed>
```

The code is printed **once** and never stored in readable form. If you lose it, mint
a new one. It's single-use — the moment Josh redeems it, it's dead.

Josh then: opens the link → creates an account (email + password) → fills a short
3-step mentor onboarding (name, country, headline, expertise, what he can coach) →
lands on `/mentor`.

**Break-glass alternative** — if the invite flow misbehaves and you just need him
mentor-shaped: have him sign up as a normal student first, get his UID from Firebase
Console → Authentication, then:

```bash
node scripts/admin-set.js <uid> mentor
```

This promotes the account in place. Note that a promoted account keeps its operator
onboarding data (age band, etc.), so the mentor invite path is the more faithful test.

---

## 3. Giving Josh a student account

No invite needed — he signs up normally.

1. Go to `<preview-url>/login` → **Create one** → email + password.
2. Complete onboarding.
3. **Date of birth matters.** Under 18 puts the account into `consentStatus: pending`
   until a parent approves, which blocks applying to squads, submitting proof and
   posting build logs. For a first pass, have him use an 18+ DOB. Then do a second
   account with a minor DOB specifically to test the consent gate.
4. To unblock a minor test account without email:
   ```bash
   node scripts/admin-set.js <uid> consent
   ```
   …or grant it from the mentor account: **Squads → Parental consent → Grant**.

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

Also: default workshop seats changed **30 → 15**, and redundant labels were pruned
across the app (duplicate level chips, "why matched" chips that repeated a squad's
own tags, XP labels shown to mentors who don't earn XP).

---

## 6. QA checklist

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

---

## 8. What I could not verify before handing this over

Stated plainly so nobody assumes more coverage than exists:

- The mentor screens were **type-checked, linted and built clean**, and every route
  (`/mentor`, `/mentor/workshops`, `/mentor/squads`, `/mentor/you`) responds and
  correctly bounces a signed-out visitor to `/login`.
- They were **not** clicked through against a live signed-in mentor account — that
  needs credentials I don't have. The calendar's visual density, the ember/grey
  distinction between own and others' sessions, and the mobile collapse are the
  things most worth a human eye first.
- The `firestore.rules` were **not** changed by this work (no data shapes moved).
  The full suite passes: **76/76** (`npm test` — 63 rules, 5 consent, 8 mentor-invite).
