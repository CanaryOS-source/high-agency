"use client";

import { useEffect, useMemo, useState } from "react";
import { useMentorGate } from "../../../components/mentorData";
import { watchWorkshopsBetween } from "../../../lib/db";
import { createWorkshop, updateWorkshop, deleteWorkshop } from "../../../lib/api";
import { workshopSpots } from "../../../lib/types";
import type { Workshop } from "../../../lib/types";
import { CalendarIcon, PlusIcon } from "../../../components/ui";
import { useCalendarStatus } from "../../../components/CalendarConnect";
import {
  WorkshopForm,
  blankDraft,
  draftFrom,
  draftToWire,
  type Draft,
} from "../../../components/WorkshopForm";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Sunday of the week containing `d` — the same week boundary the operator
 *  calendar uses, so both roles read a week the same way. */
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Jul 27 – Aug 2" / "Aug 24 – 30" when the week doesn't cross a month. */
function fmtRange(from: Date, to: Date): string {
  const left = from.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const right = to.toLocaleDateString(
    undefined,
    from.getMonth() === to.getMonth()
      ? { day: "numeric" }
      : { month: "short", day: "numeric" }
  );
  return `${left} – ${right}`;
}

export default function MentorWorkshopsPage() {
  const { user, profile } = useMentorGate();
  const { status: calendar } = useCalendarStatus();

  const [today] = useState(() => new Date());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [snap, setSnap] = useState<{ weekKey: number; items: Workshop[] } | null>(null);

  // null = not editing, "" = composing a new one, otherwise a workshop id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

  // Tagged with the week it covers, so paging to a new week reads as "loading"
  // at render instead of needing an effect to blank the previous week first.
  const weekKey = weekStart.getTime();

  useEffect(() => {
    if (!user) return;
    return watchWorkshopsBetween(weekStart, weekEnd, (items) =>
      setSnap({ weekKey, items })
    );
  }, [user, weekStart, weekEnd, weekKey]);

  const workshops = snap && snap.weekKey === weekKey ? snap.items : null;

  const onDay = (d: Date) =>
    (workshops ?? [])
      .filter((w) => sameDay(w.startsAt.toDate(), d))
      .sort((a, b) => a.startsAt.toDate().getTime() - b.startsAt.toDate().getTime());

  const isMine = (w: Workshop) => w.mentorUid === user?.uid;
  const editing = editingId
    ? (workshops ?? []).find((w) => w.id === editingId) ?? null
    : null;

  /** New session, defaulted to 6pm on `on` (or the first day of this week). */
  function startNew(on?: Date) {
    setDraft(blankDraft(on ?? (sameDay(today, weekStart) ? today : weekStart)));
    setEditingId("");
    setError("");
  }

  function startEdit(w: Workshop) {
    setDraft(draftFrom(w));
    setEditingId(w.id);
    setError("");
  }

  function cancel() {
    setEditingId(null);
    setDraft(null);
  }

  async function save() {
    if (!draft || !profile) return;
    setBusy(true);
    setError("");
    try {
      const input = draftToWire(draft);
      if (editingId) await updateWorkshop(editingId, input);
      else await createWorkshop(input);
      // Jump to whichever week the session actually landed in.
      setWeekStart(startOfWeek(new Date(draft.startsAt)));
      cancel();
    } catch {
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: Workshop) {
    const { taken } = workshopSpots(w);
    const warning =
      taken > 0
        ? `Delete "${w.title}"? ${taken} operator${taken === 1 ? " has" : "s have"} a seat.`
        : `Delete "${w.title}"?`;
    if (!confirm(warning)) return;
    await deleteWorkshop(w.id).catch(() => setError("Couldn't delete that."));
  }

  if (!user || !profile) return null;

  const thisWeek = sameDay(weekStart, startOfWeek(today));

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="h1">Workshops</h1>
        {editingId === null && (
          <button className="btn btn--primary" onClick={() => startNew()}>
            <PlusIcon /> New session
          </button>
        )}
      </header>

      {draft && (
        <WorkshopForm
          draft={draft}
          setDraft={setDraft}
          taken={editing ? workshopSpots(editing).taken : 0}
          onSave={save}
          onCancel={cancel}
          busy={busy}
          title={editingId ? "Edit session" : "New session"}
          calendarLinked={editingId ? !!editing?.calendarEventId : !!calendar?.connected}
          editing={!!editingId}
        />
      )}
      {error && <p className="form-err">{error}</p>}

      <section className="tile screen__block">
        <div className="wknav">
          <div className="wknav__ctl">
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setWeekStart(addDays(weekStart, -7))}
              aria-label="Previous week"
            >
              ‹
            </button>
            <h2 className="h3 wknav__range">{fmtRange(weekStart, addDays(weekStart, 6))}</h2>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              aria-label="Next week"
            >
              ›
            </button>
            {!thisWeek && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setWeekStart(startOfWeek(today))}
              >
                This week
              </button>
            )}
          </div>
          <div className="wknav__legend">
            <span className="wknav__key wknav__key--mine">Yours</span>
            <span className="wknav__key">Other mentors</span>
          </div>
        </div>

        {workshops === null ? (
          <p className="empty">Loading…</p>
        ) : (
          <div className="wcal">
            {days.map((d) => {
              const evs = onDay(d);
              return (
                <div
                  key={d.toDateString()}
                  className={`wcal__day ${sameDay(d, today) ? "wcal__day--today" : ""}`}
                >
                  <span className="wcal__label">
                    <span className="wcal__dow">
                      {sameDay(d, today)
                        ? "today"
                        : d.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <b className="wcal__num">{d.getDate()}</b>
                  </span>

                  {evs.length === 0 ? (
                    <span className="wcal__free">
                      <span className="wcal__nil" aria-hidden="true" />
                      {editingId === null && (
                        <button
                          className="wcal__add"
                          onClick={() => startNew(d)}
                          aria-label={`Add a session on ${d.toDateString()}`}
                          title="Schedule a session on this day"
                        >
                          <PlusIcon size={14} />
                        </button>
                      )}
                    </span>
                  ) : (
                    <div className="wcal__evs">
                      {evs.map((w) => {
                        const seats = workshopSpots(w);
                        const mine = isMine(w);
                        return (
                          <div
                            key={w.id}
                            className={`wcal__ev ${mine ? "wcal__ev--mine" : ""}`}
                          >
                            <span className="wcal__time">
                              {fmtTime(w.startsAt.toDate())}
                            </span>
                            <span className="wcal__body">
                              <span className="wcal__title">
                                {w.title}
                                {w.calendarEventId && (
                                  <span className="chip chip--why" title="On the host's Google Calendar with a Meet room">
                                    <CalendarIcon size={12} /> Meet
                                  </span>
                                )}
                              </span>
                              <span className="wcal__by">
                                {mine ? "you" : w.mentorName} · {w.durationMins}m ·{" "}
                                {seats.capacity === null
                                  ? `${seats.taken} enrolled`
                                  : `${seats.taken}/${seats.capacity} seats`}
                              </span>
                            </span>
                            {mine && editingId === null && (
                              <span className="wcal__act">
                                <button
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => startEdit(w)}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => remove(w)}
                                >
                                  Delete
                                </button>
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {editingId === null && (
                        <button
                          className="wcal__add wcal__add--inline"
                          onClick={() => startNew(d)}
                          aria-label={`Add another session on ${d.toDateString()}`}
                          title="Schedule another session on this day"
                        >
                          <PlusIcon size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
