"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import {
  getUpcomingWorkshops,
  getPastWorkshops,
  enrollWorkshop,
  markAttended,
} from "../../lib/db";
import { TRACK } from "../../lib/milestones";
import type { Workshop } from "../../lib/types";
import { WorkshopList } from "../../components/WorkshopList";

export default function LearnPage() {
  const { user, profile } = useAuth();
  const router = useRouter();

  const [workshops, setWorkshops] = useState<Workshop[] | null>(null);
  const [recordings, setRecordings] = useState<Workshop[]>([]);
  // Seat feedback when someone loses the race for the last spot.
  const [seatErr, setSeatErr] = useState("");

  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (user && profile === null) router.replace("/onboarding");
    // Mentors run sessions; they don't enroll in them.
    else if (profile?.role === "mentor") router.replace("/mentor/workshops");
  }, [user, profile, router]);

  useEffect(() => {
    if (!user) return;
    getUpcomingWorkshops().then(setWorkshops).catch(() => setWorkshops([]));
    getPastWorkshops().then(setRecordings).catch(() => setRecordings([]));
  }, [user]);

  /** Claim a seat, then reflect it locally — the catalog is fetched once, not
   *  watched, so the roster on screen has to be moved by hand. A "full" result
   *  means someone else took the last seat between load and click. */
  async function enroll(w: Workshop) {
    if (!profile) return;
    setSeatErr("");
    try {
      const result = await enrollWorkshop(profile.uid, w.id);
      if (result === "full") {
        setSeatErr(`"${w.title}" just filled up.`);
        // Pull the real roster so the row shows Full instead of inviting
        // another click that can only fail.
        getUpcomingWorkshops().then(setWorkshops).catch(() => {});
        return;
      }
      setWorkshops((prev) =>
        (prev ?? []).map((x) =>
          x.id === w.id
            ? { ...x, enrolledUids: [...(x.enrolledUids ?? []), profile.uid] }
            : x
        )
      );
    } catch {
      setSeatErr("Couldn't get you in. Try again.");
    }
  }

  if (!user || !profile) return null;

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="h1">Learn</h1>
        <span className="xp">live = +50</span>
      </header>

      <section className="tile screen__block">
        <div className="tile__head">
          <h2 className="h3">Live sessions</h2>
        </div>
        {workshops === null ? (
          <p className="empty">Loading…</p>
        ) : workshops.length === 0 ? (
          <p className="empty">Nothing scheduled.</p>
        ) : (
          <WorkshopList
            workshops={workshops}
            profile={profile}
            onEnroll={enroll}
            onAttend={(w) => markAttended(profile, w).catch(() => {})}
          />
        )}
        {seatErr && <p className="form-err">{seatErr}</p>}
      </section>

      {recordings.length > 0 && (
        <section className="tile screen__block">
          <div className="tile__head">
            <h2 className="h3">Replays</h2>
          </div>
          <div>
            {recordings.map((w) => {
              const d = w.startsAt.toDate();
              return (
                <div key={w.id} className="ses">
                  <div className="ses__date">
                    <b>{d.getDate()}</b>
                    <span>{d.toLocaleDateString(undefined, { month: "short" })}</span>
                  </div>
                  <div className="ses__body">
                    <span className="ses__title">{w.title}</span>
                    <span className="ses__meta">{w.mentorName}</span>
                  </div>
                  <div className="ses__act">
                    <a
                      className="btn btn--ghost btn--sm"
                      href={w.recordingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Watch
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="tile screen__block">
        <div className="tile__head">
          <h2 className="h3">The season</h2>
          <span className="path__count">8 weeks · 7 milestones</span>
        </div>
        <div className="path">
          {TRACK.map((m) => {
            const linked = (workshops ?? []).find((w) => w.milestoneId === m.id);
            return (
              <div key={m.id} className="path__item">
                <span className="path__node">{m.id}</span>
                <div className="path__body">
                  <div className="path__top">
                    <span className="path__name">{m.name}</span>
                    <div className="path__meta">
                      <span className="xp">+{m.xp}</span>
                      <span className="path__count">{m.week}</span>
                    </div>
                  </div>
                  {linked && (
                    <span className="micro" style={{ display: "block", marginTop: 4 }}>
                      ⚡ {linked.title} · {linked.mentorName}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
