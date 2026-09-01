import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  arrayUnion,
  arrayRemove,
  Timestamp,
  type Unsubscribe,
  type FirestoreError,
} from "firebase/firestore";
import { getDb, getFirebaseAuth } from "./firebase";
import type {
  Profile,
  PrivateProfile,
  Cohort,
  CohortApplication,
  DeclineReason,
  BuildLog,
  Workshop,
  CheckIn,
  WeeklyHours,
  MentorSignupInput,
  TrackMilestone,
} from "./types";
import { canActivate, CHECKIN_DEFAULT_MINS, TRACK_MAX_MILESTONES } from "./types";

export const MAX_PENDING_APPLICATIONS = 3;

export type ListenerErrorHandler = (e: FirestoreError) => void;

/** Error path for a snapshot listener. Without one, the SDK throws the failure
 *  as an uncaught error — and, worse, a listener that trips a security rule is
 *  torn down permanently and never retries, so the screen silently shows "no
 *  data" forever. Callers that can recover pass their own handler. */
function listenerError(
  label: string,
  onError?: ListenerErrorHandler
): ListenerErrorHandler {
  return (e) => {
    if (onError) onError(e);
    else console.warn(`[db] ${label} listener stopped (${e.code})`);
  };
}

/* ---------------- Profiles ---------------- */

/** Backfill safe defaults for any field a partial/legacy doc is missing,
 *  so consumers can treat arrays/numbers as always-present. */
function normalizeProfile(uid: string, data: Record<string, unknown>): Profile {
  return {
    plan: "free",
    role: "operator",
    consentStatus: "none",
    streak: 0,
    streakFreezes: 0,
    lastActiveDay: "",
    lastBuildLogDay: "",
    ...data,
    uid,
    domains: (data.domains as string[]) ?? [],
    skills: (data.skills as string[]) ?? [],
    enrolledWorkshops: (data.enrolledWorkshops as string[]) ?? [],
    pendingApplications: (data.pendingApplications as string[]) ?? [],
    links: {
      github: "",
      linkedin: "",
      site: "",
      ...((data.links as Record<string, string>) ?? {}),
    },
  } as Profile;
}

export async function getProfile(uid: string): Promise<Profile | null> {
  const snap = await getDoc(doc(getDb(), "profiles", uid));
  return snap.exists() ? normalizeProfile(uid, snap.data()) : null;
}

export function watchProfile(
  uid: string,
  cb: (p: Profile | null) => void
): Unsubscribe {
  return onSnapshot(doc(getDb(), "profiles", uid), (snap) => {
    cb(snap.exists() ? normalizeProfile(uid, snap.data()) : null);
  }, listenerError(`profiles/${uid}`));
}

export async function saveProfile(
  uid: string,
  data: Partial<Omit<Profile, "uid" | "createdAt" | "updatedAt">>,
  isNew: boolean
): Promise<void> {
  await setDoc(
    doc(getDb(), "profiles", uid),
    {
      ...data,
      uid,
      updatedAt: serverTimestamp(),
      ...(isNew ? { createdAt: serverTimestamp() } : {}),
    },
    { merge: true }
  );
}

/** DOB, full name, city, parent email — owner-readable only, ever. */
export async function savePrivateProfile(
  uid: string,
  data: Partial<Omit<PrivateProfile, "uid" | "createdAt" | "updatedAt">>,
  isNew: boolean
): Promise<void> {
  await setDoc(
    doc(getDb(), "privateProfiles", uid),
    {
      ...data,
      uid,
      updatedAt: serverTimestamp(),
      ...(isNew ? { createdAt: serverTimestamp() } : {}),
    },
    { merge: true }
  );
}

export async function getPrivateProfile(
  uid: string
): Promise<PrivateProfile | null> {
  const snap = await getDoc(doc(getDb(), "privateProfiles", uid));
  return snap.exists() ? (snap.data() as PrivateProfile) : null;
}

/* ---------------- Cohorts ---------------- */

export function watchCohorts(cb: (cohorts: Cohort[]) => void): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts"),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Cohort));
  });
}

export function watchMyCohorts(
  uid: string,
  cb: (cohorts: Cohort[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts"),
    where("memberUids", "array-contains", uid)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Cohort));
  });
}

export function watchCohort(
  id: string,
  cb: (c: Cohort | null) => void
): Unsubscribe {
  return onSnapshot(doc(getDb(), "cohorts", id), (snap) => {
    cb(snap.exists() ? ({ id: snap.id, ...snap.data() } as Cohort) : null);
  }, listenerError(`cohorts/${id}`));
}

/** Creation requires a committed weekly slot — deliberate friction that
 *  forces the founder to commit to the ritual before recruiting. */
export async function createCohort(
  founder: Profile,
  data: {
    name: string;
    mission: string;
    tags: string[];
    lookingFor: string[];
    meetingSlot: string;
    /** Optional; omitted from the write when empty so Firestore never sees
     *  an undefined value (which the SDK rejects). */
    link?: string;
    icon?: string;
  }
): Promise<string> {
  // Pull optionals out so a passed-through `undefined` never reaches the
  // write (the SDK rejects undefined); re-add only when non-empty.
  const { link, icon, ...rest } = data;
  const ref = await addDoc(collection(getDb(), "cohorts"), {
    ...rest,
    ...(link ? { link } : {}),
    ...(icon ? { icon } : {}),
    timezone: founder.timezone,
    state: "forming",
    founderUid: founder.uid,
    founderName: founder.name,
    memberUids: [founder.uid],
    memberNames: { [founder.uid]: founder.name },
    open: true,
    weeklyStreak: 0,
    lastRitualWeek: "",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/* The weekly ritual and the build log are STREAK actions and are written by
   the server (POST /api/ritual, POST /api/build-log — see lib/api.ts), so the
   streak can never be set from a browser. Reads stay here. */

/* ---------------- The track (mentor-authored) ---------------- */

/** The squad's mentor writes the whole track in one go: the ordered list of
 *  milestones with their done state. Rules restrict this write to the
 *  assigned mentor and bound the list length; the shape of each milestone
 *  is trusted from the mentor (staff). */
export async function saveTrack(
  cohortId: string,
  track: TrackMilestone[]
): Promise<void> {
  if (track.length > TRACK_MAX_MILESTONES) throw new Error("track-too-long");
  await updateDoc(doc(getDb(), "cohorts", cohortId), {
    track: track.map((m) => ({
      id: m.id,
      title: m.title,
      detail: m.detail,
      dueDay: m.dueDay,
      doneAt: m.doneAt,
    })),
    trackUpdatedAt: serverTimestamp(),
  });
}

/* ---------------- Mentor adoption ---------------- */

/** How many of the newest squads the approval feed scans for "no mentor yet".
 *  Firestore can't query for an absent field, so the filter runs client-side
 *  over a bounded window instead of the whole collection. Batch 1 is ~10
 *  squads; if the platform ever outgrows this window, the fix is a stored
 *  `mentorUid: null` (or a `needsMentor` flag) that can be queried directly —
 *  not a bigger scan. */
export const UNASSIGNED_SCAN_LIMIT = 100;

/** The mentor approval feed: every squad nobody has adopted yet. Read
 *  client-side rather than queried — see UNASSIGNED_SCAN_LIMIT. */
export function watchUnassignedCohorts(
  cb: (cohorts: Cohort[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts"),
    orderBy("createdAt", "desc"),
    limit(UNASSIGNED_SCAN_LIMIT)
  );
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() }) as Cohort)
        .filter((c) => !c.mentorUid && c.state !== "archived")
    );
  });
}

/** Squads this mentor owns — the source for their check-in queue. */
export function watchMentoredCohorts(
  mentorUid: string,
  cb: (cohorts: Cohort[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts"),
    where("mentorUid", "==", mentorUid)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Cohort));
  });
}

/** A mentor adopts an unclaimed squad: they become its mentor, and if the
 *  crew is already ≥3 the squad activates in the same write. Rules refuse
 *  this if the squad already has a mentor — no stealing, no reassigning. */
export async function adoptCohort(cohort: Cohort, mentor: Profile): Promise<void> {
  const memberUids = cohort.memberUids ?? [];
  await updateDoc(doc(getDb(), "cohorts", cohort.id), {
    mentorUid: mentor.uid,
    mentorName: mentor.name,
    ...(cohort.state === "forming" &&
    canActivate({ memberUids, mentorUid: mentor.uid })
      ? { state: "active" }
      : {}),
  });
}

/* ---------------- Squad check-ins (what office hours became) --------- */

/** Check-ins are the narrowest read in the app: this squad's members and its
 *  assigned mentor, nobody else. That makes the listener genuinely deniable
 *  (see the adopt race handled in components/mentorData.ts), so `onError` is
 *  worth passing here. */
export function watchCheckIns(
  cohortId: string,
  cb: (checkIns: CheckIn[]) => void,
  onError?: ListenerErrorHandler
): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts", cohortId, "checkIns"),
    orderBy("createdAt", "desc"),
    limit(30)
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as CheckIn)),
    listenerError(`checkIns/${cohortId}`, onError)
  );
}

/** Any member asks the squad's mentor for a check-in. The note is optional
 *  and short by design — it's a nudge to the mentor, not a ticket. */
export async function requestCheckIn(
  cohort: Cohort,
  requester: Profile,
  note: string
): Promise<void> {
  if (!cohort.mentorUid) throw new Error("no-mentor");
  await addDoc(collection(getDb(), "cohorts", cohort.id, "checkIns"), {
    cohortId: cohort.id,
    requestedByUid: requester.uid,
    requestedByName: requester.name,
    note,
    status: "requested",
    mentorUid: cohort.mentorUid,
    mentorName: cohort.mentorName ?? "",
    startsAt: null,
    durationMins: CHECKIN_DEFAULT_MINS,
    meetLink: "",
    createdAt: serverTimestamp(),
    confirmedAt: null,
  });
}

/** Requester withdraws while it's still just a request. */
export async function withdrawCheckIn(
  cohortId: string,
  checkInId: string
): Promise<void> {
  await deleteDoc(doc(getDb(), "cohorts", cohortId, "checkIns", checkInId));
}

/** Most recent confirmed check-in that has already happened — the input to
 *  the squad's bi-weekly nudge. Null when the squad has never had one.
 *  `now` is passed in so callers can hold a stable clock across a render. */
export function lastCheckInAt(checkIns: CheckIn[], now: number): Date | null {
  const past = checkIns
    .filter((c) => c.status === "confirmed" && c.startsAt)
    .map((c) => c.startsAt!.toDate())
    .filter((d) => d.getTime() <= now)
    .sort((a, b) => b.getTime() - a.getTime());
  return past[0] ?? null;
}

/* ---------------- Applications ---------------- */

/** Hard cap of 3 live applications. The pendingApplications list on the
 *  applicant's own profile enforces the cap without collection-group
 *  queries; it's reconciled lazily as decisions land. */
export async function applyToCohort(
  cohortId: string,
  applicant: Profile,
  pitch: string,
  hours: WeeklyHours
): Promise<void> {
  if (applicant.pendingApplications.length >= MAX_PENDING_APPLICATIONS) {
    throw new Error("max-pending");
  }
  const db = getDb();
  await setDoc(doc(db, "cohorts", cohortId, "applications", applicant.uid), {
    applicantUid: applicant.uid,
    applicantName: applicant.name,
    pitch,
    hours,
    status: "pending",
    declineReason: null,
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "profiles", applicant.uid), {
    pendingApplications: arrayUnion(cohortId),
    updatedAt: serverTimestamp(),
  });
}

export async function getMyApplication(
  cohortId: string,
  uid: string
): Promise<CohortApplication | null> {
  const snap = await getDoc(doc(getDb(), "cohorts", cohortId, "applications", uid));
  return snap.exists() ? (snap.data() as CohortApplication) : null;
}

/** Drop decided/dead cohort ids from my pendingApplications so slots
 *  free up. Founders can't write my profile, so I reconcile my own. */
export async function reconcilePendingApplications(
  profile: Profile
): Promise<void> {
  if (profile.pendingApplications.length === 0) return;
  const db = getDb();
  const stale: string[] = [];
  await Promise.all(
    profile.pendingApplications.map(async (cohortId) => {
      const app = await getMyApplication(cohortId, profile.uid).catch(() => null);
      if (!app || app.status !== "pending") stale.push(cohortId);
    })
  );
  if (stale.length > 0) {
    await updateDoc(doc(db, "profiles", profile.uid), {
      pendingApplications: arrayRemove(...stale),
      updatedAt: serverTimestamp(),
    });
  }
}

export function watchApplications(
  cohortId: string,
  cb: (apps: CohortApplication[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts", cohortId, "applications"),
    where("status", "==", "pending")
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as CohortApplication));
  }, listenerError(`applications/${cohortId}`));
}

/** Founder decision. Accepting also adds the applicant to the roster and
 *  activates a forming cohort once it clears the activation gate — 3+
 *  members AND an assigned mentor — atomically. A squad that hits 3 with
 *  no mentor stays "forming" until one adopts it (see adoptCohort).
 *  Declines carry a one-tap reason so rejection is informative, not silent. */
export async function decideApplication(
  cohort: Cohort,
  app: CohortApplication,
  accept: boolean,
  declineReason: DeclineReason | null = null
): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  batch.update(doc(db, "cohorts", cohort.id, "applications", app.applicantUid), {
    status: accept ? "accepted" : "declined",
    declineReason: accept ? null : declineReason,
  });
  if (accept) {
    const memberUids = [...cohort.memberUids, app.applicantUid];
    batch.update(doc(db, "cohorts", cohort.id), {
      memberUids,
      memberNames: { ...cohort.memberNames, [app.applicantUid]: app.applicantName },
      ...(cohort.state === "forming" &&
      canActivate({ memberUids, mentorUid: cohort.mentorUid })
        ? { state: "active" }
        : {}),
    });
  }
  await batch.commit();
}

/* ---------------- Build log ---------------- */

export function watchBuildLogs(
  cohortId: string,
  cb: (logs: BuildLog[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "cohorts", cohortId, "logs"),
    orderBy("createdAt", "desc"),
    limit(40)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BuildLog));
  }, listenerError(`logs/${cohortId}`));
}

export async function removeBuildLog(cohortId: string, logId: string): Promise<void> {
  await deleteDoc(doc(getDb(), "cohorts", cohortId, "logs", logId));
}

/* ---------------- Workshops (reads) ---------------- */
/* Every workshop WRITE — authoring, enrolling, leaving — goes through the
   Route Handlers in app/api/workshops/** (see lib/api.ts), because each one
   may also touch the host mentor's Google Calendar. Clients only read. */

/** Legacy `office_hours` docs predate squad check-ins; hide rather than
 *  delete them. */
function catalogOnly(docs: Workshop[]): Workshop[] {
  return docs.filter((w) => (w as { kind?: string }).kind !== "office_hours");
}

export async function getUpcomingWorkshops(): Promise<Workshop[]> {
  const q = query(
    collection(getDb(), "workshops"),
    where("startsAt", ">", Timestamp.now()),
    orderBy("startsAt", "asc"),
    limit(24)
  );
  const snap = await getDocs(q);
  return catalogOnly(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Workshop)).slice(
    0,
    12
  );
}

/** Finished sessions that have a recording posted — the on-demand shelf
 *  the Learn page promises. Newest first. */
export async function getPastWorkshops(): Promise<Workshop[]> {
  const q = query(
    collection(getDb(), "workshops"),
    where("startsAt", "<", Timestamp.now()),
    orderBy("startsAt", "desc"),
    limit(24)
  );
  const snap = await getDocs(q);
  return catalogOnly(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Workshop)).filter(
    (w) => w.recordingUrl
  );
}

/** Every session inside a window, oldest first — what the mentor calendar
 *  subscribes to for the week on screen. Range + orderBy are the same single
 *  field, so this needs no composite index. */
export function watchWorkshopsBetween(
  from: Date,
  to: Date,
  cb: (workshops: Workshop[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "workshops"),
    where("startsAt", ">=", Timestamp.fromDate(from)),
    where("startsAt", "<", Timestamp.fromDate(to)),
    orderBy("startsAt", "asc")
  );
  return onSnapshot(q, (snap) => {
    cb(catalogOnly(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Workshop)));
  });
}

/** A mentor's own sessions from now forward — the "what am I running" list.
 *  Filtered by owner client-side to avoid a composite index on
 *  (mentorUid, startsAt); the window keeps the read small. */
export function watchMyUpcomingWorkshops(
  mentorUid: string,
  cb: (workshops: Workshop[]) => void
): Unsubscribe {
  const q = query(
    collection(getDb(), "workshops"),
    where("startsAt", ">", Timestamp.now()),
    orderBy("startsAt", "asc"),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    cb(
      catalogOnly(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Workshop)).filter(
        (w) => w.mentorUid === mentorUid
      )
    );
  });
}

/* ---------------- Admin: member consent (mentors) ---------------- */

/** How many pending-consent rows a mentor sees at once. The queue is meant to
 *  be worked down, not scrolled: an unbounded listener over every pending
 *  minor would grow with the intake batch. Callers surface the truncation
 *  rather than pretending the page is the whole queue. */
export const CONSENT_QUEUE_LIMIT = 50;

/** Operators awaiting parental consent — the mentor's approval queue.
 *  Single-field equality query (no composite index); sorted client-side.
 *  Deliberately capped — see CONSENT_QUEUE_LIMIT. */
export function watchPendingConsent(cb: (profiles: Profile[]) => void): Unsubscribe {
  const q = query(
    collection(getDb(), "profiles"),
    where("consentStatus", "==", "pending"),
    limit(CONSENT_QUEUE_LIMIT)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => normalizeProfile(d.id, d.data())));
  }, listenerError(`pendingConsent`));
}

/** Mentor grants parental consent — flips a pending minor to granted,
 *  unlocking community access. Allowed by rules' isConsentGrant(). This is the
 *  manual override / audit fallback; the primary path is the parent-approval
 *  link ([[requestConsentEmail]] → email → /consent/[token]). */
export async function grantConsent(uid: string): Promise<void> {
  await updateDoc(doc(getDb(), "profiles", uid), {
    consentStatus: "granted",
    updatedAt: serverTimestamp(),
  });
}

/** Ask the server to (re)send the parental-consent email. Called with no uid
 *  by a minor for themselves at onboarding, or with a target uid by a mentor
 *  resending from the admin queue. The server verifies the caller's ID token,
 *  mints a single-use token, and dispatches the email (or logs the link in dev
 *  when no RESEND_API_KEY is set). Throws if not signed in. */
export async function requestConsentEmail(
  uid?: string
): Promise<{
  ok: boolean;
  delivery?: "sent" | "logged";
  error?: string;
  /** Seconds until a resend is allowed again (present on a rate-limited 429). */
  retryAfter?: number;
}> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("not-signed-in");
  const idToken = await user.getIdToken();
  const res = await fetch("/api/consent/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(uid ? { uid } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as {
    delivery?: "sent" | "logged";
    error?: string;
    retryAfter?: number;
  };
  return { ok: res.ok, ...data };
}

/* ---------------- Mentor invites ---------------- */

export type MentorInviteStatus = "valid" | "used" | "expired" | "invalid";

/** Check a mentor invite code before sign-in (step 1 of /mentor/join).
 *  Unauthenticated — the server returns validity only, never invite details. */
export async function peekMentorInvite(
  code: string
): Promise<MentorInviteStatus> {
  const res = await fetch("/api/mentor/peek", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    status?: MentorInviteStatus;
  };
  return data.status ?? "invalid";
}

/** Redeem a mentor invite for the signed-in user. The server verifies the ID
 *  token, consumes the single-use code, and either creates the mentor profile
 *  from `profile` (fresh signup) or promotes the caller's existing operator
 *  account when one exists (profile payload then ignored). This is the only
 *  client-reachable way to become a mentor — rules block the role everywhere
 *  else. Throws if not signed in. */
export async function redeemMentorInvite(
  code: string,
  profile?: MentorSignupInput
): Promise<{
  ok: boolean;
  /** "created" | "promoted" | "already-mentor" on success. */
  status?: string;
  /** "invalid" | "used" | "expired" | "profile-required" on failure. */
  error?: string;
}> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("not-signed-in");
  const idToken = await user.getIdToken();
  const res = await fetch("/api/mentor/redeem", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(profile ? { code, profile } : { code }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
  };
  return { ok: res.ok, ...data };
}
