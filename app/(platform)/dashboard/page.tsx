"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../../components/AuthProvider";
import {
  watchMyCohorts,
  watchSubmissions,
  watchBuildLogs,
  addBuildLog,
  getUpcomingWorkshops,
  enrollWorkshop,
  markAttended,
} from "../../lib/db";
import { localDay } from "../../lib/gamify";
import { TRACK } from "../../lib/milestones";
import type { Cohort, MilestoneSubmission, BuildLog, Workshop } from "../../lib/types";
import { Avatar, AvStack, Bar, CheckIcon, FlameIcon, LockIcon } from "../../components/ui";
import { WeekCal } from "../../components/WeekCal";
import { ConsentResend } from "../../components/ConsentResend";

export default function HomePage() {
  const { user, profile } = useAuth();
  const router = useRouter();

  const [myCohorts, setMyCohorts] = useState<Cohort[] | null>(null);
  const [subs, setSubs] = useState<MilestoneSubmission[]>([]);
  const [logs, setLogs] = useState<BuildLog[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [logText, setLogText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (user && profile === null) router.replace("/onboarding");
  }, [user, profile, router]);

  useEffect(() => {
    if (!user) return;
    return watchMyCohorts(user.uid, setMyCohorts);
  }, [user]);

  const cohort = myCohorts?.[0] ?? null;

  useEffect(() => {
    if (!cohort) {
      setSubs([]);
      setLogs([]);
      return;
    }
    const u1 = watchSubmissions(cohort.id, setSubs);
    const u2 = watchBuildLogs(cohort.id, setLogs);
    return () => {
      u1();
      u2();
    };
  }, [cohort?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    getUpcomingWorkshops().then(setWorkshops).catch(() => {});
  }, [user]);

  /** Claim a seat and reflect it locally — same reason as the Learn page: the
   *  week's sessions are fetched once, not watched. */
  async function enroll(w: Workshop) {
    if (!profile) return;
    const result = await enrollWorkshop(profile.uid, w.id).catch(() => "full" as const);
    if (result === "full") return;
    setWorkshops((prev) =>
      prev.map((x) =>
        x.id === w.id
          ? { ...x, enrolledUids: [...(x.enrolledUids ?? []), profile.uid] }
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

  const myVerified = subs.filter(
    (s) => s.uid === profile.uid && s.status === "verified"
  ).length;
  const myCurrent = TRACK.find(
    (m) =>
      !subs.some(
        (s) => s.uid === profile.uid && s.milestoneId === m.id && s.status === "verified"
      )
  );
  const loggedToday = profile.lastBuildLogDay === localDay();
  const consentPending = profile.consentStatus === "pending";
  const first = profile.name.split(" ")[0];

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
                {!loggedToday && <span className="xp">+10</span>}
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

            {/* ---- Next milestone ---- */}
            <Link href={`/cohorts/${cohort.id}`} className="tile tile--tap">
              <div className="tile__head">
                <h2 className="h3">Next up</h2>
                {myCurrent && <span className="xp">+{myCurrent.xp}</span>}
              </div>
              {myCurrent ? (
                <div className="path" style={{ marginBottom: 12 }}>
                  <div className="path__item active" style={{ padding: 0 }}>
                    <span className="path__node">{myCurrent.id}</span>
                    <div className="path__body">
                      <span className="path__name">{myCurrent.name}</span>
                      <div className="path__meta">
                        <span className="path__count">{myCurrent.week}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="path__state path__state--ok" style={{ marginBottom: 12 }}>
                  Track complete
                </p>
              )}
              <Bar value={myVerified / TRACK.length} />
              <span className="micro" style={{ display: "block", marginTop: 8 }}>
                {myVerified}/{TRACK.length} verified
              </span>
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
              <WeekCal
                workshops={workshops}
                profile={profile}
                onEnroll={enroll}
                onAttend={(w) => markAttended(profile, w).catch(() => {})}
              />
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
              <WeekCal
                workshops={workshops}
                profile={profile}
                onEnroll={enroll}
                onAttend={(w) => markAttended(profile, w).catch(() => {})}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
