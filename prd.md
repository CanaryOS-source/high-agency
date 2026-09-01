> **Revision note (2026-09-01).** The platform diverges from this document in four places,
> by decision: (1) there is **no XP, no levels and no level gating** — the only game
> mechanic is the streak; (2) **workshops are independent of the track** and are any-topic
> sessions a mentor hosts, with seats, and with Google Calendar + Meet integration; (3) the
> **track is written from scratch by each squad's mentor** (up to 20 steps, marked done for
> the whole squad) — there are no operator submissions, no peer-leads and no verification
> tiers; (4) mentor ↔ squad check-ins are confirmed server-side and land on Google Calendar.
> `CLAUDE.md` is the current source of truth where the two disagree.

# Product Requirements Document: High Agency Platform — v1

**Revenue model variant:** Freemium (mentorship \+ premium features gated)   
**Version:** 1.0   
**Date:** 2026-06-06   
**Author:** Sai Amartya B.L (High Agency crew)   
---

## Executive summary

High Agency runs a live cohort coaching program that teaches ambitious students "what school can't teach" — agency, real-world skill, and a network. Today it runs on bi-weekly Google Meet calls, Slack, and a HubSpot site. It does not scale, it is hard to make sticky between calls, and the value is invisible to anyone who hasn't joined.

The High Agency Platform productizes that program into a gamified, cohort-based launchpad. Students join a tight cohort and progress together through one shared skill track of real-world milestones (e.g. ship an MVP, land first user, reach first $100 MRR), attend live expert workshops, and build real initiatives together — with streaks and accountability keeping them moving between sessions. The model is deliberately practical: progress is earned by doing real things and verified by a mentor, not by completing solo theory exercises. v1 ships to a free founding batch of \~50 students to validate engagement and harvest proof (testimonials, shipped outcomes) before monetization is switched on.

Why now: AI is collapsing the value of conventional credentials, three in four students say school feels meaningless, and fewer than one in ten universities teach AI literacy. Ambitious students are ready to build but lack a structured path and a tribe. High Agency already has the curriculum, the mentor (Josh), and a brand; the platform is what lets it scale past a handful of cohorts.

In this variant, the platform is free to use at its core — cohorts, profiles, the cohort skill track, community, and gamification stay free to maximize reach and the network effect — while the high-value mentorship layer (live expert workshops, office hours, and other advanced features) sits behind a paid tier. The free tier is the funnel; mentorship is the thing worth paying for.

---

## Problem statement

**Current situation:** Conventional education rewards conformity and outdated skills while employers increasingly want original thinkers and operators. The evidence is stark: 75% of high-school graduates feel unprepared to make college/career decisions, three in four students say school feels meaningless, only 22% report a strong sense of purpose, and fewer than 10% of universities have integrated AI literacy. Ambitious students in particular lack three things: a supportive network ("their tribe"), structured guidance to navigate building in the modern economy, and a launchpad that converts ambition into momentum. High Agency solves this in live cohorts today, but the format caps at a few dozen students, leaks engagement between bi-weekly calls, and can't prove its value to outsiders.

**Proposed solution:** A web platform that wraps the existing coaching program in structure, accountability, and gamification. Students form or join cohorts of fellow operators, progress together through a single shared skill track made of real-world milestones, enroll in live workshops led by credentialed mentors, and keep momentum through streaks and visible progress. The platform becomes the connective tissue between live sessions and the system of record for each cohort's growth.

**Business impact:** A free core maximizes top-of-funnel reach and builds the network the brand promises ("find your tribe"), while a paid mentorship tier monetizes the highest-value, highest-cost part of the program (live expert time). Success in batch 1 proves both the engagement loop and that students experience mentorship as clearly worth paying for. Strong free-tier engagement is also the asset that makes paid conversion possible.

---

## Success metrics

**Primary KPIs (engagement & proof — batch 1, free)**

- Activation: ≥ 80% of batch-1 students complete onboarding and join or form a cohort within 7 days of access. Measured via onboarding funnel events.  
- Cohort formation: ≥ 8 active cohorts (\~5–6 operators each) formed in batch 1\. Measured by cohorts with ≥ 3 members and ≥ 1 completed activity.  
- Sustained engagement: ≥ 50% weekly active users sustained across an 8-week season. Measured by WAU / enrolled.  
- Milestone progress: ≥ 70% of active cohorts complete ≥ 4 shared milestones over the season. Measured by mentor-verified milestone events per cohort.  
- Live workshop attendance: ≥ 60% of enrolled students attend each workshop live. Measured via Meet attendance reconciliation.  
- Outcome proof: ≥ 3 cohorts ship something real (first revenue or a launched product) and ≥ 20 video testimonials collected by end of batch 1\.  
- Satisfaction: NPS ≥ 50 at mid-season and end-of-season pulse.

**Primary KPIs (monetization — once the paid tier is on, post-batch-1)**

- Free-to-paid conversion: ≥ 8% of active free users upgrade to the paid mentorship tier within a season (freemium conversion runs lower than trial-based, so this is the realistic bar).  
- Paid-feature attach: ≥ 60% of paid users attend at least one paid workshop per month (proves they're paying for mentorship, not lapsing).  
- Monthly churn on the paid tier: \< 8% in the first three paid months.  
- MRR and trailing LTV:CAC ≥ 3:1 by the end of the first paid season.  
- Free-tier health: free-tier WAU stays flat or grows after the paywall is introduced (i.e. gating mentorship didn't gut engagement).

**Validation:** Engagement KPIs are measured continuously through batch 1, with formal mid-season (week 4\) and end-of-season (week 8\) reviews. Monetization KPIs begin the first season the paid tier is live and are reviewed monthly. The free/paid line is explicitly revisited after the first paid season — if conversion is starved because the free tier is too generous, the line moves.

---

## User personas

**Primary — The Operator (ambitious student, 13–19)**

- Role: high-school or early-college student who wants to build, not just study.  
- Goals: find a tribe of equally driven peers, gain real skills (selling, building, raising), and turn ambition into a shipped initiative with real leverage.  
- Pain points: school feels meaningless and disconnected from real goals; no peers who "get it"; no structured path from ambition to action; no access to people who've done it.  
- Technical level: intermediate — fluent with consumer apps and AI tools, not necessarily technical builders.

**Secondary — The Mentor (industry expert / cohort lead, incl. Josh)**

- Role: experienced operator who teaches via live workshops and guides cohorts.  
- Goals: give back, scout talent, build reputation; do it without heavy admin overhead.  
- Pain points: scheduling and logistics friction; no easy way to see who's engaged or who needs help; teaching value is invisible/unmeasured.  
- Technical level: varies; tools must be near-zero-friction.

Parent persona is intentionally deferred to Phase 3 (see Phasing). Josh wants a layer that connects parents to their kids and lets them propel them forward, expanding the ecosystem through parent-generated content and coaching — but it is out of scope for v1.

---

## User stories & acceptance criteria

### Join or form a cohort

**As an** Operator **I want to** join an existing cohort or start my own **so that** I'm building alongside peers, not alone.

- [ ] From onboarding, a student can either request to join an open cohort or create a new one as a founding member.  
- [ ] When requesting to join, the existing cohort can view the applicant's HA profile and book a call before accepting.  
- [ ] A student cannot be a founding member of more than one active cohort at a time; the system blocks and explains this.  
- [ ] If no cohort fits, the student is shown a "start your own" path and/or a waitlist, never a dead end.  
- [ ] Cohort formation and participation are available on the free tier.

### Progress the cohort skill track

**As a** cohort **we want to** progress together through shared milestone nodes **so that** our real-world building progress is structured, visible, and verified.

- [ ] A cohort sees one shared skill track with a map of milestone nodes in locked/unlocked/completed states.  
- [ ] Milestone nodes (e.g. "reach your first $100 MRR") require evidence submission and unlock only after a mentor verifies the milestone once for the whole cohort.  
- [ ] Verified milestone completion updates the cohort's shared progress and contributes to streaks/points for the cohort.  
- [ ] The cohort skill track is available on the free tier.

### Attend a live workshop (paid)

**As an** Operator **I want to** attend expert-led workshops **so that** I learn directly from people who've done it.

- [ ] Free users can browse the full workshop catalog and see what they're missing.  
- [ ] Enrolling in a paid workshop prompts a free user to upgrade; paid users enroll directly and get a calendar invite.  
- [ ] At start time, the join link is live for entitled users; attendance is recorded for the attendance/attach KPIs.

### Maintain momentum (gamification)

**As an** Operator **I want to** build and keep a streak **so that** I stay consistent between sessions.

- [ ] Daily qualifying actions (login, node completion, workshop attendance) extend the streak.  
- [ ] A missed day breaks the streak with a clear, non-punitive reset and an easy restart.  
- [ ] Streaks and key milestones are visible on the student's profile and within their cohort.  
- [ ] Streaks/gamification are available on the free tier.

### Upgrade to unlock mentorship (monetization)

**As a** free user **I want to** upgrade to the paid tier at the moment I hit a mentorship paywall **so that** I can access live workshops and office hours without losing my place.

- [ ] The paywall moment (enrolling in a paid workshop or booking office hours) shows a clear value-framed upgrade prompt, not a hard wall.  
- [ ] Upgrading is self-serve and returns the user to exactly where they were.  
- [ ] For users under the age of majority, the payer and consent-giver is a parent/guardian; a minor cannot complete checkout alone.  
- [ ] Downgrading or lapsing returns the user to the full free tier with all free progress intact; only paid features re-lock.

---

## Functional requirements

### Onboarding & HA Profile

- Description: account creation, age/consent capture, and a profile that captures what the operator is building, their interests, and skills — the artifact cohorts use to evaluate applicants.  
- User flow: sign up (Google SSO) → age gate → (if under 18\) parental consent step → build profile → guided into cohort discovery.  
- Edge cases: under-age user without parental consent is held in a pending state with no community access; incomplete profile blocks cohort application with a clear checklist.  
- Error handling: SSO failure falls back to email; consent email bounce surfaces a retry path.

### Cohorts (free)

- Description: tight founding-member teams building a real HA initiative, with the ability to recruit members and request help from other cohorts. Core to the free network.  
- User flow: discover cohorts → apply (profile shared) → cohort reviews and optionally books a call → accept/decline → active cohort workspace. Cohorts can post cross-cohort help/opportunity requests to the community.  
- Edge cases: empty/stalled cohort (no activity for N days) is flagged and offered a merge or re-match; applicant ghosted by a cohort is auto-released to reapply after a timeout.  
- Error handling: failed call booking falls back to async messaging; duplicate applications are de-duplicated.

### Cohort Skill Track (free)

- Description: each cohort shares one skill track — a sequence of practical, real-world milestone nodes (e.g. ship an MVP, land first user, reach first $100 MRR) spanning the core building domains (building, selling, raising, operating). There is one track per cohort, progressed by the team together, not independent per-student tracks. Theoretical/scenario nodes are intentionally excluded from v1 (see Out of scope and Phasing).  
- User flow: cohort sees its shared track → works toward the next milestone in the real world → submits evidence → a mentor verifies the milestone once for the whole cohort → progress \+ rewards update for the cohort.  
- Edge cases: contested or insufficient evidence is returned by the mentor with a reason and can be resubmitted; a stalled cohort that hasn't progressed a milestone in N days is flagged (ties into the cohort stalled-state handling).  
- Error handling: evidence upload failure retries and never loses the milestone state; a verification left pending surfaces a reminder to the assigned mentor.  
- v1 content: launch with one well-defined milestone track (a single ordered set of milestones with clear evidence criteria) that every cohort uses. Keeping it to one shared track is the core simplification — it makes the experience practical, keeps mentor verification light (once per cohort per milestone), and avoids building and maintaining many independent tracks.

### Live Workshops & Mentorship (paid)

- Description: scheduled, expert-led live sessions plus office hours — the human coaching core of High Agency, and the primary thing the paid tier unlocks.  
- User flow: mentor schedules a workshop → all users browse the catalog → free users see an upgrade prompt on enroll; paid users enroll → calendar invite \+ reminders → join via Google Meet → attendance recorded.  
- Edge cases: mentor no-show triggers an apology \+ reschedule flow; over-capacity enrollment moves paid users to a waitlist with auto-promotion.  
- Error handling: broken Meet link regenerates; reminder delivery failure falls back to in-app notification.  
- Integration: Google Meet for delivery, calendar invites for scheduling. v1 does not build native in-app video.
- **As built (supersedes the above for office hours):** the catalog is
  **workshops only**, and every workshop is **owned** by the mentor who authored
  it and **capped** at a fixed seat count — over-capacity enrollment is refused
  at the rules level and shows a "Full" state rather than a waitlist (waitlists
  with auto-promotion are not built). **Office hours are no longer a catalog
  item.** They became **squad check-ins**: a squad requests time from *its own
  assigned mentor* and that mentor sets a time and link; the session is visible
  only to that squad and that mentor. A squad gets its mentor when one adopts it
  from the `/admin` feed, and a squad cannot leave `forming` without one. See
  "Deferred — mentor sessions" in Out of scope.

### Gamification (free)

- Description: streaks, points, and lightweight visible progress to drive consistency. Free, because it's the engagement engine that feeds conversion.  
- User flow: qualifying actions (login, cohort milestone verification, workshop attendance) accrue points and extend streaks; milestones surface badges on profile and in-cohort.  
- Edge cases: timezone handling so a "day" is defined by the user's local day; clock manipulation is ignored server-side.  
- Error handling: delayed event processing reconciles streaks retroactively within a grace window.  
- Out of scope for v1: head-to-head cohort competition brackets and leaderboards ranking cohorts on revenue shipped — deferred to Phase 2\.

### Monetization & Access Control (Variant B — Freemium)

- Description: a free tier (cohorts, profiles, the cohort skill track, community, gamification) and a paid tier that unlocks mentorship (live expert workshops, office hours, and designated advanced features). Sold after the free founding batch.  
- User flow: everyone starts free → hits a paywall moment (paid workshop or office hours) → value-framed upgrade prompt → self-serve checkout → entitlement granted, returned to context. Parent is payer and consent-giver for minors.  
- Entitlement logic: features are tagged free vs paid; the paid tier is a recurring subscription (with an optional per-workshop purchase considered for Phase 2). Lapse/downgrade re-locks only paid features; all free access and progress persist.  
- Edge cases: failed payment enters a grace period with retries before re-locking paid features; refund within 30 days revokes the paid tier; the free/paid line is a config so it can move without a rebuild.  
- Error handling: all card handling is delegated to Stripe (no card data stored); webhook failures reconcile entitlement state on a schedule.  
- Pricing & the free/paid line: paid-tier price TBD by Josh \+ crew. The default line is mentorship \= paid (live workshops, office hours); everything that builds the tribe and momentum (cohorts, community, the cohort skill track, streaks) \= free. With premium tracks removed in the simplified model, mentorship is the sole paid unlock — this makes the line cleaner but also means conversion rests entirely on the perceived value of live mentor time, so that value must be obvious.

### Out of scope (v1)

- Theoretical/scenario nodes (individual decision-tree challenges with feedback) — deferred; a simple version returns in Phase 2 (see Phasing).  
- Premium/advanced paid skill tracks — removed in the simplified model; the cohort skill track is free and mentorship is the paid unlock.  
- Competition brackets, head-to-head cohort metrics, and investor pitch / demo day — Phase 2, gated on traction.  
- Parents layer (connect parents to kids, parent-driven content/coaching) — Phase 3\.  
- Native mobile app — web-first for v1 (responsive web only).  
- In-app video conferencing — use Google Meet.  
- Multi-tier pricing, per-workshop à la carte purchasing, automated scholarship engine, public marketplace — later.

### Deferred — mentor sessions

Decisions taken while restructuring mentor sessions (workshop capacity/ownership,
squad-scoped check-ins, mentor adoption of squads). Recorded here so the line is
movable later without re-deriving the reasoning.

- **Unlimited / webinar-style workshops (`capacity: null`) — deferred.** Every
  authored workshop now carries a required seat cap (2–200), enforced in
  `firestore.rules` as well as the UI. Uncapped sessions are a different
  product — a broadcast, not a room where a mentor knows who showed up — and
  supporting both shapes now would mean a nullable cap threading through
  enrollment, the "Full" state, and the rules for no batch-1 benefit. Legacy
  docs written before capacity existed still read as uncapped so nothing
  breaks; new ones cannot be. Turning this on later is a nullable `capacity`
  plus one branch in `isSelfEnroll()`.
- **Server-enforced workshop attendance — still deferred.** The +50 XP for
  attending a live workshop remains **client-trusted**: the operator taps
  "I went" and the client writes the XP (the rules bound the size of the
  increase but not its truth). Real enforcement needs an attendance signal we
  don't have — Meet participant reports, or a mentor-side roster check — and
  belongs in a server action alongside the other client-trusted mechanics
  (streaks, verifier payouts). Squad check-ins pay **no** attendance XP at all,
  which removes the easiest way to farm it; the weekly ritual (+25) already
  covers squad↔mentor cadence.
- **Mentor handoff / unassignment — not built.** A mentor adopts a squad
  one-way from the `/admin` feed; the rules permit self-assignment only while
  a squad has no mentor, so nothing can be stolen or reassigned from a client.
  Reassignment is a staff operation (Admin SDK) until there's demand for it.

**New environment variables** (documented here, not set in this repo):
`CRON_SECRET` — bearer token Vercel Cron presents to
`/api/cron/unassigned-squads`; without it the route refuses to run rather than
defaulting open. Optional: `OPS_EMAIL_TO` (defaults to `info@high-agency.io`).
Email reuses the existing `RESEND_API_KEY` + `CONSENT_EMAIL_FROM`.

---

## Technical constraints

**Performance:** Responsive web app targeting P95 page load \< 2s on a typical connection. Scale target for v1 is low hundreds of concurrent users (batch \~50 plus mentors/staff); architecture should not preclude scaling to low thousands without a rewrite. Live workshop join must be reliable at full-batch concurrency. Note: a free tier means total user count can outrun paying users significantly, so the free experience must stay cheap to serve.

**Security / privacy / compliance:** This is the highest-risk area because users are minors. Hard requirements: an age gate at signup; verifiable parental consent for users under 18 before any community or payment access; data minimization (collect only what the product needs); minor PII never publicly exposed; secure auth via Google SSO; content moderation and reporting on any cross-cohort/community surface; and a youth-appropriate design posture (align with COPPA and age-appropriate-design expectations — confirm exact obligations with legal for the operating jurisdictions). Payments are handled entirely by Stripe so no card data touches HA systems (PCI scope minimized). A parent/guardian is the contracting and consenting party for any minor.

**Integrations:** Google Meet (workshop and cohort call delivery), Google Calendar (invites/reminders), HubSpot (existing marketing site, CRM, and email), Stripe (paid-tier billing), and a transactional email/notification provider. Entitlement state is the source of truth for gating and must be consistent across all surfaces.

**Stack:** Next.js (App Router) / React / TypeScript, deployed on Vercel. Firestore for data and Firebase Auth (Google SSO + email/password) for identity. There is **no separate Python/Flask backend** — v1 data access runs through the Firebase client SDK gated by Firestore security rules, and sensitive or trusted-server logic (entitlement decisions, milestone-verification XP payouts, attendance, anything that must not be client-trusted) migrates into **Next.js server actions / route handlers** over time rather than a standalone service. Automated scenario-node feedback, if/when it ships in Phase 2, runs through a server action calling a hosted model API — not a standing Python service. React Native deferred to a later mobile phase.

---

## MVP scope & phasing

**Phase 1 — MVP (launch-required, free founding batch \~50)**

- Onboarding, age/consent gate, and HA profile.  
- Cohorts: formation, founding-member application, profile review, call booking, cross-cohort help requests.  
- Cohort skill track: one shared milestone track per cohort, mentor-verified once per milestone. Milestone nodes only — no theoretical/scenario nodes in v1.  
- Live workshops & office hours via Google Meet, with enrollment and attendance.  
- Gamification: streaks, points, profile/cohort progress.  
- Free/paid entitlement system and paywall prompts built in from day one (even though batch 1 is fully free) so the line can be switched on without re-architecture.

*MVP definition:* the minimum that lets \~50 founding students form cohorts, progress a shared milestone track through real building, attend live mentorship, and stay engaged between sessions — proving the engagement loop, generating testimonials/outcomes, and validating that students perceive mentorship as the clear premium worth paying for.

**Phase 2 — post-launch (paid tier on \+ traction)**

- Turn on the paid mentorship tier (entitlements, billing, refund, dunning, self-serve management) and confirm the free/paid line against real conversion data.  
- Scenario nodes (simple version): reintroduce individual theoretical decision-tree challenges as an optional learning layer on top of the cohort milestone track.  
- Competition: head-to-head cohort brackets on shipped metrics (e.g. revenue), with winners earning investor pitch / demo-day slots — consider as a paid-tier perk.  
- Per-workshop à la carte purchase option; deeper analytics.

**Future considerations (Phase 3+)**

- Parents layer: connect parents to their kids, give parents ways to propel them, and expand the ecosystem through parent-generated content and coaching (Josh's request) — a strong fit for additional paid offerings.  
- Native mobile app; automated merit-scholarship engine; broader opportunity marketplace; multi-region compliance expansion.

---

## Risk assessment

| Risk | Probability | Impact | Mitigation |
| :---- | :---- | :---- | :---- |
| Perceived as a "scam course/community" | High | High | Personal video testimonials; clear refund; prominent listing of Josh \+ mentors with credentials; tangible takeaways beyond networking; generous free tier lowers skepticism |
| Free tier too generous → conversion starves | High | High | Mentorship (live expert time) is the sole paid unlock and must stay clearly superior to the free cohort experience; make the free/paid line a config and revisit it after the first paid season; track free-to-paid conversion as a primary KPI |
| Mentor availability / service quality dips | Med | High | Keep batch 1 small (\~50); explicit mentor commitments and office-hour cadence; track attendance and responsiveness |
| Cohort cold-start (empty/stalled cohorts) | Med | Med | Seed initial cohorts; matching \+ waitlists; auto-flag stalled cohorts for merge/re-match |
| Minors-compliance failure (consent, PII, payments) | Low | High | Consent flow before access; data minimization; Stripe for payments; legal review before paid launch |
| Scope creep — building a full platform for 50 users | High | Med | Hard phasing; competition (Phase 2), scenario nodes (Phase 2), and parents (Phase 3\) explicitly deferred; one shared cohort milestone track at launch |
| Engagement decay after novelty wears off | Med | Med | Streaks \+ cohort accountability \+ live cadence as the retention engine; mid-season pulse to catch drop-off |
| Free users never see enough mentorship value to convert | Med | Med | Free preview of the workshop catalog and a sample/teaser session; value-framed paywall at the moment of intent |

---

## Dependencies & blockers

**Dependencies:**

- Mentor roster commitments and workshop content — Josh \+ cohort leads.  
- Cohort skill-track content (one ordered set of milestones with clear, mentor-verifiable evidence criteria) — HA crew.  
- Stripe account \+ the free/paid line and pricing decision — Josh \+ crew (needed before Phase 2 paid launch, not before batch 1).  
- Brand assets and positioning consistency with high-agency.io — existing brand.

**Known blockers:**

- The free/paid line must be decided before build so entitlements are tagged correctly — this is the defining decision of this variant.  
- Legal review for minor consent and payments must clear before any paid launch — engage early so it doesn't gate Phase 2\.  
- Batch-1 start date and season length are not yet set — needed to anchor the phasing calendar.

---

## Appendix

**Glossary:**

- High Agency (HA): the coaching brand/program this platform productizes.  
- Operator: an ambitious student member.  
- Cohort: a tight founding-member team building a real initiative together.  
- Cohort skill track: the single shared track of real-world milestones a cohort progresses through together (one per cohort, milestone nodes only in v1).  
- Node (milestone): a single milestone on the cohort track — a real, verifiable achievement (e.g. first $100 MRR). Theoretical/scenario nodes are deferred to Phase 2\.  
- Streak: a consistency mechanic rewarding consecutive days of qualifying activity.  
- Free/paid line: the configured boundary between free-tier and paid-tier features — in this variant, mentorship (live workshops \+ office hours) is paid and everything else is free.

**References:**

- Existing PRD (Tab 2), Google Doc: High Agency PRD.  
- Josh Newall mockup email ("mock up," 2026-06-04) — confirms direction and requests the parents layer.  
- Brand site: high-agency.io (problem framing, "Ignition / Operational Zone / Unit," "Not school. Not tutoring. A launchpad.").

