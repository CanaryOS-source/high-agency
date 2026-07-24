# Mentor sessions restructure

Branch `SaiAmartya/mentor-sessions`. Three linked changes: workshops get
capacity + real ownership, office hours become squad-scoped check-ins, and
squads are adopted by a mentor before they can activate.

`npm run build` clean · `npm test` green (63 rules + 5 consent + 8 mentor-invite).

---

## A. Workshop capacity + ownership

**Data.** `Workshop` gains `mentorUid` (owner, stamped from auth at create,
immutable after), `capacity` (required for `kind: "workshop"`, 2–200), and
`enrolledUids` (the roster, living on the workshop doc so the cap is countable
in one read and enforceable in the rules). `profiles.enrolledWorkshops` is kept
as a **mirror** — it's what the existing per-user UI reads — but the workshop
doc is authoritative.

**Enrollment** is now a Firestore transaction (`enrollWorkshop`, `db.ts`): it
re-reads the roster, refuses the seat if the room is full, and writes the
workshop + the profile mirror in one commit, so two operators racing for the
last seat can't both win. It returns `"enrolled" | "already" | "full"`; the
Learn page surfaces the loss (`"X just filled up."`) instead of failing silently.

**Rules** (`firestore.rules`):
- `isSelfEnroll()` — a signed-in user may add **exactly their own uid** and
  nothing else. Airtight only because four conditions hold together:
  `hasAll(old)` (nobody can be dropped), `size == old+1` (exactly one added),
  `uid in new` (and it's theirs), `size <= capacity` (the room can't be oversold).
- Mentor `update`/`delete` require `resource.data.mentorUid == request.auth.uid`
  — mentors can no longer touch each other's sessions. `create` must stamp the
  caller's own uid and an empty roster; `mentorUid` is immutable after.

**UI.** Seats render everywhere sessions do (`SeatChip` in `WorkshopList`, reused
by `WeekCal`): "N left" / "Full", and a full session shows a `Full` state instead
of an Enroll button. Admin form: `Seats` input (clamped to 2–200, shows how many
are already taken so the cap isn't set below the room), mentor byline is now a
**read-only** field filled from the signed-in profile, and the workshop list only
shows — and only offers Edit/Delete on — the signed-in mentor's own sessions.

## B. Office hours → squad check-ins

Office hours are gone from the catalog: `getUpcomingWorkshops` /
`getPastWorkshops` filter `kind === "office_hours"` out (client-side, to avoid a
composite index), the admin form no longer offers the kind, and `seed.js` no
longer seeds any.

New subcollection `cohorts/{cohortId}/checkIns/{id}`. Any member of a mentored
squad requests one with an optional ≤200-char note; the **assigned** mentor sets
a time, duration, and Meet link. Read scoping is `isCohortMember(cohortId) ||
isCohortMentor(cohortId)` — deliberately **narrower** than the rule on
submissions/logs, where any mentor can read: a check-in is a private
conversation with one squad, so an unrelated mentor is denied too.

Squad home shows a light nudge — "Mentor check-in · N weeks ago" / "none yet",
with an ask button once it's been ≥2 weeks or never. Nudge only; nothing is
blocked or docked. `/admin → Check-ins` is the mentor's queue across their squads.

**XP:** `markAttended` now takes the `Workshop` and no-ops for anything that
isn't `kind: "workshop"`, so check-ins pay no attendance XP. The weekly ritual
(+25) already covers squad↔mentor cadence.

## C. Mentor approval feed + activation gate

`Cohort` gains `mentorUid` / `mentorName` (absent until adopted) and
`mentorNotifiedAt` (cron bookkeeping, Admin-SDK-only).

**The gate:** `forming → active` now needs **≥3 members AND a mentor**
(`canActivate()` in `types.ts`, mirrored in `isValidCohort`). Both paths honour
it: accepting the 3rd applicant activates only if a mentor is already assigned,
and adopting a squad that already has 3 activates it in the same write.

**`/admin → Squads`** lists every squad with no mentor (name, mission, tags,
member count, days waiting, a "ready" chip at 3+). One tap assigns the signed-in
mentor. Rules allow self-assignment **only while `mentorUid` is empty** — no
stealing, no reassigning, and the founder can't write the field at all (it's on
the founder path's immutable list, so a founder can't appoint themselves and
self-activate). No cap on squads per mentor.

Squad home and both squad card surfaces show `Mentor: X`, or a muted
`Awaiting mentor`.

**Escalation:** `GET /api/cron/unassigned-squads` (Node, Admin SDK) finds
cohorts older than 7 days with no `mentorUid`, sends **one** summary email to
`info@high-agency.io` via the existing Resend setup, then stamps
`mentorNotifiedAt` so the same squad doesn't page ops daily (re-notify after 7
more days). `vercel.json` schedules it at 13:00 UTC daily.

---

## Judgment calls

1. **Check-ins as a cohort subcollection, not a top-level collection.** Read
   scoping reuses the existing `isCohortMember` / new `isCohortMentor` helpers
   and needs no collection-group index. Cost: the mentor's queue is one
   subscription per owned squad rather than one query. Mentors own a handful of
   squads, so this is the cheaper trade today; if a mentor ever holds dozens,
   move to a top-level `checkIns` with a `mentorUid` index.
2. **The roster lives on the workshop doc.** Capacity has to be countable in a
   single read to be enforceable in rules at all. `profiles.enrolledWorkshops`
   is kept in sync rather than removed so no existing read had to change, and
   the UI treats either source as "enrolled" (legacy enrollments predate the
   roster).
3. **Legacy docs read as uncapped/unowned, never as broken.** A workshop with no
   `capacity` is enrollable by anyone; one with no `mentorUid` is editable by
   nobody in-app. Prod data is near-empty, so this is belt-and-braces rather
   than a migration.
4. **`kind` dropped from the admin form, kept in the type and rules.** Legacy
   `office_hours` docs still validate and are simply hidden; nothing new can be
   authored with that kind.
5. **Cron refuses to run without `CRON_SECRET`** (503) rather than defaulting
   open. An unauthenticated endpoint that reads every squad and sends mail is
   not something to leave ajar.
6. **`mentorNotifiedAt` is stamped only after the email actually sends**, so a
   Resend outage doesn't silently swallow the alert for a week.
7. **Seed data updated** to the new shape (owned + capped workshops, no office
   hours). Seeded sessions carry a synthetic `seed-mentor` owner, so they render
   read-only in `/admin` — correct, since no signed-in mentor authored them.
8. **No waitlist on a full workshop.** The PRD sketches waitlists with
   auto-promotion; that's a whole flow (promotion, notification, expiry) and
   wasn't in scope. Full is Full, and that's now recorded in `prd.md`.

## New env vars (not set in this repo)

- `CRON_SECRET` — **required** for `/api/cron/unassigned-squads`.
- `OPS_EMAIL_TO` — optional, defaults to `info@high-agency.io`.
- Reuses existing `RESEND_API_KEY`, `CONSENT_EMAIL_FROM`, and the Admin SDK
  credentials the consent routes already need.

## Deploy note

`firestore.rules` changed substantially — it must be deployed
(`firebase deploy --only firestore:rules`) before any of this is enforced live.
