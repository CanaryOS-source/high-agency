"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  useMentorGate,
  useMentoredSquads,
  useUnassignedSquads,
  useConsentQueue,
} from "../../components/mentorData";
import { watchMyUpcomingWorkshops } from "../../lib/db";
import { createWorkshop } from "../../lib/api";
import { workshopSpots } from "../../lib/types";
import type { Workshop } from "../../lib/types";
import { AvStack, PlusIcon } from "../../components/ui";
import { CalendarConnect, useCalendarStatus } from "../../components/CalendarConnect";
import { WorkshopForm, blankDraft, draftToWire, type Draft } from "../../components/WorkshopForm";
import { trackProgress } from "../../components/Track";

/** One thing on the calendar, whatever kind it is. */
interface Upcoming {
  key: string;
  when: Date;
  title: string;
  meta: string;
  /** Where to go to act on it. */
  href: string;
  /** Direct join link when there is one. */
  meetLink?: string;
}

function fmtWhen(d: Date): string {
  return (
    d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

export default function MentorHomePage() {
  const { user, profile } = useMentorGate();
  const uid = user?.uid ?? null;

  const { mine, loading, requests, upcomingCheckIns, needsTrack } = useMentoredSquads(uid);
  const { squads: unassigned } = useUnassignedSquads(!!uid);
  const { pending } = useConsentQueue(!!uid);
  const { status: calendar } = useCalendarStatus();

  const [sessions, setSessions] = useState<Workshop[]>([]);

  // The new-session composer, right here on the home screen.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!uid) return;
    return watchMyUpcomingWorkshops(uid, setSessions);
  }, [uid]);

  /** Workshops you're running and check-ins you've committed to, in one
   *  chronological list — the only "when am I on" question a mentor asks. */
  const upcoming = useMemo<Upcoming[]>(() => {
    const fromWorkshops: Upcoming[] = sessions.map((w) => {
      const seats = workshopSpots(w);
      return {
        key: `w-${w.id}`,
        when: w.startsAt.toDate(),
        title: w.title,
        meta: `${w.durationMins}m · ${
          seats.capacity === null ? `${seats.taken} enrolled` : `${seats.taken}/${seats.capacity} seats`
        }`,
        href: "/mentor/workshops",
        meetLink: w.meetLink,
      };
    });
    const fromCheckIns: Upcoming[] = upcomingCheckIns.map(({ cohort, checkIn }) => ({
      key: `c-${checkIn.id}`,
      when: checkIn.startsAt!.toDate(),
      title: `Check-in · ${cohort.name}`,
      meta: `${checkIn.durationMins}m · asked by ${checkIn.requestedByName}`,
      href: `/cohorts/${cohort.id}`,
      meetLink: checkIn.meetLink,
    }));
    return [...fromWorkshops, ...fromCheckIns]
      .sort((a, b) => a.when.getTime() - b.when.getTime())
      .slice(0, 6);
  }, [sessions, upcomingCheckIns]);

  async function schedule() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const { calendar: linked } = await createWorkshop(draftToWire(draft));
      setDraft(null);
      setFlash(
        linked === "linked"
          ? "Scheduled. It's on your Google Calendar with a Meet room."
          : "Scheduled."
      );
      setTimeout(() => setFlash(""), 4000);
    } catch {
      setError("Couldn't schedule that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!user || !profile) return null;

  const first = profile.name.split(" ")[0];

  /** The whole job, as counts. Zero-count queues aren't shown — an empty
   *  row is a thing to read, and a mentor's home should only carry work. */
  const queues = [
    {
      n: needsTrack.length,
      label: needsTrack.length === 1 ? "squad needs a track" : "squads need a track",
      href: needsTrack.length === 1 ? `/cohorts/${needsTrack[0].id}` : "/mentor/squads",
    },
    {
      n: requests.length,
      label: requests.length === 1 ? "squad wants time" : "squads want time",
      href: "/mentor/squads",
    },
    {
      n: unassigned?.length ?? 0,
      label: (unassigned?.length ?? 0) === 1 ? "squad needs a mentor" : "squads need a mentor",
      href: "/mentor/squads",
    },
    {
      n: pending?.length ?? 0,
      label: "waiting on a parent",
      href: "/mentor/squads",
    },
  ].filter((q) => q.n > 0);

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="h1">Hey, {first}.</h1>
        {!draft && (
          <button className="btn btn--primary" onClick={() => setDraft(blankDraft())}>
            <PlusIcon /> New workshop
          </button>
        )}
      </header>

      {draft && (
        <WorkshopForm
          draft={draft}
          setDraft={setDraft}
          taken={0}
          onSave={schedule}
          onCancel={() => setDraft(null)}
          busy={busy}
          title="New workshop"
          calendarLinked={!!calendar?.connected}
        />
      )}
      {error && <p className="form-err">{error}</p>}
      {flash && <p className="micro signal screen__block">{flash}</p>}

      {/* Calendar: one line when connected, a real prompt when not. */}
      <section className="screen__block">
        <CalendarConnect returnTo="/mentor" compact />
      </section>

      <section className="screen__block">
        <div className="screen__label">
          <span className="micro">Needs you</span>
        </div>
        {queues.length === 0 ? (
          <p className="empty">Nothing waiting on you.</p>
        ) : (
          <div className="mq">
            {queues.map((q) => (
              <Link key={q.label} href={q.href} className="tile tile--tap mq__item">
                <b className="mq__n">{q.n}</b>
                <span className="mq__label">{q.label}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid2 grid2--wide">
        <section className="tile">
          <div className="tile__head">
            <h2 className="h3">You&apos;re on</h2>
            <Link href="/mentor/workshops" className="screen__more">
              Calendar
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="empty">Nothing booked. Schedule a workshop above.</p>
          ) : (
            <div>
              {upcoming.map((u) => (
                <div key={u.key} className="ses">
                  <div className="ses__date">
                    <b>{u.when.getDate()}</b>
                    <span>{u.when.toLocaleDateString(undefined, { month: "short" })}</span>
                  </div>
                  <div className="ses__body">
                    <span className="ses__title">{u.title}</span>
                    <span className="ses__meta">
                      {fmtWhen(u.when)} · {u.meta}
                    </span>
                  </div>
                  <div className="ses__act">
                    {u.meetLink ? (
                      <a className="btn btn--primary btn--sm" href={u.meetLink} target="_blank" rel="noreferrer">
                        Join
                      </a>
                    ) : (
                      <Link className="btn btn--ghost btn--sm" href={u.href}>
                        Open
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="tile">
          <div className="tile__head">
            <h2 className="h3">Your squads</h2>
            <Link href="/mentor/squads" className="screen__more">
              All
            </Link>
          </div>
          {loading ? (
            <p className="empty">Loading…</p>
          ) : mine.length === 0 ? (
            <p className="empty">None yet — take one on.</p>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {mine.map((c) => {
                const p = trackProgress(c.track);
                return (
                  <Link key={c.id} href={`/cohorts/${c.id}`} className="mrow">
                    <span className="mrow__name">
                      {c.name}
                      <span className="micro" style={{ marginLeft: 8 }}>
                        {p.total === 0 ? "no track yet" : `${p.done}/${p.total}`}
                      </span>
                    </span>
                    <AvStack names={c.memberUids.map((u) => c.memberNames[u] ?? "?")} max={4} />
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
