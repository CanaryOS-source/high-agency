"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import {
  watchAllWorkshops,
  createWorkshop,
  updateWorkshop,
  deleteWorkshop,
  watchPendingConsent,
  grantConsent,
  requestConsentEmail,
  watchUnassignedCohorts,
  watchMentoredCohorts,
  adoptCohort,
  watchCheckIns,
  confirmCheckIn,
  type WorkshopInput,
} from "../../lib/db";
import { TRACK } from "../../lib/milestones";
import { LEVELS } from "../../lib/gamify";
import {
  COHORT_MIN_TO_ACTIVATE,
  WORKSHOP_MIN_CAPACITY,
  WORKSHOP_MAX_CAPACITY,
  WORKSHOP_DEFAULT_CAPACITY,
  CHECKIN_DEFAULT_MINS,
  workshopSpots,
} from "../../lib/types";
import type { Workshop, Profile, Cohort, CheckIn } from "../../lib/types";

/* datetime-local <-> Date, both in the browser's local timezone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** The authored session. `kind` is gone from the form — office hours are no
 *  longer a catalog item (they're squad check-ins now), so everything a mentor
 *  writes here is a capped workshop. */
type Draft = {
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

function blankDraft(): Draft {
  const d = new Date();
  d.setDate(d.getDate() + 7);
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

function draftFrom(w: Workshop): Draft {
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

/** mentorName/mentorUid aren't here — db.workshopDoc stamps them from the
 *  signed-in mentor so the byline always matches the owner. */
function draftToInput(d: Draft): WorkshopInput {
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
function clampCapacity(n: number): number {
  if (!Number.isFinite(n)) return WORKSHOP_DEFAULT_CAPACITY;
  return Math.min(WORKSHOP_MAX_CAPACITY, Math.max(WORKSHOP_MIN_CAPACITY, Math.round(n)));
}

function fmtWhen(w: Workshop): string {
  const d = w.startsAt.toDate();
  return (
    d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

/** Compact "when the consent email went out" label for the queue. */
function fmtSent(ts: { toDate: () => Date }): string {
  const d = ts.toDate();
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

function WorkshopForm({
  draft,
  setDraft,
  mentorName,
  taken,
  onSave,
  onCancel,
  busy,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  /** Read-only byline — the signed-in mentor, not a text field. */
  mentorName: string;
  /** Seats already claimed, so the cap can't be set below the room. */
  taken: number;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft({ ...draft, [k]: v });

  return (
    <div className="tile screen__block">
      <div className="field">
        <label>Title</label>
        <input
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="The Art of the Cold Ask"
          maxLength={120}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Mentor</label>
          <input value={mentorName} readOnly disabled />
          <small className="field__hint">Yours — sessions have owners now.</small>
        </div>
        <div className="field">
          <label>Seats</label>
          <input
            type="number"
            min={WORKSHOP_MIN_CAPACITY}
            max={WORKSHOP_MAX_CAPACITY}
            value={draft.capacity}
            onChange={(e) => set("capacity", clampCapacity(Number(e.target.value)))}
          />
          <small className="field__hint">
            {taken > 0
              ? `${taken} taken · ${WORKSHOP_MIN_CAPACITY}–${WORKSHOP_MAX_CAPACITY}`
              : `${WORKSHOP_MIN_CAPACITY}–${WORKSHOP_MAX_CAPACITY}`}
          </small>
        </div>
      </div>

      <div className="field">
        <label>Description</label>
        <textarea
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What operators walk away with."
          maxLength={1000}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Starts</label>
          <input
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => set("startsAt", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Minutes</label>
          <input
            type="number"
            min={1}
            max={600}
            value={draft.durationMins}
            onChange={(e) => set("durationMins", Number(e.target.value))}
          />
        </div>
      </div>

      <div className="field">
        <label>Meet link</label>
        <input
          value={draft.meetLink}
          onChange={(e) => set("meetLink", e.target.value)}
          placeholder="https://meet.google.com/…"
          maxLength={500}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Milestone</label>
          <select
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
          <label>Level gate</label>
          <select
            value={draft.levelGate}
            onChange={(e) => set("levelGate", Number(e.target.value))}
          >
            <option value={0}>No gate</option>
            {LEVELS.filter((l) => l.level > 1).map((l) => (
              <option key={l.level} value={l.level}>
                L{l.level} {l.name}+
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>Recording URL</label>
        <input
          value={draft.recordingUrl}
          onChange={(e) => set("recordingUrl", e.target.value)}
          placeholder="Posted after the session"
          maxLength={500}
        />
      </div>

      <label className="admin-check">
        <input
          type="checkbox"
          checked={draft.open}
          onChange={(e) => set("open", e.target.checked)}
        />
        <span>Open to all — the season&apos;s free session</span>
      </label>

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

export default function AdminPage() {
  const { user, profile } = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState<"workshops" | "squads" | "checkins" | "members">(
    "workshops"
  );
  const [workshops, setWorkshops] = useState<Workshop[] | null>(null);
  const [pending, setPending] = useState<Profile[] | null>(null);
  const [unassigned, setUnassigned] = useState<Cohort[] | null>(null);
  const [mine, setMine] = useState<Cohort[]>([]);
  // Check-in requests across every squad this mentor owns, keyed by cohort id.
  const [checkIns, setCheckIns] = useState<Record<string, CheckIn[]>>({});
  const [adopting, setAdopting] = useState<string | null>(null);
  // Confirm-a-check-in editor: which one, and the time/link being set.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [whenDraft, setWhenDraft] = useState("");
  const [minsDraft, setMinsDraft] = useState(CHECKIN_DEFAULT_MINS);
  const [linkDraft, setLinkDraft] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null); // null=none, ""=new
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-operator resend feedback in the consent queue, keyed by uid.
  const [resendState, setResendState] = useState<Record<string, string>>({});
  // Captured once on mount — used to tag past sessions without an impure
  // Date.now() call during render.
  const [now] = useState(() => Date.now());

  const isMentor = profile?.role === "mentor";

  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (user && profile === null) router.replace("/onboarding");
  }, [user, profile, router]);

  useEffect(() => {
    if (!isMentor || !user) return;
    const u1 = watchAllWorkshops(setWorkshops);
    const u2 = watchPendingConsent(setPending);
    const u3 = watchUnassignedCohorts(setUnassigned);
    const u4 = watchMentoredCohorts(user.uid, setMine);
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, [isMentor, user]);

  // One subscription per owned squad — mentors hold a handful, and this keeps
  // check-in reads on the same squad-scoped rule the squad page uses (no
  // collection-group query, no extra index). Keyed on the ids rather than the
  // array so an unrelated field changing on a squad doesn't churn listeners.
  const mineIds = mine.map((c) => c.id).join(",");
  useEffect(() => {
    if (!isMentor || !mineIds) return;
    const unsubs = mineIds
      .split(",")
      .map((id) =>
        watchCheckIns(id, (list) => setCheckIns((prev) => ({ ...prev, [id]: list })))
      );
    return () => unsubs.forEach((u) => u());
  }, [isMentor, mineIds]);

  const sortedPending = useMemo(
    () =>
      [...(pending ?? [])].sort((a, b) =>
        (a.country + a.name).localeCompare(b.country + b.name)
      ),
    [pending]
  );

  /** Only my own sessions are editable — the rules agree, so anything else
   *  renders read-only rather than offering a button that would 403. */
  const myWorkshops = useMemo(
    () => (workshops ?? []).filter((w) => w.mentorUid === user?.uid),
    [workshops, user]
  );

  /** Every outstanding request across my squads, oldest first — the queue. */
  const requests = useMemo(
    () =>
      mine
        .flatMap((c) =>
          (checkIns[c.id] ?? [])
            .filter((k) => k.status === "requested")
            .map((k) => ({ cohort: c, checkIn: k }))
        )
        .sort(
          (a, b) =>
            (a.checkIn.createdAt?.toMillis() ?? 0) - (b.checkIn.createdAt?.toMillis() ?? 0)
        ),
    [mine, checkIns]
  );

  if (!user || !profile) return null;

  if (!isMentor) {
    return (
      <div className="screen">
        <header className="screen__head">
          <h1 className="h1">Mentors only</h1>
        </header>
        <p className="empty">Ask the crew for the mentor role if you should be here.</p>
      </div>
    );
  }

  function startNew() {
    setDraft(blankDraft());
    setEditingId("");
  }

  function startEdit(w: Workshop) {
    setDraft(draftFrom(w));
    setEditingId(w.id);
  }

  function cancel() {
    setEditingId(null);
    setDraft(null);
  }

  async function save() {
    if (!draft || !profile) return;
    setBusy(true);
    try {
      const input = draftToInput(draft);
      if (editingId) {
        // Carry the roster through untouched — an edit must never empty seats.
        const existing = (workshops ?? []).find((w) => w.id === editingId);
        await updateWorkshop(editingId, input, profile, existing?.enrolledUids ?? []);
      } else {
        await createWorkshop(input, profile);
      }
      cancel();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this workshop? This can't be undone.")) return;
    await deleteWorkshop(id).catch(() => {});
  }

  /** Take a squad on. Assigns me and, at 3+ members, flips it live. */
  async function adopt(c: Cohort) {
    if (!profile) return;
    setAdopting(c.id);
    try {
      await adoptCohort(c, profile);
    } catch {
      // The only realistic failure is someone else adopting it first; the feed
      // is live, so it disappears on its own.
    } finally {
      setAdopting(null);
    }
  }

  function startConfirm(k: CheckIn) {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    d.setHours(18, 0, 0, 0);
    setConfirming(k.id);
    setWhenDraft(toLocalInput(d));
    setMinsDraft(k.durationMins || CHECKIN_DEFAULT_MINS);
    setLinkDraft("");
  }

  async function sendConfirm(cohortId: string, checkInId: string) {
    setBusy(true);
    try {
      await confirmCheckIn(
        cohortId,
        checkInId,
        new Date(whenDraft),
        minsDraft,
        linkDraft.trim()
      );
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  async function resendConsent(uid: string) {
    setResendState((s) => ({ ...s, [uid]: "Sending…" }));
    try {
      const res = await requestConsentEmail(uid);
      setResendState((s) => ({
        ...s,
        [uid]: res.ok
          ? res.delivery === "logged"
            ? "Link logged to server (no email provider set)"
            : "Email sent"
          : res.error === "no-parent-email"
            ? "No parent email on file"
            : res.error === "rate-limited"
              ? `Sent recently — wait ${res.retryAfter ?? 60}s`
              : "Couldn't send — try again",
      }));
    } catch {
      setResendState((s) => ({ ...s, [uid]: "Couldn't send — try again" }));
    }
  }

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="h1">Admin</h1>
        <span className="micro">{profile.name}</span>
      </header>

      <div className="admin-tabs">
        <button
          className={`admin-tab ${tab === "workshops" ? "admin-tab--on" : ""}`}
          onClick={() => setTab("workshops")}
        >
          Workshops {workshops && `(${myWorkshops.length})`}
        </button>
        <button
          className={`admin-tab ${tab === "squads" ? "admin-tab--on" : ""}`}
          onClick={() => setTab("squads")}
        >
          Squads {unassigned && unassigned.length > 0 && `(${unassigned.length})`}
        </button>
        <button
          className={`admin-tab ${tab === "checkins" ? "admin-tab--on" : ""}`}
          onClick={() => setTab("checkins")}
        >
          Check-ins {requests.length > 0 && `(${requests.length})`}
        </button>
        <button
          className={`admin-tab ${tab === "members" ? "admin-tab--on" : ""}`}
          onClick={() => setTab("members")}
        >
          Consent {pending && pending.length > 0 && `(${pending.length})`}
        </button>
      </div>

      {tab === "workshops" && (
        <section className="screen__block">
          <div className="screen__label">
            <span className="micro">Catalog</span>
            {editingId === null && (
              <button className="btn btn--primary btn--sm" onClick={startNew}>
                New
              </button>
            )}
          </div>

          {editingId === "" && draft && (
            <WorkshopForm
              draft={draft}
              setDraft={setDraft}
              mentorName={profile.name}
              taken={0}
              onSave={save}
              onCancel={cancel}
              busy={busy}
            />
          )}

          {workshops === null ? (
            <p className="empty">Loading…</p>
          ) : myWorkshops.length === 0 ? (
            <p className="empty">Nothing of yours yet.</p>
          ) : (
            <div className="admin-list">
              {myWorkshops.map((w) => {
                const seats = workshopSpots(w);
                return editingId === w.id && draft ? (
                  <WorkshopForm
                    key={w.id}
                    draft={draft}
                    setDraft={setDraft}
                    mentorName={profile.name}
                    taken={seats.taken}
                    onSave={save}
                    onCancel={cancel}
                    busy={busy}
                  />
                ) : (
                  <div key={w.id} className="tile tile--flat admin-row">
                    <div className="admin-row__body">
                      <div className="admin-row__title">
                        <b>{w.title}</b>
                        {w.startsAt.toDate().getTime() < now && (
                          <span className="chip chip--mute">past</span>
                        )}
                        {w.open && <span className="chip chip--why">open</span>}
                        {w.levelGate > 0 && (
                          <span className="chip chip--on">L{w.levelGate}+</span>
                        )}
                        {seats.full && <span className="chip chip--mute">full</span>}
                        {w.recordingUrl && <span className="chip">rec</span>}
                      </div>
                      <span className="admin-row__meta">
                        {fmtWhen(w)} · {w.durationMins}m ·{" "}
                        {seats.capacity === null
                          ? `${seats.taken} in`
                          : `${seats.taken}/${seats.capacity} seats`}
                        {w.milestoneId > 0 && ` · M${w.milestoneId}`}
                      </span>
                    </div>
                    <div className="row-actions" style={{ marginTop: 0 }}>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => startEdit(w)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => remove(w.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === "squads" && (
        <section className="screen__block">
          <div className="screen__label">
            <span className="micro">Needs a mentor</span>
            {mine.length > 0 && <span className="micro">{mine.length} yours</span>}
          </div>
          {unassigned === null ? (
            <p className="empty">Loading…</p>
          ) : unassigned.length === 0 ? (
            <p className="empty">Every squad has a mentor.</p>
          ) : (
            <div className="admin-list">
              {unassigned.map((c) => {
                const members = c.memberUids?.length ?? 0;
                const waited = c.createdAt
                  ? Math.floor((now - c.createdAt.toMillis()) / 86400000)
                  : null;
                return (
                  <div key={c.id} className="tile tile--flat admin-row">
                    <div className="admin-row__body">
                      <div className="admin-row__title">
                        <b>{c.name}</b>
                        <span className="chip">{members}/8</span>
                        {members >= COHORT_MIN_TO_ACTIVATE && (
                          <span className="chip chip--on">ready</span>
                        )}
                        {waited !== null && waited >= 7 && (
                          <span className="chip chip--mute">{waited}d waiting</span>
                        )}
                      </div>
                      <span className="admin-row__meta">{c.mission}</span>
                      <span className="admin-row__meta">
                        {(c.tags ?? []).join(" · ") || "no tags"} · {c.meetingSlot}
                      </span>
                    </div>
                    <div className="row-actions" style={{ marginTop: 0 }}>
                      <button
                        className="btn btn--verify btn--sm"
                        disabled={adopting === c.id}
                        onClick={() => adopt(c)}
                      >
                        {adopting === c.id ? "…" : "Take it on"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === "checkins" && (
        <section className="screen__block">
          <div className="screen__label">
            <span className="micro">Your squads want time</span>
          </div>
          {mine.length === 0 ? (
            <p className="empty">No squads yet — take one on.</p>
          ) : requests.length === 0 ? (
            <p className="empty">Queue clear.</p>
          ) : (
            <div className="admin-list">
              {requests.map(({ cohort: c, checkIn: k }) => (
                <div key={k.id} className="tile tile--flat">
                  <div className="admin-row" style={{ padding: 0 }}>
                    <div className="admin-row__body">
                      <div className="admin-row__title">
                        <b>{c.name}</b>
                        <span className="chip">{k.requestedByName}</span>
                      </div>
                      {k.note && <span className="admin-row__meta">{k.note}</span>}
                    </div>
                    {confirming !== k.id && (
                      <div className="row-actions" style={{ marginTop: 0 }}>
                        <button
                          className="btn btn--primary btn--sm"
                          onClick={() => startConfirm(k)}
                        >
                          Set time
                        </button>
                      </div>
                    )}
                  </div>

                  {confirming === k.id && (
                    <>
                      <div className="field-row">
                        <div className="field">
                          <label>Starts</label>
                          <input
                            type="datetime-local"
                            value={whenDraft}
                            onChange={(e) => setWhenDraft(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label>Minutes</label>
                          <input
                            type="number"
                            min={1}
                            max={600}
                            value={minsDraft}
                            onChange={(e) => setMinsDraft(Number(e.target.value))}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <label>Meet link</label>
                        <input
                          value={linkDraft}
                          onChange={(e) => setLinkDraft(e.target.value)}
                          placeholder="https://meet.google.com/…"
                          maxLength={500}
                        />
                      </div>
                      <div className="row-actions">
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn btn--verify btn--sm"
                          disabled={busy || !whenDraft}
                          onClick={() => sendConfirm(c.id, k.id)}
                        >
                          {busy ? "…" : "Confirm"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "members" && (
        <section className="screen__block">
          <div className="screen__label">
            <span className="micro">Awaiting parental consent</span>
          </div>
          {pending === null ? (
            <p className="empty">Loading…</p>
          ) : sortedPending.length === 0 ? (
            <p className="empty">Queue clear.</p>
          ) : (
            <div className="admin-list">
              {sortedPending.map((p) => (
                <div key={p.uid} className="tile tile--flat admin-row">
                  <div className="admin-row__body">
                    <div className="admin-row__title">
                      <b>{p.name}</b>
                      <span className="chip">{p.ageBand}</span>
                    </div>
                    <span className="admin-row__meta">
                      {p.country} · {p.headline || p.building}
                    </span>
                    <span className="admin-row__meta">
                      {resendState[p.uid]
                        ? resendState[p.uid]
                        : p.consentEmailSentAt
                          ? `Email sent ${fmtSent(p.consentEmailSentAt)}`
                          : "No consent email sent yet"}
                    </span>
                  </div>
                  <div className="row-actions" style={{ marginTop: 0 }}>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => resendConsent(p.uid)}
                    >
                      Resend
                    </button>
                    <button
                      className="btn btn--verify btn--sm"
                      onClick={() => grantConsent(p.uid).catch(() => {})}
                    >
                      Grant
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
