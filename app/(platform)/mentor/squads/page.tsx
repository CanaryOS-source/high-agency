"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useMentorGate,
  useMentoredSquads,
  useUnassignedSquads,
  useConsentQueue,
} from "../../../components/mentorData";
import {
  adoptCohort,
  confirmCheckIn,
  grantConsent,
  requestConsentEmail,
} from "../../../lib/db";
import { COHORT_MIN_TO_ACTIVATE, CHECKIN_DEFAULT_MINS } from "../../../lib/types";
import type { Cohort, CheckIn } from "../../../lib/types";
import { AvStack } from "../../../components/ui";
import { SquadModal } from "../../../components/SquadModal";
import { toLocalInput } from "../../../components/WorkshopForm";

function daysWaiting(c: Cohort, now: number): number | null {
  return c.createdAt ? Math.floor((now - c.createdAt.toMillis()) / 86400000) : null;
}

function fmtSent(ts: { toDate: () => Date }): string {
  const d = ts.toDate();
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

export default function MentorSquadsPage() {
  const { user, profile } = useMentorGate();
  const uid = user?.uid ?? null;

  const { mine, loading, requests, verifyQueue, upcomingCheckIns } =
    useMentoredSquads(uid);
  const { squads: unassigned, truncated: moreUnassigned } = useUnassignedSquads(!!uid);
  const { pending, truncated: moreConsent } = useConsentQueue(!!uid);

  const [now] = useState(() => Date.now());
  const [adopting, setAdopting] = useState<string | null>(null);
  const [adoptErr, setAdoptErr] = useState("");
  const [busy, setBusy] = useState(false);
  // The squad dossier a mentor opens before deciding.
  const [viewing, setViewing] = useState<Cohort | null>(null);

  // Confirm-a-check-in editor: which request, and the time/link being set.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [whenDraft, setWhenDraft] = useState("");
  const [minsDraft, setMinsDraft] = useState(CHECKIN_DEFAULT_MINS);
  const [linkDraft, setLinkDraft] = useState("");

  // Per-operator resend feedback in the consent queue, keyed by uid.
  const [resendState, setResendState] = useState<Record<string, string>>({});

  async function adopt(c: Cohort) {
    if (!profile) return;
    setAdopting(c.id);
    setAdoptErr("");
    try {
      await adoptCohort(c, profile);
    } catch {
      // Usually someone else got there first — the feed is live, so the row
      // disappears on its own. Say something either way: a button that does
      // nothing and explains nothing is worse than the failure.
      setAdoptErr(
        `Couldn't take on ${c.name}. Another mentor may have claimed it — refresh to check.`
      );
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

  async function resendConsent(target: string) {
    setResendState((s) => ({ ...s, [target]: "Sending…" }));
    try {
      const res = await requestConsentEmail(target);
      setResendState((s) => ({
        ...s,
        [target]: res.ok
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
      setResendState((s) => ({ ...s, [target]: "Couldn't send — try again" }));
    }
  }

  if (!user || !profile) return null;

  /** Work waiting on this mentor for a given squad — the reason to open it. */
  const pendingFor = (cohortId: string) =>
    verifyQueue.filter((v) => v.cohort.id === cohortId).length;
  const nextCheckIn = (cohortId: string) =>
    upcomingCheckIns.find((u) => u.cohort.id === cohortId) ?? null;

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="h1">Squads</h1>
      </header>

      {/* ---- Proof waiting on me ---- */}
      {verifyQueue.length > 0 && (
        <section className="screen__block">
          <div className="screen__label">
            <span className="micro">Proof to verify</span>
          </div>
          <div className="admin-list">
            {verifyQueue.map(({ cohort: c, submission: s, milestone: m }) => (
              <div key={`${c.id}-${s.milestoneId}_${s.uid}`} className="tile tile--flat admin-row">
                <div className="admin-row__body">
                  <div className="admin-row__title">
                    <b>
                      {s.name} — {m.name}
                    </b>
                  </div>
                  <span className="admin-row__meta">
                    {c.name} · milestone {m.id}
                  </span>
                  {s.note && <span className="admin-row__meta">{s.note}</span>}
                </div>
                <div className="row-actions" style={{ marginTop: 0 }}>
                  <a
                    className="btn btn--ghost btn--sm"
                    href={s.evidenceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Proof
                  </a>
                  <Link className="btn btn--verify btn--sm" href={`/cohorts/${c.id}`}>
                    Review
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Check-in requests ---- */}
      {requests.length > 0 && (
        <section className="screen__block">
          <div className="screen__label">
            <span className="micro">Asked for time</span>
          </div>
          <div className="admin-list">
            {requests.map(({ cohort: c, checkIn: k }) => (
              <div key={k.id} className="tile tile--flat">
                <div className="admin-row" style={{ padding: 0 }}>
                  <div className="admin-row__body">
                    <div className="admin-row__title">
                      <b>{c.name}</b>
                    </div>
                    <span className="admin-row__meta">asked by {k.requestedByName}</span>
                    {k.note && <span className="admin-row__meta">{k.note}</span>}
                  </div>
                  {confirming !== k.id && (
                    <div className="row-actions" style={{ marginTop: 0 }}>
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => startConfirm(k)}
                      >
                        Set a time
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
        </section>
      )}

      {/* ---- Squads I look after ---- */}
      <section className="screen__block">
        <div className="screen__label">
          <span className="micro">Yours</span>
        </div>
        {loading ? (
          <p className="empty">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="empty">
            No squads yet — take one on from the feed below.
          </p>
        ) : (
          <div className="squads">
            {mine.map((c) => {
              const waiting = pendingFor(c.id);
              const next = nextCheckIn(c.id);
              return (
                <Link
                  key={c.id}
                  href={`/cohorts/${c.id}`}
                  className="tile tile--tap sq"
                >
                  <div className="sq__top">
                    <span className="sq__id">
                      {c.icon && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="sq__icon" src={c.icon} alt="" />
                      )}
                      <span className="sq__name">{c.name}</span>
                    </span>
                    <AvStack
                      names={c.memberUids.map((u) => c.memberNames[u] ?? "?")}
                    />
                  </div>
                  <p className="sq__mission">{c.mission}</p>
                  <div className="sq__foot">
                    <span className="sq__slot">
                      {c.meetingSlot || "no slot"}
                      {c.state !== "active" && ` · ${c.state}`}
                    </span>
                    <span className="sq__status">
                      {waiting > 0
                        ? `${waiting} to verify`
                        : next
                          ? `check-in ${next.checkIn
                              .startsAt!.toDate()
                              .toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}`
                          : "nothing pending"}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- The adoption feed ---- */}
      <section className="screen__block">
        <div className="screen__label">
          <span className="micro">Needs a mentor</span>
          {moreUnassigned && <span className="micro">newest {unassigned?.length}</span>}
        </div>
        {adoptErr && <p className="form-err">{adoptErr}</p>}
        {unassigned === null ? (
          <p className="empty">Loading…</p>
        ) : unassigned.length === 0 ? (
          <p className="empty">Every squad has a mentor.</p>
        ) : (
          <div className="admin-list">
            {unassigned.map((c) => {
              const members = c.memberUids?.length ?? 0;
              const waited = daysWaiting(c, now);
              const ready = members >= COHORT_MIN_TO_ACTIVATE;
              const short = COHORT_MIN_TO_ACTIVATE - members;
              return (
                <div key={c.id} className="tile tile--flat admin-row admin-row--tap">
                  <button
                    type="button"
                    className="admin-row__body admin-row__open"
                    onClick={() => setViewing(c)}
                    aria-label={`${c.name} — see the full squad`}
                  >
                    <div className="admin-row__title">
                      <b>{c.name}</b>
                    </div>
                    <span className="admin-row__meta">{c.mission}</span>
                    <span className="admin-row__meta">
                      {members} member{members === 1 ? "" : "s"} · {c.meetingSlot}
                      {waited !== null && waited >= 7 && ` · waiting ${waited}d`}
                      {(c.tags ?? []).length > 0 && ` · ${(c.tags ?? []).join(", ")}`}
                    </span>
                    {/* Plain language beats a chip nobody can decode: say what
                        happens when you press the button. */}
                    <span
                      className={`admin-row__meta ${ready ? "signal" : ""}`}
                      style={{ fontWeight: 600 }}
                    >
                      {ready
                        ? "Ready — taking it on starts their season"
                        : `Needs ${short} more member${short === 1 ? "" : "s"} before the season can start`}
                    </span>
                  </button>
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

      {viewing && (
        <SquadModal
          cohort={viewing}
          daysWaiting={daysWaiting(viewing, now)}
          adopting={adopting === viewing.id}
          onAdopt={() => {
            const c = viewing;
            setViewing(null);
            adopt(c);
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {/* ---- Parental consent: an ops queue, not a daily surface ---- */}
      <details className="more screen__block">
        <summary className="more__toggle">
          Parental consent
          <span className="more__hint">
            {pending === null
              ? "…"
              : pending.length === 0
                ? "queue clear"
                : `${pending.length}${moreConsent ? "+" : ""} waiting`}
          </span>
        </summary>
        <div className="more__body">
          {pending === null ? (
            <p className="empty">Loading…</p>
          ) : pending.length === 0 ? (
            <p className="empty">Nobody is waiting on a parent.</p>
          ) : (
            <>
              {moreConsent && (
                <p className="micro" style={{ marginBottom: 12 }}>
                  Showing the first {pending.length}. Clear these to load more.
                </p>
              )}
              <div className="admin-list">
                {pending.map((p) => (
                  <div key={p.uid} className="tile tile--flat admin-row">
                    <div className="admin-row__body">
                      <div className="admin-row__title">
                        <b>{p.name}</b>
                      </div>
                      <span className="admin-row__meta">
                        {p.ageBand} · {p.country}
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
            </>
          )}
        </div>
      </details>
    </div>
  );
}
