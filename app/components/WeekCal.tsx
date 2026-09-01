"use client";

import type { Profile, Workshop } from "../lib/types";
import { SessionAction, SeatChip, isEnrolled } from "./WorkshopList";

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Vertical week calendar — today + the next six days as stacked rows.
 *  Sessions are pieces pinned to their day; empty days collapse to a
 *  slim dotted slot so the shape of the week reads at a glance. */
export function WeekCal({
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
  const now = new Date();
  const days = Array.from(
    { length: 7 },
    (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
  );

  return (
    <div className="wcal">
      {days.map((d, i) => {
        const evs = workshops
          .filter((w) => sameDay(w.startsAt.toDate(), d))
          .sort((a, b) => a.startsAt.toDate().getTime() - b.startsAt.toDate().getTime());

        return (
          <div
            key={d.toDateString()}
            className={`wcal__day ${i === 0 ? "wcal__day--today" : ""}`}
          >
            <span className="wcal__label">
              <span className="wcal__dow">
                {i === 0 ? "today" : d.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <b className="wcal__num">{d.getDate()}</b>
            </span>
            {evs.length === 0 ? (
              <span className="wcal__nil" aria-hidden="true" />
            ) : (
              <div className="wcal__evs">
                {evs.map((w) => {
                  const enrolled = isEnrolled(w, profile);
                  return (
                    <div key={w.id} className={`wcal__ev ${enrolled ? "wcal__ev--in" : ""}`}>
                      <span className="wcal__time">
                        {w.startsAt
                          .toDate()
                          .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="wcal__title">
                        {w.title}
                        {!enrolled && <SeatChip w={w} />}
                      </span>
                      <span className="wcal__act">
                        <SessionAction w={w} profile={profile} onEnroll={onEnroll} onLeave={onLeave} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
