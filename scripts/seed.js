// Seed pre-formed squads, operator profiles, build logs, and the season
// workshop calendar into Firestore via the REST API, authenticated with the
// firebase CLI's OAuth token (IAM bypasses security rules).
// Idempotent: fixed document ids, PATCH = upsert. Run: node scripts/seed.js
const { getAccessToken } = require("./fb-token");

const PROJECT = "highagency-62e67";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const s = (v) => ({ stringValue: v });
const n = (v) => ({ integerValue: String(v) });
const b = (v) => ({ booleanValue: v });
const ts = (d) => ({ timestampValue: d.toISOString() });
const arr = (items) => ({ arrayValue: { values: items.length ? items : [] } });
const map = (fields) => ({ mapValue: { fields } });

// ─── Profiles ──────────────────────────────────────────────────────────────
// Seed operator profiles for every fake UID used in cohorts below.
// Admin REST API bypasses rules so we can create docs for non-auth UIDs.

function profile({ uid, name, ageBand, country, timezone, headline, building,
  stage, domains, skills, hours, xp, streak, daysAgo }) {
  const updatedAt = new Date(Date.now() - (daysAgo ?? 0) * 86400000);
  return {
    fields: {
      uid: s(uid),
      name: s(name),
      ageBand: s(ageBand),
      country: s(country),
      timezone: s(timezone),
      headline: s(headline),
      building: s(building),
      stage: s(stage),
      domains: arr(domains.map(s)),
      skills: arr(skills.map(s)),
      proofUrl: s(""),
      proofNote: s(""),
      hours: s(hours),
      bio: s(""),
      links: map({ github: s(""), linkedin: s(""), site: s("") }),
      consentStatus: s("granted"),
      plan: s("free"),
      role: s("operator"),
      xp: n(xp ?? 0),
      streak: n(streak ?? 0),
      streakFreezes: n(0),
      lastActiveDay: s("2026-06-12"),
      lastBuildLogDay: s(""),
      lastRitualWeek: s(""),
      enrolledWorkshops: arr([]),
      attendedWorkshops: arr([]),
      pendingApplications: arr([]),
      updatedAt: ts(updatedAt),
      createdAt: ts(updatedAt),
    },
  };
}

const profiles = {
  "seed-maya": profile({
    uid: "seed-maya", name: "Maya C.", ageBand: "18+",
    country: "Canada", timezone: "America/Toronto",
    headline: "AI writing coach hitting 300 daily active students",
    building: "Real-time feedback on academic essays powered by LLMs. 300 DAU, free tier, building monetization now.",
    stage: "launched", domains: ["AI", "Web/Apps"], skills: ["Coding", "Marketing"],
    hours: "10+", xp: 420, streak: 14, daysAgo: 21,
  }),
  "seed-dev": profile({
    uid: "seed-dev", name: "Dev P.", ageBand: "18+",
    country: "India", timezone: "Asia/Kolkata",
    headline: "Building a no-code backend tool used by 50 indie hackers",
    building: "Drag-and-drop REST API builder. 50 beta users, closed alpha. Working on onboarding.",
    stage: "building", domains: ["AI", "Web/Apps"], skills: ["Coding", "Design"],
    hours: "10+", xp: 310, streak: 8, daysAgo: 20,
  }),
  "seed-lena": profile({
    uid: "seed-lena", name: "Lena F.", ageBand: "18+",
    country: "Germany", timezone: "Europe/Berlin",
    headline: "Chrome extension that summarises Notion docs into Slack threads",
    building: "Integrating Notion + Slack for async teams. 200 waitlist signups. Launching next month.",
    stage: "building", domains: ["AI", "Web/Apps"], skills: ["Coding", "Marketing"],
    hours: "5-10", xp: 180, streak: 5, daysAgo: 18,
  }),
  "seed-arjun": profile({
    uid: "seed-arjun", name: "Arjun M.", ageBand: "18+",
    country: "UK", timezone: "Europe/London",
    headline: "Dropshipping electronics on Amazon — first $500 earned",
    building: "Automated Amazon FBA operation for budget electronics. Profitable, scaling ad spend.",
    stage: "revenue", domains: ["E-commerce"], skills: ["Sales/Outreach", "Ops"],
    hours: "10+", xp: 550, streak: 22, daysAgo: 14,
  }),
  "seed-sofia": profile({
    uid: "seed-sofia", name: "Sofia R.", ageBand: "18+",
    country: "Spain", timezone: "Europe/Madrid",
    headline: "Etsy printables shop — 30 sales in first 2 weeks",
    building: "Digital printables for educators and students. 30 sales, aiming for 200/month.",
    stage: "revenue", domains: ["E-commerce", "Content"], skills: ["Design", "Marketing"],
    hours: "3-5", xp: 280, streak: 10, daysAgo: 12,
  }),
  "seed-tomas": profile({
    uid: "seed-tomas", name: "Tomas E.", ageBand: "18+",
    country: "Czech Republic", timezone: "Europe/Berlin",
    headline: "YouTube creator on embedded systems — 2k subs in 90 days",
    building: "Build-in-public YouTube channel on embedded systems. 2k subs, monetization at 4k.",
    stage: "building", domains: ["Content", "Hardware"], skills: ["Video", "Writing"],
    hours: "10+", xp: 390, streak: 30, daysAgo: 10,
  }),
  "seed-amara": profile({
    uid: "seed-amara", name: "Amara O.", ageBand: "18+",
    country: "Nigeria", timezone: "Africa/Lagos",
    headline: "Newsletter teaching African founders to think like operators",
    building: "Weekly newsletter on operator mindset for African founders. 800 subscribers, 42% open rate.",
    stage: "launched", domains: ["Content", "Nonprofit"], skills: ["Writing", "Marketing"],
    hours: "5-10", xp: 240, streak: 12, daysAgo: 9,
  }),
  "seed-jules": profile({
    uid: "seed-jules", name: "Jules M.", ageBand: "18+",
    country: "France", timezone: "Europe/Paris",
    headline: "Short-form video for B2B SaaS — 10 brand deals pending",
    building: "Freelance video production for SaaS startups. Built a 15k TikTok following, converting to brand deals.",
    stage: "launched", domains: ["Content"], skills: ["Video", "Sales/Outreach"],
    hours: "10+", xp: 460, streak: 18, daysAgo: 8,
  }),
  "seed-nina": profile({
    uid: "seed-nina", name: "Nina K.", ageBand: "18+",
    country: "Poland", timezone: "Europe/Warsaw",
    headline: "Cold outreach SaaS for solo consultants — 5 paying beta users",
    building: "Automated cold email sequencer for consultants and freelancers. 5 paying users at $29/month.",
    stage: "revenue", domains: ["E-commerce", "Finance"], skills: ["Sales/Outreach", "Coding"],
    hours: "10+", xp: 620, streak: 25, daysAgo: 6,
  }),
  "seed-omar": profile({
    uid: "seed-omar", name: "Omar H.", ageBand: "18+",
    country: "Egypt", timezone: "Africa/Cairo",
    headline: "IoT soil sensor for small farms — pilot with 3 farmers",
    building: "Low-cost soil humidity + nutrient sensor with a simple dashboard. 3 farmers running the pilot.",
    stage: "building", domains: ["Hardware", "Nonprofit"], skills: ["Coding", "Ops"],
    hours: "10+", xp: 150, streak: 3, daysAgo: 3,
  }),
  "seed-grace": profile({
    uid: "seed-grace", name: "Grace L.", ageBand: "16-17",
    country: "Singapore", timezone: "Asia/Singapore",
    headline: "Study group app used by 120 students at my school",
    building: "Peer-to-peer study matching app. 120 users at one school, building for multi-school.",
    stage: "launched", domains: ["Web/Apps", "Nonprofit"], skills: ["Coding", "Design"],
    hours: "5-10", xp: 200, streak: 7, daysAgo: 3, consentStatus: "granted",
  }),
  "seed-priya": profile({
    uid: "seed-priya", name: "Priya S.", ageBand: "18+",
    country: "India", timezone: "Asia/Kolkata",
    headline: "Open-source bio lab protocol library — 40 GitHub stars",
    building: "Crowdsourced library of reproducible biology lab protocols. 40 stars, 5 contributors.",
    stage: "building", domains: ["Science", "Nonprofit"], skills: ["Writing", "Ops"],
    hours: "5-10", xp: 120, streak: 4, daysAgo: 2,
  }),
  // Extra operators for new cohorts
  "seed-kai": profile({
    uid: "seed-kai", name: "Kai W.", ageBand: "18+",
    country: "Australia", timezone: "Australia/Sydney",
    headline: "Wearable UV tracker — pre-order campaign live",
    building: "Wrist-worn UV index tracker with sun safety alerts. 45 pre-orders on Kickstarter.",
    stage: "building", domains: ["Hardware"], skills: ["Design", "Marketing"],
    hours: "10+", xp: 270, streak: 9, daysAgo: 15,
  }),
  "seed-felix": profile({
    uid: "seed-felix", name: "Felix A.", ageBand: "18+",
    country: "Sweden", timezone: "Europe/Stockholm",
    headline: "B2B SaaS finance dashboard — first enterprise pilot",
    building: "Real-time P&L and cash-flow dashboard for small e-commerce businesses. 1 enterprise pilot at $500/month.",
    stage: "revenue", domains: ["Finance", "Web/Apps"], skills: ["Coding", "Sales/Outreach"],
    hours: "10+", xp: 710, streak: 28, daysAgo: 30,
  }),
  "seed-rin": profile({
    uid: "seed-rin", name: "Rin T.", ageBand: "18+",
    country: "Japan", timezone: "Asia/Tokyo",
    headline: "AR try-on for indie fashion brands — 3 brands onboarded",
    building: "WebAR product try-on widget for small fashion brands. 3 brands live, 200 try-on sessions/day.",
    stage: "revenue", domains: ["Web/Apps", "E-commerce"], skills: ["Coding", "Design"],
    hours: "5-10", xp: 480, streak: 16, daysAgo: 20,
  }),
  "seed-sam": profile({
    uid: "seed-sam", name: "Sam D.", ageBand: "18+",
    country: "USA", timezone: "America/New_York",
    headline: "Climate data journalism newsletter — 600 subscribers",
    building: "Weekly newsletter translating climate research into plain-English briefings. 600 subs, 55% open rate.",
    stage: "launched", domains: ["Content", "Science"], skills: ["Writing", "Marketing"],
    hours: "3-5", xp: 190, streak: 6, daysAgo: 5,
  }),
};

// ─── Cohorts ───────────────────────────────────────────────────────────────

// A squad activates only with 3+ members AND an assigned mentor — mirrors
// canActivate() in app/lib/types.ts and the gate in firestore.rules. Squads
// seeded without a mentor stay "forming" on purpose: they're what the mentor
// approval feed at /admin → Squads has to chew on.
function cohort({ name, mission, tags, lookingFor, meetingSlot, timezone,
  founderUid, founderName, members, daysAgo, state, mentorUid, mentorName }) {
  const memberNames = {};
  const memberUids = [founderUid, ...members.map((m) => m.uid)];
  memberNames[founderUid] = s(founderName);
  for (const m of members) memberNames[m.uid] = s(m.name);
  const autoState =
    state ?? (memberUids.length >= 3 && mentorUid ? "active" : "forming");
  return {
    fields: {
      name: s(name),
      mission: s(mission),
      tags: arr(tags.map(s)),
      lookingFor: arr(lookingFor.map(s)),
      meetingSlot: s(meetingSlot),
      timezone: s(timezone),
      state: s(autoState),
      founderUid: s(founderUid),
      founderName: s(founderName),
      ...(mentorUid
        ? { mentorUid: s(mentorUid), mentorName: s(mentorName ?? "Josh N.") }
        : {}),
      peerLeadUid: s(founderUid),
      memberUids: arr(memberUids.map(s)),
      memberNames: map(memberNames),
      open: b(true),
      weeklyStreak: n(autoState === "active" ? Math.floor((daysAgo ?? 0) / 7) : 0),
      lastRitualWeek: s(""),
      createdAt: ts(new Date(Date.now() - (daysAgo ?? 0) * 86400000)),
    },
  };
}

const cohorts = {
  // ── Batch 1: original six ──────────────────────────────────────────────
  "seed-night-shift": cohort({
    name: "Night Shift",
    mission: "AI builders shipping their own products to 100 real users each.",
    tags: ["AI", "Web/Apps"],
    lookingFor: ["Coding", "Design"],
    meetingSlot: "Sundays 7pm ET",
    timezone: "America/Toronto",
    founderUid: "seed-maya",
    founderName: "Maya C.",
    members: [
      { uid: "seed-dev", name: "Dev P." },
      { uid: "seed-lena", name: "Lena F." },
    ],
    mentorUid: "seed-mentor", mentorName: "Josh N.",
    daysAgo: 21,
  }),
  "seed-first-dollar": cohort({
    name: "First Dollar",
    mission: "Every member lands their first $100 of internet revenue this season.",
    tags: ["E-commerce"],
    lookingFor: ["Sales/Outreach", "Marketing"],
    meetingSlot: "Saturdays 11am ET",
    timezone: "America/New_York",
    founderUid: "seed-arjun",
    founderName: "Arjun M.",
    members: [{ uid: "seed-sofia", name: "Sofia R." }],
    daysAgo: 14,
  }),
  "seed-signal": cohort({
    name: "Signal",
    mission: "Content operators growing from 0 to 10k followers by shipping daily.",
    tags: ["Content"],
    lookingFor: ["Video", "Writing"],
    meetingSlot: "Wednesdays 6pm CET",
    timezone: "Europe/Berlin",
    founderUid: "seed-tomas",
    founderName: "Tomas E.",
    members: [
      { uid: "seed-amara", name: "Amara O." },
      { uid: "seed-jules", name: "Jules M." },
    ],
    mentorUid: "seed-mentor", mentorName: "Josh N.",
    daysAgo: 10,
  }),
  "seed-cold-start": cohort({
    name: "Cold Start",
    mission: "Outbound crew: 10 cold asks a day until someone says yes.",
    tags: ["E-commerce", "Finance"],
    lookingFor: ["Sales/Outreach", "Ops"],
    meetingSlot: "Tuesdays 5pm PT",
    timezone: "America/Los_Angeles",
    founderUid: "seed-nina",
    founderName: "Nina K.",
    members: [],
    daysAgo: 6,
  }),
  "seed-launch-window": cohort({
    name: "Launch Window",
    mission: "Ship an MVP in 30 days, then get it in front of 50 real users.",
    tags: ["Web/Apps", "Hardware"],
    lookingFor: ["Coding", "Marketing"],
    meetingSlot: "Sundays 2pm IST",
    timezone: "Asia/Kolkata",
    founderUid: "seed-omar",
    founderName: "Omar H.",
    members: [{ uid: "seed-grace", name: "Grace L." }],
    daysAgo: 3,
  }),
  "seed-lab-notes": cohort({
    name: "Lab Notes",
    mission: "Science and research operators getting real experiments run.",
    tags: ["Science", "Nonprofit"],
    lookingFor: ["Writing", "Ops"],
    meetingSlot: "Thursdays 7pm ET",
    timezone: "America/Toronto",
    founderUid: "seed-priya",
    founderName: "Priya S.",
    members: [],
    mentorUid: "seed-mentor-2", mentorName: "Sarah K.",
    daysAgo: 2,
  }),

  // ── Batch 2: more variety ──────────────────────────────────────────────
  "seed-hardware-lab": cohort({
    name: "Hardware Lab",
    mission: "Physical product operators from idea to first 10 units shipped.",
    tags: ["Hardware"],
    lookingFor: ["Design", "Ops"],
    meetingSlot: "Saturdays 10am AEST",
    timezone: "Australia/Sydney",
    founderUid: "seed-kai",
    founderName: "Kai W.",
    members: [],
    daysAgo: 12,
  }),
  "seed-cash-flow": cohort({
    name: "Cash Flow",
    mission: "B2B founders hitting $1k MRR — no fluff, show the numbers.",
    tags: ["Finance", "Web/Apps"],
    lookingFor: ["Coding", "Sales/Outreach"],
    meetingSlot: "Mondays 6pm CET",
    timezone: "Europe/Stockholm",
    founderUid: "seed-felix",
    founderName: "Felix A.",
    members: [
      { uid: "seed-nina", name: "Nina K." },
      { uid: "seed-rin", name: "Rin T." },
    ],
    daysAgo: 30,
  }),
  "seed-deep-south": cohort({
    name: "Deep South",
    mission: "Asia-Pacific operators shipping across time zones.",
    tags: ["Web/Apps", "E-commerce"],
    lookingFor: ["Marketing", "Coding"],
    meetingSlot: "Sundays 11am SGT",
    timezone: "Asia/Singapore",
    founderUid: "seed-rin",
    founderName: "Rin T.",
    members: [
      { uid: "seed-grace", name: "Grace L." },
      { uid: "seed-dev", name: "Dev P." },
      { uid: "seed-omar", name: "Omar H." },
    ],
    daysAgo: 25,
  }),
  "seed-word-of-mouth": cohort({
    name: "Word of Mouth",
    mission: "Grow without ads — content, cold asks, and organic distribution only.",
    tags: ["Content", "E-commerce"],
    lookingFor: ["Writing", "Marketing"],
    meetingSlot: "Fridays 5pm ET",
    timezone: "America/New_York",
    founderUid: "seed-sam",
    founderName: "Sam D.",
    members: [
      { uid: "seed-amara", name: "Amara O." },
    ],
    daysAgo: 8,
  }),
  "seed-stalled-example": cohort({
    name: "Beta Breakers",
    mission: "Break our beta products with 100 real users each.",
    tags: ["Web/Apps"],
    lookingFor: ["Coding", "Design"],
    meetingSlot: "Wednesdays 8pm ET",
    timezone: "America/New_York",
    founderUid: "seed-lena",
    founderName: "Lena F.",
    members: [
      { uid: "seed-maya", name: "Maya C." },
      { uid: "seed-felix", name: "Felix A." },
    ],
    state: "stalled",
    daysAgo: 45,
  }),
};

// ─── Workshops ─────────────────────────────────────────────────────────────

// Sessions are owned and capped now. Seeded ones are stamped with a synthetic
// owner uid so they're shaped like the real thing — no signed-in mentor owns
// them, so they're read-only in /admin (only their author can edit a session).
// Office hours are NOT seeded any more: they became squad-scoped check-ins
// (cohorts/{id}/checkIns) and are no longer a catalog item at all.
function workshop({ title, mentorName, mentorUid, description, inDays, hour,
  durationMins, capacity, open, levelGate, milestoneId }) {
  const d = new Date();
  d.setDate(d.getDate() + inDays);
  d.setHours(hour, 0, 0, 0);
  return {
    fields: {
      title: s(title),
      mentorName: s(mentorName),
      mentorUid: s(mentorUid ?? "seed-mentor"),
      description: s(description),
      kind: s("workshop"),
      startsAt: ts(d),
      durationMins: n(durationMins),
      meetLink: s("https://meet.google.com/lookup/high-agency"),
      capacity: n(capacity ?? 30),
      enrolledUids: arr([]),
      open: b(open ?? false),
      levelGate: n(levelGate ?? 0),
      milestoneId: n(milestoneId ?? 0),
      recordingUrl: s(""),
    },
  };
}

const workshops = {
  "seed-w0": workshop({
    title: "The Operator Mindset",
    mentorName: "Josh Newall",
    description: "What high agency actually is, picking your mission, the weekly cadence. The season's open workshop — everyone in.",
    inDays: 3, hour: 18, durationMins: 60,
    open: true, milestoneId: 1,
  }),
  "seed-w1": workshop({
    title: "The Art of the Cold Ask",
    mentorName: "Sarah Kim",
    description: "The 5-sentence cold email, rejection math, and the 3-touch follow-up.",
    inDays: 10, hour: 18, durationMins: 60,
    milestoneId: 2,
  }),
  "seed-w2": workshop({
    title: "Talk to Humans",
    mentorName: "Josh Newall",
    description: "The Mom Test in 10 minutes; interviews that don't lie to you.",
    inDays: 17, hour: 18, durationMins: 60,
    milestoneId: 3,
  }),
  "seed-w3": workshop({
    title: "Ship the MVP, part 1: ruthless scoping",
    mentorName: "Josh Newall",
    description: "One core action. Fake doors, concierge MVPs, and other shortcuts.",
    inDays: 24, hour: 18, durationMins: 60,
    milestoneId: 4,
  }),
  "seed-w4": workshop({
    title: "Ship the MVP, part 2: AI leverage + the front door",
    mentorName: "Dev Anand",
    description: "The modern stack, landing pages that convert, capturing intent.",
    inDays: 31, hour: 18, durationMins: 60,
    milestoneId: 4,
  }),
  "seed-w5": workshop({
    title: "Traction From Nothing",
    mentorName: "Sarah Kim",
    description: "The unscalable 10, build-in-public, and feedback loops at zero scale.",
    inDays: 38, hour: 18, durationMins: 60,
    milestoneId: 5,
  }),
  "seed-w6": workshop({
    title: "Partnerships & Leverage (advanced)",
    mentorName: "Josh Newall",
    description: "Who already has your audience, and the pilot proposal that opens doors. Level-gated: L3 Operator+.",
    inDays: 45, hour: 18, durationMins: 60,
    levelGate: 3, milestoneId: 6,
  }),
  "seed-w7": workshop({
    title: "Scale What Works & Tell the Story",
    mentorName: "Josh Newall",
    description: "Reading your numbers and the 3-minute demo-day arc.",
    inDays: 52, hour: 18, durationMins: 60,
    milestoneId: 7,
  }),
};

// ─── Build log entries ─────────────────────────────────────────────────────
// A few realistic entries for active cohorts so the log feeds aren't empty.

function logEntry({ uid, name, text, daysAgo, cohortId }) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const day = d.toISOString().slice(0, 10);
  return { cohortId, doc: { fields: { uid: s(uid), name: s(name), text: s(text), day: s(day), createdAt: ts(d) } } };
}

const buildLogs = [
  logEntry({ cohortId: "seed-night-shift", uid: "seed-maya", name: "Maya C.", text: "Shipped the feedback diff view — users now see tracked changes in their essay. 12 people tried it today.", daysAgo: 0 }),
  logEntry({ cohortId: "seed-night-shift", uid: "seed-dev", name: "Dev P.", text: "Fixed the auth timeout bug that was locking users out after 30 min. Prod hotfix done.", daysAgo: 1 }),
  logEntry({ cohortId: "seed-night-shift", uid: "seed-lena", name: "Lena F.", text: "Wrote the landing page copy and A/B tested two headlines. Version B wins 2:1.", daysAgo: 2 }),
  logEntry({ cohortId: "seed-night-shift", uid: "seed-maya", name: "Maya C.", text: "Sent cold emails to 3 school counselors. One replied asking for a demo.", daysAgo: 3 }),
  logEntry({ cohortId: "seed-night-shift", uid: "seed-dev", name: "Dev P.", text: "Added streaming responses — feels 3x faster even though actual latency is the same.", daysAgo: 4 }),
  logEntry({ cohortId: "seed-signal", uid: "seed-tomas", name: "Tomas E.", text: "Episode 14 live. 4200 views in 24 hours — best one yet. Comments are gold.", daysAgo: 0 }),
  logEntry({ cohortId: "seed-signal", uid: "seed-amara", name: "Amara O.", text: "Issue 23 sent. 810 subscribers now. Someone forwarded it to a VC, they signed up.", daysAgo: 1 }),
  logEntry({ cohortId: "seed-signal", uid: "seed-jules", name: "Jules M.", text: "Closed first paid collaboration — $600 for a 30-second integration in next week's video.", daysAgo: 2 }),
  logEntry({ cohortId: "seed-cash-flow", uid: "seed-felix", name: "Felix A.", text: "Pilot check-in with enterprise client — they want to add 2 more seats. Drafting the expansion proposal.", daysAgo: 0 }),
  logEntry({ cohortId: "seed-cash-flow", uid: "seed-nina", name: "Nina K.", text: "Hit $145 MRR. Small but it's real money from real customers. Next: 5 more.", daysAgo: 1 }),
  logEntry({ cohortId: "seed-first-dollar", uid: "seed-arjun", name: "Arjun M.", text: "Ran the first PPC test — ROAS is 1.8. Not there yet but the product margins can handle 2.5+.", daysAgo: 0 }),
  logEntry({ cohortId: "seed-first-dollar", uid: "seed-sofia", name: "Sofia R.", text: "Listed 3 new printable packs on Etsy. Each took under an hour to make with Canva.", daysAgo: 1 }),
];

// ─── Runner ────────────────────────────────────────────────────────────────

async function main() {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function upsert(path, doc) {
    const res = await fetch(`${BASE}/${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    console.log("ok", path);
  }

  async function addLog(cohortId, doc) {
    const res = await fetch(`${BASE}/cohorts/${cohortId}/logs`, {
      method: "POST",
      headers,
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(`logs/${cohortId}: ${res.status} ${await res.text()}`);
    console.log("ok", `cohorts/${cohortId}/logs (auto-id)`);
  }

  console.log("Seeding profiles…");
  for (const [id, doc] of Object.entries(profiles)) await upsert(`profiles/${id}`, doc);

  console.log("Seeding cohorts…");
  for (const [id, doc] of Object.entries(cohorts)) await upsert(`cohorts/${id}`, doc);

  console.log("Seeding workshops…");
  for (const [id, doc] of Object.entries(workshops)) await upsert(`workshops/${id}`, doc);

  console.log("Seeding build logs…");
  for (const { cohortId, doc } of buildLogs) await addLog(cohortId, doc);

  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
