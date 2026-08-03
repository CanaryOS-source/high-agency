"use client";

/* Authoring a live session. Mentor-only surface — the only place a workshop
   is created or edited. Ownership (mentorUid/mentorName) is never in the form:
   db.workshopDoc stamps it from the signed-in mentor so a byline always
   matches the account that owns the session. */

import { TRACK } from "../lib/milestones";
import { LEVELS } from "../lib/gamify";
import {
  WORKSHOP_MIN_CAPACITY,
  WORKSHOP_MAX_CAPACITY,
  WORKSHOP_DEFAULT_CAPACITY,
} from "../lib/types";
import type { Workshop } from "../lib/types";
import type { WorkshopInput } from "../lib/db";

/** datetime-local <-> Date, both in the browser's local timezone. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** The authored session. `kind` is gone from the form — office hours are no
 *  longer a catalog item (they're squad check-ins now), so everything a mentor
 *  writes here is a capped workshop. */
export type Draft = {
  title: string;
  description: string;
  startsAt: string; // datetime-local string
  durationMins: number;
  capacity: number;
  meetLink: string;
  open: boolean;
  levelGate: number;
  milestoneId: number;
  recordingUrl: string;
};

/** A fresh session. `on` seeds the date when the mentor started from a day
 *  in the calendar; otherwise it's a week out at 6pm. */
export function blankDraft(on?: Date): Draft {
  const d = on ? new Date(on) : new Date();
  if (!on) d.setDate(d.getDate() + 7);
  d.setHours(18, 0, 0, 0);
  return {
    title: "",
    description: "",
    startsAt: toLocalInput(d),
    durationMins: 60,
    capacity: WORKSHOP_DEFAULT_CAPACITY,
    meetLink: "",
    open: false,
    levelGate: 0,
    milestoneId: 0,
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
    open: w.open,
    levelGate: w.levelGate,
    milestoneId: w.milestoneId,
    recordingUrl: w.recordingUrl ?? "",
  };
}

export function draftToInput(d: Draft): WorkshopInput {
  return {
    title: d.title.trim(),
    description: d.description.trim(),
    kind: "workshop",
    startsAt: new Date(d.startsAt),
    durationMins: d.durationMins,
    capacity: d.capacity,
    meetLink: d.meetLink.trim(),
    open: d.open,
    levelGate: d.levelGate,
    milestoneId: d.milestoneId,
    recordingUrl: d.recordingUrl.trim(),
  };
}

/** Clamp to the range the rules will accept, so a stray keystroke can't
 *  produce a write that silently fails. */
export function clampCapacity(n: number): number {
  if (!Number.isFinite(n)) return WORKSHOP_DEFAULT_CAPACITY;
  return Math.min(
    WORKSHOP_MAX_CAPACITY,
    Math.max(WORKSHOP_MIN_CAPACITY, Math.round(n))
  );
}

export function WorkshopForm({
  draft,
  setDraft,
  taken,
  onSave,
  onCancel,
  busy,
  title,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  /** Seats already claimed, so the cap can't be set below the room. */
  taken: number;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  title: string;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft({ ...draft, [k]: v });

  return (
    <div className="tile screen__block">
      <div className="tile__head">
        <h2 className="h3">{title}</h2>
      </div>

      <div className="field">
        <label htmlFor="wf-title">Title</label>
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
        <label htmlFor="wf-desc">Description</label>
        <textarea
          id="wf-desc"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What operators walk away with."
          maxLength={1000}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-starts">Starts</label>
          <input
            id="wf-starts"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => set("startsAt", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="wf-mins">Minutes</label>
          <input
            id="wf-mins"
            type="number"
            min={1}
            max={600}
            value={draft.durationMins}
            onChange={(e) => set("durationMins", Number(e.target.value))}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-seats">Seats</label>
          <input
            id="wf-seats"
            type="number"
            min={WORKSHOP_MIN_CAPACITY}
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
        <div className="field">
          <label htmlFor="wf-link">Meet link</label>
          <input
            id="wf-link"
            value={draft.meetLink}
            onChange={(e) => set("meetLink", e.target.value)}
            placeholder="https://meet.google.com/…"
            maxLength={500}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-milestone">Teaches milestone</label>
          <select
            id="wf-milestone"
            value={draft.milestoneId}
            onChange={(e) => set("milestoneId", Number(e.target.value))}
          >
            <option value={0}>None</option>
            {TRACK.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}. {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="wf-gate">Who can enroll</label>
          <select
            id="wf-gate"
            value={draft.levelGate}
            onChange={(e) => set("levelGate", Number(e.target.value))}
          >
            <option value={0}>Anyone</option>
            {LEVELS.filter((l) => l.level > 1).map((l) => (
              <option key={l.level} value={l.level}>
                Level {l.level} {l.name} and up
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="admin-check">
        <input
          type="checkbox"
          checked={draft.open}
          onChange={(e) => set("open", e.target.checked)}
        />
        <span>The season&apos;s open session — free to every operator</span>
      </label>

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

      <div className="row-actions">
        <button className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={onSave}
          disabled={busy || !draft.title.trim()}
        >
          {busy ? "…" : "Save"}
        </button>
      </div>
    </div>
  );
}
