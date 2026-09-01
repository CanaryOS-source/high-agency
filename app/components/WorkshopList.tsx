"use client";

import { useState } from "react";
import type { Profile, Workshop } from "../lib/types";
import { workshopSpots } from "../lib/types";
import { CalendarIcon } from "./ui";

/** Seats left, shown everywhere a session renders. Silent when the session
 *  is uncapped (legacy docs only) or the viewer already holds a seat. */
export function SeatChip({ w }: { w: Workshop }) {
  const { left, full } = workshopSpots(w);
  if (left === null) return null;
  if (full) return <span className="chip chip--mute">Full</span>;
  return <span className="chip chip--want">{left} left</span>;
}

function dateParts(ts: { toDate: () => Date }): { day: string; mon: string; time: string } {
  const d = ts.toDate();
  return {
    day: String(d.getDate()),
    mon: d.toLocaleDateString(undefined, { month: "short" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

export function isEnrolled(w: Workshop, profile: Profile): boolean {
  // The workshop doc is authoritative for seats; the profile mirror is the
  // fallback for legacy enrollments made before the roster moved onto the doc.
  return (w.enrolledUids ?? []).includes(profile.uid) || profile.enrolledWorkshops.includes(w.id);
}

/** The action cluster for one workshop: join/leave when enrolled, enroll
 *  otherwise, "full" when there's no seat. Every surface that lists sessions
 *  renders this — never a bare Join link. */
export function SessionAction({
  w,
  profile,
  onEnroll,
  onLeave,
}: {
  w: Workshop;
  profile: Profile;
  onEnroll?: (w: Workshop) => void;
  onLeave?: (w: Workshop) => void;
}) {
  // Captured once per mount: "has it started?" needs a clock, and reading
  // one during render is impure.
  const [now] = useState(() => Date.now());
  const enrolled = isEnrolled(w, profile);
  const full = workshopSpots(w).full;
  const started = w.startsAt.toDate().getTime() <= now;

  if (enrolled)
    return (
      <>
        {w.meetLink ? (
          <a className="btn btn--primary btn--sm" href={w.meetLink} target="_blank" rel="noreferrer">
            Join
          </a>
        ) : (
          <span className="micro">link coming</span>
        )}
        {!started && onLeave && (
          <button className="btn btn--ghost btn--sm" onClick={() => onLeave(w)} title="Give the seat back">
            Leave
          </button>
        )}
      </>
    );
  if (full) return <span className="ses__lock" title="Every seat is taken">Full</span>;
  if (started) return <span className="micro">started</span>;
  return (
    <button className="btn btn--ghost btn--sm" onClick={() => onEnroll?.(w)}>
      Enroll
    </button>
  );
}

/** The enrollable session catalog (Learn page). */
export function WorkshopList({
  workshops,
  profile,
  onEnroll,
  onLeave,
}: {
  workshops: Workshop[];
  profile: Profile;
  onEnroll?: (w: Workshop) => void;
  onLeave?: (w: Workshop) => void;
}) {
  return (
    <div>
      {workshops.map((w) => {
        const enrolled = isEnrolled(w, profile);
        const { day, mon, time } = dateParts(w.startsAt);

        return (
          <div key={w.id} className="ses">
            <div className={`ses__date ${enrolled ? "ses__date--live" : ""}`}>
              <b>{day}</b>
              <span>{mon}</span>
            </div>
            <div className="ses__body">
              <span className="ses__title">
                {w.title}
                {!enrolled && <SeatChip w={w} />}
                {enrolled && w.calendarEventId && (
                  <span className="chip chip--why" title="Invite sent to your Google Calendar">
                    <CalendarIcon size={12} /> on your calendar
                  </span>
                )}
              </span>
              <span className="ses__meta">
                {time} · {w.durationMins}m · {w.mentorName}
              </span>
              {w.description && <p className="path__queue-note">{w.description}</p>}
            </div>
            <div className="ses__act">
              <SessionAction w={w} profile={profile} onEnroll={onEnroll} onLeave={onLeave} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
