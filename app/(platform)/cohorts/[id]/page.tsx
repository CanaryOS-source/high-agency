"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../../../components/AuthProvider";
import {
  watchCohort,
  watchSubmissions,
  watchBuildLogs,
  watchApplications,
  watchCheckIns,
  requestCheckIn,
  withdrawCheckIn,
  lastCheckInAt,
  submitMilestone,
  decideSubmission,
  addBuildLog,
  markRitual,
  decideApplication,
  getProfile,
} from "../../../lib/db";
import { TRACK, squadThreshold } from "../../../lib/milestones";
import { isoWeek } from "../../../lib/gamify";
import {
  DECLINE_LABELS,
  CHECKIN_NOTE_MAX,
  CHECKIN_NUDGE_WEEKS,
} from "../../../lib/types";
import { Avatar, AvStack, CheckIcon, FlameIcon } from "../../../components/ui";
import { ProfileModal } from "../../../components/ProfileModal";
import type {
  Cohort,
  CohortApplication,
  MilestoneSubmission,
  BuildLog,
  CheckIn,
  Profile,
  DeclineReason,
} from "../../../lib/types";

const WEEK_MS = 7 * 86400000;

/** "3 weeks ago" / "this week" — the whole vocabulary the nudge needs. */
function weeksAgo(d: Date, now: number): number {
  return Math.floor((now - d.getTime()) / WEEK_MS);
}

function fmtWhen(d: Date): string {
  return (
    d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

export default function CohortPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, profile } = useAuth();
  const router = useRouter();

  const [cohort, setCohort] = useState<Cohort | null | undefined>(undefined);
  const [subs, setSubs] = useState<MilestoneSubmission[]>([]);
  const [logs, setLogs] = useState<BuildLog[]>([]);
  const [apps, setApps] = useState<CohortApplication[]>([]);
  const [checkIns, setCheckIns] = useState<CheckIn[]>([]);

  // Check-in request composer
  const [asking, setAsking] = useState(false);
  const [askNote, setAskNote] = useState("");

  // Applicant profile viewer (founder reviewing an application). The
  // application carries the squad-specific weekly hours, so we keep it
  // alongside the public profile while the modal is open.
  const [viewing, setViewing] = useState<Profile | null>(null);
  const [viewingApp, setViewingApp] = useState<CohortApplication | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);

  // Milestone the operator is submitting evidence for
  const [submitFor, setSubmitFor] = useState<number | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [note, setNote] = useState("");

  // Verification: return-with-reason editor (keyed by submission doc key)
  const [returning, setReturning] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");

  // Build log composer
  const [logText, setLogText] = useState("");
  const [busy, setBusy] = useState(false);
  // Captured once on mount — "is this check-in in the past?" needs a clock,
  // and calling one during render is impure.
  const [now] = useState(() => Date.now());

  const isMember = !!(user && cohort && cohort.memberUids.includes(user.uid));
  const isFounder = !!(user && cohort && cohort.founderUid === user.uid);
  const isPeerLead = !!(user && cohort && cohort.peerLeadUid === user.uid);
  const isMentor = profile?.role === "mentor";
  /** This squad's own mentor — the only one who can take its check-ins. */
  const isOurMentor = !!(user && cohort && cohort.mentorUid === user.uid);

  useEffect(() => {
    if (user === null) router.replace("/login");
  }, [user, router]);

  useEffect(() => {
    if (!user) return;
    return watchCohort(id, setCohort);
  }, [user, id]);

  useEffect(() => {
    if (!isMember && !isMentor) return;
    return watchSubmissions(id, setSubs);
  }, [isMember, isMentor, id]);

  useEffect(() => {
    if (!isMember && !isMentor) return;
    return watchBuildLogs(id, setLogs);
  }, [isMember, isMentor, id]);

  useEffect(() => {
    if (!isMember) return;
    return watchApplications(id, setApps);
  }, [isMember, id]);

  // Check-ins are readable by this squad and its mentor alone.
  useEffect(() => {
    if (!isMember && !isOurMentor) return;
    return watchCheckIns(id, setCheckIns);
  }, [isMember, isOurMentor, id]);

  const byMilestone = useMemo(() => {
    const map = new Map<number, MilestoneSubmission[]>();
    for (const s of subs) {
      const list = map.get(s.milestoneId) ?? [];
      list.push(s);
      map.set(s.milestoneId, list);
    }
    return map;
  }, [subs]);

  /** The squad's current milestone: first one not yet squad-complete. */
  const currentMilestoneId = useMemo(() => {
    if (!cohort) return 1;
    const threshold = squadThreshold(cohort.memberUids.length);
    for (const m of TRACK) {
      const verified = (byMilestone.get(m.id) ?? []).filter(
        (s) => s.status === "verified"
      ).length;
      if (verified < threshold) return m.id;
    }
    return TRACK.length;
  }, [cohort, byMilestone]);

  const ritualDone = cohort?.lastRitualWeek === isoWeek();

  /* ---- Check-ins: what's outstanding, what's booked, how stale ---- */
  const pendingCheckIn = checkIns.find((c) => c.status === "requested") ?? null;
  const upcomingCheckIn =
    checkIns
      .filter(
        (c) =>
          c.status === "confirmed" && c.startsAt && c.startsAt.toDate().getTime() > now
      )
      .sort((a, b) => a.startsAt!.toDate().getTime() - b.startsAt!.toDate().getTime())[0] ??
    null;
  const lastCheckIn = lastCheckInAt(checkIns, now);
  const staleWeeks = lastCheckIn ? weeksAgo(lastCheckIn, now) : null;
  // Nudge only — nothing is blocked or docked for going quiet.
  const nudge =
    !pendingCheckIn &&
    !upcomingCheckIn &&
    (staleWeeks === null || staleWeeks >= CHECKIN_NUDGE_WEEKS);

  async function sendCheckInRequest() {
    if (!profile || !cohort) return;
    setBusy(true);
    try {
      await requestCheckIn(cohort, profile, askNote.trim());
      setAsking(false);
      setAskNote("");
    } finally {
      setBusy(false);
    }
  }

  async function sendSubmission(milestoneId: number) {
    if (!profile || !evidenceUrl.trim()) return;
    setBusy(true);
    try {
      await submitMilestone(id, profile, milestoneId, evidenceUrl.trim(), note.trim());
      setSubmitFor(null);
      setEvidenceUrl("");
      setNote("");
    } finally {
      setBusy(false);
    }
  }

  async function decide(sub: MilestoneSubmission, verdict: "verified" | "returned") {
    if (!profile) return;
    setBusy(true);
    try {
      await decideSubmission(
        id,
        sub,
        profile,
        verdict,
        verdict === "returned" ? returnReason.trim() : null
      );
      setReturning(null);
      setReturnReason("");
    } finally {
      setBusy(false);
    }
  }

  async function postLog() {
    if (!profile || !logText.trim()) return;
    setBusy(true);
    try {
      await addBuildLog(id, profile, logText.trim());
      setLogText("");
    } finally {
      setBusy(false);
    }
  }

  if (!user || cohort === undefined) return null;

  if (cohort === null) {
    return (
      <div className="screen">
        <div className="empty">
          <p>This squad doesn&apos;t exist.</p>
          <Link href="/cohorts" className="btn btn--ghost">
            Back
          </Link>
        </div>
      </div>
    );
  }

  const threshold = squadThreshold(cohort.memberUids.length);
  const consentPending = profile?.consentStatus === "pending";

  return (
    <div className="screen">
      {/* ---- Squad header ---- */}
      <header className="screen__head">
        <div>
          <h1 className="h1" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {cohort.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="sq__icon sq__icon--lg" src={cohort.icon} alt="" />
            )}
            {cohort.name}
            {cohort.weeklyStreak > 0 && (
              <span className="hud__stat hud__stat--fire">
                <FlameIcon size={14} />
                {cohort.weeklyStreak}w
              </span>
            )}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
            <AvStack
              names={cohort.memberUids.map(
                (uid) =>
                  (cohort.memberNames[uid] ?? "?") +
                  (uid === cohort.peerLeadUid ? " (lead)" : "")
              )}
            />
            <span className="micro">
              {cohort.meetingSlot || "no slot"}
              {cohort.state === "forming" && " · forming"}
              {cohort.state === "stalled" && " · stalled"}
            </span>
            {cohort.mentorUid ? (
              <span className="chip chip--why">Mentor: {cohort.mentorName}</span>
            ) : (
              <span className="chip chip--want">Awaiting mentor</span>
            )}
            {cohort.link && (
              <a
                className="micro sq__link"
                href={cohort.link}
                target="_blank"
                rel="noopener noreferrer"
              >
                Visit site ↗
              </a>
            )}
          </div>
        </div>
        {isMember &&
          (ritualDone ? (
            <span className="badge badge--earned">
              <CheckIcon size={11} /> ritual done
            </span>
          ) : (
            <button
              className="btn btn--verify"
              disabled={busy || !profile}
              onClick={() => profile && markRitual(cohort, profile)}
            >
              We met <span className="num">+25</span>
            </button>
          ))}
      </header>

      {!isMember && !isMentor ? (
        <div className="empty">
          <p>You&apos;re not in this squad.</p>
          <Link href="/cohorts" className="btn btn--primary">
            Find squads
          </Link>
        </div>
      ) : (
        <div className="grid2 grid2--wide">
          {/* ---- The quest path ---- */}
          <section className="tile">
            <div className="tile__head">
              <h2 className="h3">The Track</h2>
              <span className="path__count">
                clears at {threshold}/{cohort.memberUids.length}
              </span>
            </div>

            <div className="path">
              {TRACK.map((m) => {
                const mySub = subs.find(
                  (s) => s.milestoneId === m.id && s.uid === user.uid
                );
                const all = byMilestone.get(m.id) ?? [];
                const verified = all.filter((s) => s.status === "verified").length;
                const squadDone = verified >= threshold;
                const isCurrent = m.id === currentMilestoneId;
                const canIVerify =
                  (m.verifier === "peer_lead" && (isPeerLead || isMentor)) ||
                  (m.verifier === "mentor" && isMentor);
                const queue = all.filter((s) => s.status === "submitted");
                const state = squadDone ? "done" : isCurrent ? "active" : "locked";

                return (
                  <div key={m.id} className={`path__item ${state}`}>
                    <span className="path__node">
                      {squadDone ? <CheckIcon size={18} /> : m.id}
                    </span>
                    <div className="path__body">
                      <div className="path__top">
                        <span className="path__name">{m.name}</span>
                        <div className="path__meta">
                          {/* XP is what an operator earns here. A mentor is
                              paying it out, and the Verify button already
                              says how much. */}
                          {isMember && <span className="xp">+{m.xp}</span>}
                          <span className="path__count">
                            {verified}/{cohort.memberUids.length}
                          </span>
                        </div>
                      </div>

                      {(isCurrent || mySub) && (
                        <div className="path__detail">
                          <p className="path__evidence">
                            <b>Proof:</b> {m.evidence}{" "}
                            <span className="muted">(~{m.effort})</span>
                          </p>

                          {/* My state on this milestone */}
                          {isMember && (
                            <>
                              {mySub?.status === "verified" && (
                                <span className="path__state path__state--ok pop">
                                  <CheckIcon size={12} /> Verified by {mySub.verifierName}
                                </span>
                              )}
                              {mySub?.status === "submitted" && (
                                <span className="path__state">
                                  In review — {m.verifier === "peer_lead" ? "peer lead" : "mentor"}
                                </span>
                              )}
                              {mySub?.status === "returned" && (
                                <>
                                  <span className="path__state path__state--warn">
                                    Returned: {mySub.returnReason}
                                  </span>
                                  {submitFor !== m.id && (
                                    <button
                                      className="btn btn--ghost btn--sm"
                                      onClick={() => {
                                        setSubmitFor(m.id);
                                        setEvidenceUrl(mySub.evidenceUrl);
                                        setNote(mySub.note);
                                      }}
                                    >
                                      Fix &amp; resend
                                    </button>
                                  )}
                                </>
                              )}
                              {!mySub && isCurrent && submitFor !== m.id && (
                                <button
                                  className="btn btn--primary btn--sm"
                                  disabled={consentPending}
                                  onClick={() => {
                                    setSubmitFor(m.id);
                                    setEvidenceUrl("");
                                    setNote("");
                                  }}
                                >
                                  Submit proof
                                </button>
                              )}
                              {submitFor === m.id && (
                                <div className="path__form">
                                  <input
                                    className="input"
                                    autoFocus
                                    value={evidenceUrl}
                                    onChange={(e) => setEvidenceUrl(e.target.value)}
                                    placeholder="Link your proof"
                                    maxLength={500}
                                  />
                                  <textarea
                                    className="input"
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    placeholder="What should they look at?"
                                    maxLength={500}
                                  />
                                  <div className="row-actions" style={{ marginTop: 0 }}>
                                    <button
                                      className="btn btn--ghost btn--sm"
                                      onClick={() => setSubmitFor(null)}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      className="btn btn--primary btn--sm"
                                      disabled={busy || !evidenceUrl.trim()}
                                      onClick={() => sendSubmission(m.id)}
                                    >
                                      {busy ? "…" : "Send"}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </>
                          )}

                          {/* Verification queue for whoever can verify */}
                          {canIVerify && queue.length > 0 && (
                            <div className="path__queue">
                              {queue.map((s) => {
                                const key = `${s.milestoneId}_${s.uid}`;
                                return (
                                  <div key={key} className="path__queue-row">
                                    <div className="path__queue-who">
                                      <Avatar name={s.name} size="sm" />
                                      {s.name}
                                      <a href={s.evidenceUrl} target="_blank" rel="noreferrer">
                                        proof
                                      </a>
                                    </div>
                                    {s.note && <p className="path__queue-note">{s.note}</p>}
                                    {returning === key ? (
                                      <div className="path__form">
                                        <input
                                          className="input"
                                          autoFocus
                                          value={returnReason}
                                          onChange={(e) => setReturnReason(e.target.value)}
                                          placeholder="What's missing, specifically?"
                                          maxLength={300}
                                        />
                                        <div className="row-actions" style={{ marginTop: 0 }}>
                                          <button
                                            className="btn btn--ghost btn--sm"
                                            onClick={() => setReturning(null)}
                                          >
                                            Cancel
                                          </button>
                                          <button
                                            className="btn btn--ink btn--sm"
                                            disabled={busy || !returnReason.trim()}
                                            onClick={() => decide(s, "returned")}
                                          >
                                            Return
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="row-actions" style={{ marginTop: 0 }}>
                                        <button
                                          className="btn btn--verify btn--sm"
                                          disabled={busy}
                                          onClick={() => decide(s, "verified")}
                                        >
                                          Verify <span className="num">+{m.xp}</span>
                                        </button>
                                        <button
                                          className="btn btn--ghost btn--sm"
                                          onClick={() => {
                                            setReturning(key);
                                            setReturnReason("");
                                          }}
                                        >
                                          Return
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="stack">
            {/* ---- Mentor check-ins ---- */}
            {(isMember || isOurMentor) && (
              <section className={`tile ${nudge && cohort.mentorUid ? "tile--ember" : ""}`}>
                <div className="tile__head">
                  <h2 className="h3">Mentor check-in</h2>
                  {lastCheckIn ? (
                    <span className="micro">
                      {staleWeeks === 0 ? "this week" : `${staleWeeks}w ago`}
                    </span>
                  ) : (
                    <span className="micro">none yet</span>
                  )}
                </div>

                {!cohort.mentorUid ? (
                  <p className="empty" style={{ marginTop: 0 }}>
                    A mentor picks this squad up soon.
                  </p>
                ) : (
                  <>
                    {upcomingCheckIn && (
                      <div className="ses">
                        <div className="ses__body">
                          <span className="ses__title">
                            {fmtWhen(upcomingCheckIn.startsAt!.toDate())}
                          </span>
                          <span className="ses__meta">
                            {upcomingCheckIn.mentorName} · {upcomingCheckIn.durationMins}m
                          </span>
                        </div>
                        {upcomingCheckIn.meetLink && (
                          <div className="ses__act">
                            <a
                              className="btn btn--primary btn--sm"
                              href={upcomingCheckIn.meetLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Join
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    {pendingCheckIn && (
                      <div className="ses">
                        <div className="ses__body">
                          <span className="ses__title">Waiting on a time</span>
                          <span className="ses__meta">
                            asked by {pendingCheckIn.requestedByName}
                          </span>
                          {pendingCheckIn.note && (
                            <p className="path__queue-note">{pendingCheckIn.note}</p>
                          )}
                        </div>
                        {pendingCheckIn.requestedByUid === user.uid && (
                          <div className="ses__act">
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() =>
                                withdrawCheckIn(id, pendingCheckIn.id).catch(() => {})
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {isMember && !pendingCheckIn && !asking && (
                      <>
                        {nudge && (
                          <p className="micro" style={{ marginBottom: 10 }}>
                            {lastCheckIn
                              ? `Last one ${staleWeeks} weeks ago.`
                              : "Never met your mentor."}
                          </p>
                        )}
                        <button
                          className="btn btn--primary btn--sm"
                          disabled={consentPending}
                          onClick={() => {
                            setAsking(true);
                            setAskNote("");
                          }}
                        >
                          Ask {cohort.mentorName?.split(" ")[0] ?? "mentor"}
                        </button>
                      </>
                    )}

                    {asking && (
                      <div className="path__form">
                        <textarea
                          className="input"
                          autoFocus
                          value={askNote}
                          onChange={(e) => setAskNote(e.target.value)}
                          placeholder="What do you need help with?"
                          maxLength={CHECKIN_NOTE_MAX}
                        />
                        <div className="row-actions" style={{ marginTop: 0 }}>
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={() => setAsking(false)}
                          >
                            Cancel
                          </button>
                          <button
                            className="btn btn--primary btn--sm"
                            disabled={busy}
                            onClick={sendCheckInRequest}
                          >
                            {busy ? "…" : "Send"}
                          </button>
                        </div>
                      </div>
                    )}

                    {isOurMentor && !isMember && !pendingCheckIn && !upcomingCheckIn && (
                      <p className="empty" style={{ marginTop: 0 }}>
                        Nothing outstanding.
                      </p>
                    )}
                  </>
                )}
              </section>
            )}

            {/* ---- Build log ---- */}
            <section className="tile">
              <div className="tile__head">
                <h2 className="h3">Build log</h2>
                {isMember && <span className="xp">+10/day</span>}
              </div>
              {isMember && (
                <div className="composer">
                  <input
                    className="input"
                    value={logText}
                    onChange={(e) => setLogText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !busy && logText.trim() && postLog()}
                    placeholder="One line. What shipped?"
                    maxLength={300}
                    disabled={consentPending}
                  />
                  <button
                    className="btn btn--primary"
                    disabled={busy || !logText.trim() || consentPending}
                    onClick={postLog}
                  >
                    Ship
                  </button>
                </div>
              )}
              {logs.length === 0 ? (
                <p className="empty" style={{ marginTop: 12 }}>
                  Quiet so far.
                </p>
              ) : (
                <div className="feed">
                  {logs.map((l) => (
                    <div key={l.id} className="feed__row">
                      <Avatar name={l.name} size="sm" />
                      <div className="feed__body">
                        <b>{l.name}</b> <span className="feed__day">{l.day}</span>
                        <p>{l.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ---- Applications ---- */}
            {isMember && apps.length > 0 && (
              <section className="tile tile--ember">
                <div className="tile__head">
                  <h2 className="h3">Wants in</h2>
                  <span className="micro">{apps.length}</span>
                </div>
                <div className="stack" style={{ gap: 14 }}>
                  {apps.map((a) => (
                    <div key={a.applicantUid}>
                      <div className="path__queue-who">
                        <Avatar name={a.applicantName} size="sm" />
                        <button
                          className="link-btn"
                          onClick={() => {
                            setViewingApp(a);
                            getProfile(a.applicantUid).then(setViewing).catch(() => {});
                          }}
                        >
                          {a.applicantName}
                        </button>
                        <span className="micro">{a.hours}h/wk</span>
                      </div>
                      {a.pitch && <p className="path__queue-note">{a.pitch}</p>}
                      {isFounder &&
                        (declining === a.applicantUid ? (
                          <div className="chip-row" style={{ marginTop: 8 }}>
                            {(Object.keys(DECLINE_LABELS) as DeclineReason[]).map((r) => (
                              <button
                                key={r}
                                className="pick"
                                onClick={() => {
                                  decideApplication(cohort, a, false, r);
                                  setDeclining(null);
                                }}
                              >
                                {DECLINE_LABELS[r]}
                              </button>
                            ))}
                            <button className="pick" onClick={() => setDeclining(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="row-actions" style={{ marginTop: 8 }}>
                            <button
                              className="btn btn--verify btn--sm"
                              disabled={cohort.memberUids.length >= 8}
                              onClick={() => decideApplication(cohort, a, true)}
                            >
                              Accept
                            </button>
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() => setDeclining(a.applicantUid)}
                            >
                              Decline
                            </button>
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/* ---- Applicant profile viewer ---- */}
      {viewing && (
        <ProfileModal
          profile={viewing}
          hours={viewingApp?.hours}
          onClose={() => {
            setViewing(null);
            setViewingApp(null);
          }}
        />
      )}
    </div>
  );
}
