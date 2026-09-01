"use client";

/* Authoring a live session — the only place a workshop is created or edited.
   Kept to what a mentor actually decides: what, when, how long, how many.
   Ownership is stamped server-side, and the Meet room comes from the mentor's
   Google Calendar when it's connected, so the link field only appears when
   there is nothing to generate it from. */

import type { WorkshopWire } from "../lib/api";
import {
  WORKSHOP_MIN_CAPACITY,
  WORKSHOP_MAX_CAPACITY,
  WORKSHOP_DEFAULT_CAPACITY,
} from "../lib/types";
import type { Workshop } from "../lib/types";

/** datetime-local <-> Date, both in the browser's local timezone. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export type Draft = {
  title: string;
  description: string;
  startsAt: string; // datetime-local string
  durationMins: number;
  capacity: number;
  meetLink: string;
  recordingUrl: string;
};

/** A fresh session. `on` seeds the date when the mentor started from a day
 *  in the calendar; otherwise it's tomorrow at 6pm. */
export function blankDraft(on?: Date): Draft {
  const d = on ? new Date(on) : new Date();
  if (!on) d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  return {
    title: "",
    description: "",
    startsAt: toLocalInput(d),
    durationMins: 60,
    capacity: WORKSHOP_DEFAULT_CAPACITY,
    meetLink: "",
    recordingUrl: "",
  };
}

export function draftFrom(w: Workshop): Draft {
  return {
    title: w.title,
    description: w.description ?? "",
    startsAt: toLocalInput(w.startsAt.toDate()),
    durationMins: w.durationMins,
    capacity: w.capacity ?? WORKSHOP_DEFAULT_CAPACITY,
    meetLink: w.meetLink ?? "",
    recordingUrl: w.recordingUrl ?? "",
  };
}

export function draftToWire(d: Draft): WorkshopWire {
  return {
    title: d.title.trim(),
    description: d.description.trim(),
    startsAt: new Date(d.startsAt).toISOString(),
    durationMins: d.durationMins,
    capacity: d.capacity,
    meetLink: d.meetLink.trim(),
    recordingUrl: d.recordingUrl.trim(),
  };
}

/** Clamp to the range the server will accept, so a stray keystroke can't
 *  produce a write that fails. */
export function clampCapacity(n: number): number {
  if (!Number.isFinite(n)) return WORKSHOP_DEFAULT_CAPACITY;
  return Math.min(WORKSHOP_MAX_CAPACITY, Math.max(WORKSHOP_MIN_CAPACITY, Math.round(n)));
}

const DURATIONS = [30, 45, 60, 90, 120];

export function WorkshopForm({
  draft,
  setDraft,
  taken,
  onSave,
  onCancel,
  busy,
  title,
  calendarLinked,
  editing = false,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  /** Seats already claimed, so the cap can't be set below the room. */
  taken: number;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  title: string;
  /** The Meet room will come from Google Calendar — no link to type. */
  calendarLinked: boolean;
  /** Editing an existing session: show the after-the-fact fields. */
  editing?: boolean;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const startValid = !isNaN(new Date(draft.startsAt).getTime());

  return (
    <div className="tile screen__block">
      <div className="tile__head">
        <h2 className="h3">{title}</h2>
        {calendarLinked && <span className="micro signal">Meet room · your Google Calendar</span>}
      </div>

      <div className="field">
        <label htmlFor="wf-title">What is it?</label>
        <input
          id="wf-title"
          autoFocus
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="The Art of the Cold Ask"
          maxLength={120}
        />
      </div>

      <div className="field">
        <label htmlFor="wf-desc">What operators walk away with</label>
        <textarea
          id="wf-desc"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Two or three lines. Any topic — it's your session."
          maxLength={1000}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-starts">When</label>
          <input
            id="wf-starts"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => set("startsAt", e.target.value)}
          />
        </div>
        <div className="field">
          <label>How long</label>
          <div className="chip-row">
            {DURATIONS.map((m) => (
              <button
                key={m}
                type="button"
                className={`pick ${draft.durationMins === m ? "sel" : ""}`}
                onClick={() => set("durationMins", m)}
              >
                {m}m
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-seats">Seats</label>
          <input
            id="wf-seats"
            type="number"
            min={Math.max(WORKSHOP_MIN_CAPACITY, taken)}
            max={WORKSHOP_MAX_CAPACITY}
            value={draft.capacity}
            onChange={(e) => set("capacity", clampCapacity(Number(e.target.value)))}
          />
          <small className="field__hint">
            {taken > 0
              ? `${taken} already claimed`
              : `${WORKSHOP_MIN_CAPACITY}–${WORKSHOP_MAX_CAPACITY}`}
          </small>
        </div>
        {!calendarLinked && (
          <div className="field">
            <label htmlFor="wf-link">Meet link</label>
            <input
              id="wf-link"
              value={draft.meetLink}
              onChange={(e) => set("meetLink", e.target.value)}
              placeholder="https://meet.google.com/…"
              maxLength={500}
            />
            <small className="field__hint">
              Connect Google Calendar and this is generated for you.
            </small>
          </div>
        )}
      </div>

      {editing && (
        <details className="more">
          <summary className="more__toggle">
            After the session
            <span className="more__hint">recording</span>
          </summary>
          <div className="more__body">
            <div className="field">
              <label htmlFor="wf-rec">Recording URL</label>
              <input
                id="wf-rec"
                value={draft.recordingUrl}
                onChange={(e) => set("recordingUrl", e.target.value)}
                placeholder="Paste once it's posted"
                maxLength={500}
              />
            </div>
          </div>
        </details>
      )}

      <div className="row-actions">
        <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={onSave}
          disabled={busy || !draft.title.trim() || !startValid || draft.capacity < taken}
        >
          {busy ? "…" : editing ? "Save" : "Schedule"}
        </button>
      </div>
    </div>
  );
}
