"use client";

/* The squad dossier a mentor reads before deciding to take a squad on.
   Everything the adoption feed can't fit: the full mission, the ritual slot
   (with the caveat that it moves), the focus, and every member's card —
   each one openable in full. Public Profile fields only, never private ones. */

import { useEffect, useState } from "react";
import type { Cohort, Profile } from "../lib/types";
import { COHORT_MIN_TO_ACTIVATE, COHORT_MAX_MEMBERS } from "../lib/types";
import { Avatar } from "./ui";
import { ProfileModal } from "./ProfileModal";
import { fetchProfileOnce } from "./SquadRoster";

/** Small hoverable "why does this say that" marker. `title` is the whole
 *  mechanism — one line of plain language, no popover machinery. */
function Info({ label }: { label: string }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label={label} title={label}>
      i
    </span>
  );
}

export function SquadModal({
  cohort,
  daysWaiting,
  onAdopt,
  adopting,
  onClose,
}: {
  cohort: Cohort;
  /** How long it's been sitting in the feed, if known. */
  daysWaiting: number | null;
  onAdopt?: () => void;
  adopting?: boolean;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Record<string, Profile | null>>({});
  const [openUid, setOpenUid] = useState<string | null>(null);

  const uids = cohort.memberUids ?? [];

  useEffect(() => {
    let stale = false;
    Promise.all(
      uids.map(async (uid) => [uid, await fetchProfileOnce(uid)] as const)
    ).then((pairs) => {
      if (stale) return;
      setMembers(Object.fromEntries(pairs));
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uids.join(",")]);

  const count = uids.length;
  const ready = count >= COHORT_MIN_TO_ACTIVATE;
  const shortBy = COHORT_MIN_TO_ACTIVATE - count;
  const viewing = openUid ? members[openUid] : null;

  return (
    <>
      <div className="modal open" role="dialog" aria-modal="true">
        <div className="modal__scrim" onClick={onClose} />
        <div className="modal__card modal__card--wide">
          <button className="modal__close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
            {cohort.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="sq__icon sq__icon--lg" src={cohort.icon} alt="" />
            )}
            <div>
              <h3 style={{ marginBottom: 0 }}>{cohort.name}</h3>
              <span className="micro">
                {count} of {COHORT_MAX_MEMBERS} members · started by {cohort.founderName}
                {daysWaiting !== null && ` · waiting ${daysWaiting}d for a mentor`}
              </span>
            </div>
          </div>

          <p style={{ fontWeight: 700, marginBottom: 16 }}>{cohort.mission}</p>

          <div className="field">
            <label>
              Weekly ritual <Info label="The slot the founder committed to when they started the squad. It is a starting point, not a fixed commitment — squads very often move it once a mentor joins and everyone's timezones are on the table. Agree the real time with them at your first check-in." />
            </label>
            <p style={{ fontSize: 15 }}>
              {cohort.meetingSlot || "No slot committed yet"}
              <span className="muted"> · founder&apos;s timezone {cohort.timezone}</span>
            </p>
            <small className="field__hint">
              Proposed by the squad — expect to renegotiate it with them.
            </small>
          </div>

          {(cohort.tags ?? []).length > 0 && (
            <div className="field">
              <label>Building in</label>
              <div className="chip-row">
                {(cohort.tags ?? []).map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(cohort.lookingFor ?? []).length > 0 && (
            <div className="field">
              <label>Still recruiting</label>
              <div className="chip-row">
                {(cohort.lookingFor ?? []).map((s) => (
                  <span key={s} className="chip chip--want">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {cohort.link && (
            <div className="field">
              <label>Their page</label>
              <p style={{ fontSize: 15 }}>
                <a href={cohort.link} target="_blank" rel="noopener noreferrer" className="link-btn">
                  {cohort.link}
                </a>
              </p>
            </div>
          )}

          <div className="field">
            <label>Who&apos;s in it</label>
            <div className="stack" style={{ gap: 0 }}>
              {uids.map((uid) => {
                const p = members[uid];
                const name = cohort.memberNames?.[uid] ?? "?";
                return (
                  <button
                    key={uid}
                    type="button"
                    className="mem"
                    onClick={() => p && setOpenUid(uid)}
                    disabled={!p}
                  >
                    <Avatar name={name} />
                    <span className="mem__body">
                      <span className="mem__name">
                        {name}
                        {uid === cohort.founderUid && (
                          <span className="chip chip--why">founder</span>
                        )}
                      </span>
                      {p === undefined ? (
                        <span className="mem__line muted">Loading…</span>
                      ) : p === null ? (
                        <span className="mem__line muted">Profile unavailable</span>
                      ) : (
                        <>
                          {p.headline && <span className="mem__line">{p.headline}</span>}
                          {p.building && (
                            <span className="mem__line muted">{p.building}</span>
                          )}
                          <span className="mem__line micro">
                            {p.ageBand} · {p.country} · {p.timezone}
                          </span>
                        </>
                      )}
                    </span>
                    {p && <span className="mem__more">Full profile →</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {onAdopt && (
            <>
              <p className="micro" style={{ marginTop: 18 }}>
                {ready
                  ? "This squad has the members it needs. Taking it on starts their 8-week season immediately, and you become the one who verifies milestones 4–7 and takes their check-in requests."
                  : `They still need ${shortBy} more member${shortBy === 1 ? "" : "s"} before the season can start. You can take them on now — you'll be their mentor, and the season begins the moment they hit ${COHORT_MIN_TO_ACTIVATE}.`}
              </p>
              <div className="modal__actions">
                <button className="btn btn--ghost modal__back" onClick={onClose}>
                  Not now
                </button>
                <button
                  className="btn btn--verify modal__next"
                  disabled={adopting}
                  onClick={onAdopt}
                >
                  {adopting ? "…" : "Take it on"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {viewing && <ProfileModal profile={viewing} onClose={() => setOpenUid(null)} />}
    </>
  );
}
