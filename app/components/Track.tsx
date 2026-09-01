"use client";

/* The squad's track. Two faces of one list:
   - TrackView: what the squad reads — done / now / next, with the mentor's
     words on the current step. No buttons; progress belongs to the mentor.
   - TrackEditor: what the mentor works in — write the steps, order them,
     put a day on them, mark them done for the whole squad. */

import { useEffect, useState } from "react";
import type { TrackMilestone } from "../lib/types";
import { TRACK_MAX_MILESTONES, TRACK_TITLE_MAX, TRACK_DETAIL_MAX, currentMilestone } from "../lib/types";
import { TRACK_TEMPLATES, fromTemplate, milestoneId } from "../lib/trackTemplates";
import { CheckIcon } from "./ui";

function fmtDue(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDone(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function trackProgress(track: TrackMilestone[] | undefined): { done: number; total: number } {
  const t = track ?? [];
  return { done: t.filter((m) => !!m.doneAt).length, total: t.length };
}

/* ------------------------------------------------------------------ */
/* Read-only                                                           */
/* ------------------------------------------------------------------ */

export function TrackView({
  track,
  mentorName,
}: {
  track: TrackMilestone[] | undefined;
  mentorName?: string;
}) {
  const list = track ?? [];
  if (list.length === 0) {
    return (
      <p className="empty" style={{ marginTop: 0 }}>
        {mentorName ? `${mentorName} hasn't set the track yet.` : "The track is set once a mentor takes the squad on."}
      </p>
    );
  }
  const current = currentMilestone(list);
  return (
    <div className="path">
      {list.map((m, i) => {
        const state = m.doneAt ? "done" : current?.id === m.id ? "active" : "locked";
        const due = fmtDue(m.dueDay);
        return (
          <div key={m.id} className={`path__item ${state}`}>
            <span className="path__node">{m.doneAt ? <CheckIcon size={18} /> : i + 1}</span>
            <div className="path__body">
              <div className="path__top">
                <span className="path__name">{m.title}</span>
                <div className="path__meta">
                  <span className="path__count">
                    {m.doneAt ? `done ${fmtDone(m.doneAt)}` : due ? `by ${due}` : ""}
                  </span>
                </div>
              </div>
              {state === "active" && m.detail && (
                <div className="path__detail">
                  <p className="path__evidence">{m.detail}</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mentor editor                                                       */
/* ------------------------------------------------------------------ */

export function TrackEditor({
  track,
  onSave,
}: {
  track: TrackMilestone[] | undefined;
  /** Persist the whole list. Rejections surface as an error line. */
  onSave: (track: TrackMilestone[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TrackMilestone[]>(track ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  // Follow the live doc while the mentor isn't mid-edit.
  useEffect(() => {
    if (!dirty) setDraft(track ?? []);
  }, [track, dirty]);

  function edit(next: TrackMilestone[]) {
    setDraft(next);
    setDirty(true);
  }

  function patch(id: string, p: Partial<TrackMilestone>) {
    edit(draft.map((m) => (m.id === id ? { ...m, ...p } : m)));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    edit(next);
  }

  function add() {
    if (draft.length >= TRACK_MAX_MILESTONES) return;
    const m: TrackMilestone = { id: milestoneId(), title: "", detail: "", dueDay: "", doneAt: null };
    edit([...draft, m]);
    setOpen(m.id);
  }

  async function persist(next: TrackMilestone[]) {
    setBusy(true);
    setError("");
    try {
      const clean = next
        .map((m) => ({
          ...m,
          title: m.title.trim().slice(0, TRACK_TITLE_MAX),
          detail: m.detail.trim().slice(0, TRACK_DETAIL_MAX),
        }))
        .filter((m) => m.title);
      await onSave(clean);
      setDraft(clean);
      setDirty(false);
    } catch {
      setError("Couldn't save the track. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Done / reopen saves straight away — it's the one thing a mentor does
   *  in the moment, and it shouldn't wait on a Save button. */
  function toggleDone(id: string) {
    const next = draft.map((m) =>
      m.id === id ? { ...m, doneAt: m.doneAt ? null : Date.now() } : m
    );
    persist(next);
  }

  const { done, total } = trackProgress(draft);
  const current = currentMilestone(draft);

  if (draft.length === 0) {
    return (
      <div>
        <p className="muted" style={{ marginBottom: 12 }}>
          No track yet. Start from a template or write your own — you can change anything later.
        </p>
        <div className="chip-row" style={{ marginBottom: 12 }}>
          {TRACK_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="pick"
              title={t.blurb}
              onClick={() => edit(fromTemplate(t))}
            >
              {t.name} · {t.milestones.length} steps
            </button>
          ))}
          <button type="button" className="pick" onClick={add}>
            Blank
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="screen__label" style={{ marginBottom: 10 }}>
        <span className="micro">
          {done}/{total} done{current ? ` · now: ${current.title || "untitled"}` : " · complete"}
        </span>
        <span className="micro">{draft.length}/{TRACK_MAX_MILESTONES}</span>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        {draft.map((m, i) => {
          const isOpen = open === m.id;
          const state = m.doneAt ? "done" : current?.id === m.id ? "active" : "locked";
          return (
            <div key={m.id} className={`tile tile--flat track-row ${state === "active" ? "tile--ember" : ""}`}>
              <div className="track-row__head">
                <span className="path__node" style={{ flexShrink: 0 }}>
                  {m.doneAt ? <CheckIcon size={16} /> : i + 1}
                </span>
                <input
                  className="track-row__title"
                  value={m.title}
                  placeholder="Milestone"
                  maxLength={TRACK_TITLE_MAX}
                  onChange={(e) => patch(m.id, { title: e.target.value })}
                  onFocus={() => setOpen(m.id)}
                />
                <button
                  type="button"
                  className={`btn btn--sm ${m.doneAt ? "btn--ghost" : "btn--verify"}`}
                  disabled={busy || !m.title.trim()}
                  onClick={() => toggleDone(m.id)}
                  title={m.doneAt ? "Reopen for the squad" : "Mark done for the whole squad"}
                >
                  {m.doneAt ? "Reopen" : "Mark done"}
                </button>
              </div>
              {isOpen && (
                <div className="track-row__body">
                  <textarea
                    className="input"
                    value={m.detail}
                    placeholder="What done looks like, in your words."
                    maxLength={TRACK_DETAIL_MAX}
                    onChange={(e) => patch(m.id, { detail: e.target.value })}
                  />
                  <div className="track-row__tools">
                    <label className="micro">
                      Due{" "}
                      <input
                        type="date"
                        value={m.dueDay}
                        onChange={(e) => patch(m.id, { dueDay: e.target.value })}
                      />
                    </label>
                    <span className="row-actions" style={{ marginTop: 0 }}>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Move down">↓</button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          if (m.title.trim() && !confirm(`Remove "${m.title}"?`)) return;
                          edit(draft.filter((x) => x.id !== m.id));
                        }}
                      >
                        Remove
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(null)}>
                        Close
                      </button>
                    </span>
                  </div>
                </div>
              )}
              {!isOpen && (m.detail || m.dueDay) && (
                <button type="button" className="track-row__peek" onClick={() => setOpen(m.id)}>
                  {m.detail}
                  {m.dueDay && <span className="micro"> · by {fmtDue(m.dueDay)}</span>}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="form-err">{error}</p>}
      <div className="row-actions">
        <button type="button" className="btn btn--ghost" onClick={add} disabled={draft.length >= TRACK_MAX_MILESTONES}>
          + Add a step
        </button>
        {dirty && (
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setDraft(track ?? []);
                setDirty(false);
              }}
              disabled={busy}
            >
              Discard
            </button>
            <button type="button" className="btn btn--primary" onClick={() => persist(draft)} disabled={busy}>
              {busy ? "…" : "Save track"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
