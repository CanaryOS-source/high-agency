"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../../components/AuthProvider";
import { watchMyCohorts, watchBuildLogs, addBuildLog, getUpcomingWorkshops } from "../../lib/db";
import { enrollWorkshop, leaveWorkshop } from "../../lib/api";
import { localDay } from "../../lib/streaks";
import { currentMilestone } from "../../lib/types";
import type { Cohort, BuildLog, Workshop } from "../../lib/types";
import { Avatar, AvStack, Bar, CheckIcon, FlameIcon, LockIcon } from "../../components/ui";
import { WeekCal } from "../../components/WeekCal";
import { ConsentResend } from "../../components/ConsentResend";
import { trackProgress } from "../../components/Track";

export default function HomePage() {
  const { user, profile } = useAuth();
  const router = useRouter();

  const [myCohorts, setMyCohorts] = useState<Cohort[] | null>(null);
  const [logs, setLogs] = useState<BuildLog[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [logText, setLogText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (user && profile === null) router.replace("/onboarding");
    // The operator app is the streak, the squad, the build log. None of it
    // is a mentor's job, so they never land here.
    else if (profile?.role === "mentor") router.replace("/mentor");
  }, [user, profile, router]);

  useEffect(() => {
    if (!user) return;
    return watchMyCohorts(user.uid, setMyCohorts);
  }, [user]);

  const cohort = myCohorts?.[0] ?? null;

  useEffect(() => {
    if (!cohort) {
      setLogs([]);
      return;
    }
    return watchBuildLogs(cohort.id, setLogs);
  }, [cohort?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    getUpcomingWorkshops().then(setWorkshops).catch(() => {});
  }, [user]);

  /** Claim a seat and reflect it locally — the week's sessions are fetched
   *  once, not watched. */
  async function enroll(w: Workshop) {
    if (!profile) return;
    const result = await enrollWorkshop(w.id).catch(() => "full" as const);
    if (result === "full") return;
    setWorkshops((prev) =>
      prev.map((x) =>
        x.id === w.id ? { ...x, enrolledUids: [...(x.enrolledUids ?? []), profile.uid] } : x
      )
    );
  }

  async function leave(w: Workshop) {
    if (!profile) return;
    await leaveWorkshop(w.id).catch(() => {});
    setWorkshops((prev) =>
      prev.map((x) =>
        x.id === w.id
          ? { ...x, enrolledUids: (x.enrolledUids ?? []).filter((u) => u !== profile.uid) }
          : x
      )
    );
  }

  async function postLog() {
    if (!profile || !cohort || !logText.trim()) return;
    setBusy(true);
    try {
      await addBuildLog(cohort.id, profile, logText.trim());
      setLogText("");
    } finally {
      setBusy(false);
    }
  }

  if (!user || !profile) return null;

  const loggedToday = profile.lastBuildLogDay === localDay();
  const consentPending = profile.consentStatus === "pending";
  const first = profile.name.split(" ")[0];
  const now = cohort ? currentMilestone(cohort.track) : null;
  const progress = cohort ? trackProgress(cohort.track) : { done: 0, total: 0 };

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="h1">Yo, {first}.</h1>
      </header>

      {consentPending && (
        <div className="notice screen__block">
          <LockIcon size={20} />
          <span>
            Waiting on your parent&apos;s OK.
            <small>They got an email — everything unlocks after.</small>
          </span>
          <ConsentResend sentAtMs={profile.consentEmailSentAt?.toMillis()} />
        </div>
      )}

      {cohort ? (
        <div className="grid2 grid2--wide">
          <div className="stack">
            {/* ---- Today's move: the build log ---- */}
            <section className={`tile ${loggedToday ? "tile--lime" : "tile--ember"}`}>
              <div className="tile__head">
                <h2 className="h3">
                  {loggedToday ? (
                    <>
                      <span className="signal"><CheckIcon /></span> Shipped today
                    </>
                  ) : (
                    <>
                      <span className="flame"><FlameIcon /></span> Ship one line
                    </>
                  )}
                </h2>
                {!loggedToday && <span className="micro">keeps the streak</span>}
              </div>
              <div className="composer">
                <input
                  className="input"
                  value={logText}
                  onChange={(e) => setLogText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && logText.trim() && postLog()}
                  placeholder={loggedToday ? "Shipped more? Log it." : "What did you build today?"}
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
              {logs.length > 0 && (
                <div className="feed">
                  {logs.slice(0, 3).map((l) => (
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

            {/* ---- Where the squad is on its track ---- */}
            <Link href={`/cohorts/${cohort.id}`} className="tile tile--tap">
              <div className="tile__head">
                <h2 className="h3">Now</h2>
                {progress.total > 0 && (
                  <span className="micro">
                    {progress.done}/{progress.total}
                  </span>
                )}
              </div>
              {progress.total === 0 ? (
                <p className="empty" style={{ marginTop: 0 }}>
                  {cohort.mentorUid
                    ? `${cohort.mentorName} hasn't set the track yet.`
                    : "The track arrives with your mentor."}
                </p>
              ) : now ? (
                <div className="path" style={{ marginBottom: 12 }}>
                  <div className="path__item active" style={{ padding: 0 }}>
                    <span className="path__node">{progress.done + 1}</span>
                    <div className="path__body">
                      <span className="path__name">{now.title}</span>
                      {now.detail && <p className="path__evidence" style={{ marginTop: 4 }}>{now.detail}</p>}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="path__state path__state--ok" style={{ marginBottom: 12 }}>
                  Track complete
                </p>
              )}
              {progress.total > 0 && <Bar value={progress.done / progress.total} />}
            </Link>
          </div>

          <div className="stack">
            {/* ---- Squad ---- */}
            <Link href={`/cohorts/${cohort.id}`} className="tile tile--tap sq">
              <div className="sq__top">
                <span className="sq__name">{cohort.name}</span>
                {cohort.weeklyStreak > 0 && (
                  <span className="hud__stat hud__stat--fire">
                    <FlameIcon size={14} />
                    {cohort.weeklyStreak}w
                  </span>
                )}
              </div>
              <AvStack names={cohort.memberUids.map((u) => cohort.memberNames[u] ?? "?")} />
              <p className="sq__mission">{cohort.mission}</p>
            </Link>

            {/* ---- This week ---- */}
            <section className="tile">
              <div className="tile__head">
                <h2 className="h3">This week</h2>
                <Link href="/learn" className="screen__more">
                  All
                </Link>
              </div>
              <WeekCal workshops={workshops} profile={profile} onEnroll={enroll} onLeave={leave} />
            </section>
          </div>
        </div>
      ) : myCohorts === null ? null : (
        <div className="stack">
          <section className="tile tile--ember empty" style={{ alignItems: "flex-start" }}>
            <h2 className="h2">No squad yet.</h2>
            <Link href="/cohorts" className="btn btn--primary">
              Find your squad
            </Link>
          </section>
          {workshops.length > 0 && (
            <section className="tile">
              <div className="tile__head">
                <h2 className="h3">This week</h2>
                <Link href="/learn" className="screen__more">
                  All
                </Link>
              </div>
              <WeekCal workshops={workshops} profile={profile} onEnroll={enroll} onLeave={leave} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
