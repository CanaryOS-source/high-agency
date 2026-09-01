# Local end-to-end QA — operator + mentor side by side

The repeatable way to exercise both apps against the live `highagency-62e67`
project from `next dev`, with no email round-trip and two accounts signed in at
once. Written for Claude driving the Browser pane, but it is the same for a human.

## The fixture (already provisioned — never recreate by hand)

| | Operator | Mentor |
|---|---|---|
| Email (allowlisted) | `saiamartya19+qa-operator@gmail.com` | `saiamartya19+qa-mentor@gmail.com` |
| Profile | `QA O.` · operator · 18+ · consent granted | `QA M.` · mentor |
| Browser origin | `http://localhost:3000` | `http://127.0.0.1:3000` |

**"QA Squad"** ties them together: the operator is its founder, the mentor
adopted it, and two seed profiles (`seed-dev`, `seed-lena`) pad it to three members so
it is `active`. Its id is printed by the fixture script:

```bash
node scripts/qa-setup.js --status     # read-only report: allowlist, uids, squad
node scripts/qa-setup.js              # repair: re-add allowlist entries / members
node scripts/qa-setup.js --adopt      # also force the QA mentor onto the squad
```

Idempotent, never deletes. If the squad is ever gone it recreates it as
`cohorts/qa-squad`. To wipe it: `node scripts/cleanup-test.js <cohortId>` then rerun.
Needs `firebase login` as `info@high-agency.io` (CLI OAuth token, like every
`scripts/*`) — if the Firebase MCP or a script says the credentials are invalid,
run `firebase login --reauth` and retry.

## One-time local setup

1. **`.env.development.local`** (gitignored) containing just `RESEND_API_KEY=`.
   A blank key turns off Resend, so `/login` prints the sign-in link to the dev-server
   console instead of emailing it ("dev inbox", `app/lib/accessEmail.ts`). `.env`
   keeps the real key for everything else. Next reloads it without a restart.
2. **`next.config.ts` → `allowedDevOrigins: ["127.0.0.1"]`** (committed). Without it
   Next 16 blocks dev assets on the second origin, the page never hydrates, and the
   login form does a native GET to `/login?`.

Why two origins: Firebase Auth keeps one session per origin (IndexedDB), so
`localhost` and `127.0.0.1` hold independent logins in one browser profile. Both
sessions survive reloads and full navigations.

## Signing in (about 20 seconds per account)

**Fastest — mint a link directly** (no browser form, no log):

```bash
node scripts/qa-setup.js --link operator    # prints a http://localhost:3000/login/verify?… URL
node scripts/qa-setup.js --link mentor      # prints a http://127.0.0.1:3000/login/verify?… URL
node scripts/qa-setup.js --link you@x.com   # any allowlisted address (lands on localhost)
```

Open the printed URL. `/login/verify` asks for the email once (it wasn't requested
from that browser), then signs you in and routes by role. Same Identity Toolkit call
the app makes, so it exercises `/login/verify` + `/api/access/claim` for real; only
the `/login` form and the email transport are skipped.

**Through the product** (exercises the `/login` form too):

1. Open `<origin>/login`, enter the QA email, submit. Expect "Check your inbox."
2. Read the dev-server log (`preview_logs` with search `[access]`, or the terminal):
   ```
   [access] Sign-in link: https://highagency-62e67.firebaseapp.com/__/auth/action?apiKey=…&mode=signIn&oobCode=…&continueUrl=http://localhost:3000/login/verify&lang=en
   ```
3. Open **on the same origin the request was made from**:
   `<origin>/login/verify?apiKey=<apiKey>&mode=signIn&oobCode=<oobCode>&lang=en`
   (skipping the firebaseapp.com hop, which only redirects to `continueUrl`). The
   origin matters because `/login/verify` reads the email back from that origin's
   localStorage; on any other origin it asks for the email instead, which also works.
4. Returning operator → `/dashboard`; returning mentor → `/mentor`.

Codes are single-use and short-lived; a used or mistyped one shows "This link has
expired" — just request another. `/api/access/request` rate-limits to 5 per 15 min
per email and per IP (in-process, so a dev-server restart clears it).

## Driving it from the Browser pane (Claude)

- One tab per origin (`tabs_create` → `navigate`). Refs from `read_page`/`find` are
  per tab and go stale after navigation.
- `form_input` works for text inputs and `<select>`s on these React forms. It does
  **not** fire React's change handler on checkboxes — use a real click (the mentor
  onboarding "I'm 18 or older" box).
- If a `ref` click does nothing (the "Start one" button did this), take a
  `screenshot` and click by coordinate.
- The `/login` hydration-mismatch warning about `autoComplete` / `data-bro-*`
  attributes comes from the Aside browser extension, not the app.
- Every write is real data in the real project. Keep test artifacts inside QA Squad,
  and name anything new `QA …`.

## What to check after a change

- Operator: `/dashboard` (streak, "Now" from the track, build log, this week's
  sessions), `/cohorts`, `/cohorts/<qa-squad-id>` (read-only track, build log and ritual — both
  via server routes, watch the flame move — ask for a check-in), `/learn` (enroll / leave), `/profile`.
- Mentor: `/mentor` (queues + "New workshop" composer + calendar prompt),
  `/mentor/squads` (check-in requests, "Needs a mentor" feed), `/mentor/workshops`
  (week calendar, edit/delete own), `/mentor/you` (card + Google Calendar connect),
  `/cohorts/<qa-squad-id>` (track editor: template, edit, reorder, mark done).
- Cross-role loops need both tabs: mentor marks a step done → operator's track and
  "Now" tile move; operator asks for a check-in → mentor sets a time → operator sees
  it; mentor schedules a workshop → operator enrolls → mentor's seat count moves.
  Role guards: operator on `/mentor` → `/dashboard`; mentor on `/dashboard` → `/mentor`.
- Google Calendar is optional locally. Without `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  in `.env.local` the connect card says so and sessions take a pasted Meet link.
- `npm test` for rules/model changes; the QA accounts do not replace it.
