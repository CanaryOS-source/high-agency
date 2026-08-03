"use client";

/* Squad roster — the compact avatar stack for evaluation surfaces (the
   open-squads list), with the reading built in: hover or focus a disc for
   a one-line peek (headline + level); click for the full profile overlay.
   Past 4 members the stack scrolls horizontally so the tile stays compact.
   Profiles load lazily on first hover and are cached for the session. The
   plain `.avstack` stays the non-interactive "who's here" everywhere else
   — see design-system.md → Identity. */

import { useState } from "react";
import type { Profile } from "../lib/types";
import { getProfile } from "../lib/db";
import { levelOf } from "../lib/gamify";
import { Avatar } from "./ui";
import { ProfileModal } from "./ProfileModal";

/** Session-level cache — each member profile is fetched at most once no
 *  matter how many squad tiles they appear in. */
const profileCache = new Map<string, Promise<Profile | null>>();
export function fetchProfileOnce(uid: string): Promise<Profile | null> {
  return fetchOnce(uid);
}
function fetchOnce(uid: string): Promise<Profile | null> {
  let p = profileCache.get(uid);
  if (!p) {
    p = getProfile(uid).catch(() => null);
    profileCache.set(uid, p);
  }
  return p;
}

export function SquadRoster({
  uids,
  names,
}: {
  uids: string[];
  names: Record<string, string>;
}) {
  // undefined = not requested yet, null = fetch failed / no profile
  const [profiles, setProfiles] = useState<Record<string, Profile | null>>({});
  const [openUid, setOpenUid] = useState<string | null>(null);
  // Peek card anchor — fixed viewport coords so it escapes the scroll clip.
  const [peek, setPeek] = useState<{ uid: string; x: number; y: number } | null>(null);

  function warm(uid: string) {
    if (profiles[uid] !== undefined) return;
    fetchOnce(uid).then((p) =>
      setProfiles((prev) => (prev[uid] !== undefined ? prev : { ...prev, [uid]: p }))
    );
  }

  function showPeek(uid: string, el: HTMLElement) {
    warm(uid);
    const r = el.getBoundingClientRect();
    setPeek({ uid, x: r.left + r.width / 2, y: r.top - 8 });
  }

  const viewing = openUid ? profiles[openUid] : null;
  const peeked = peek ? profiles[peek.uid] : undefined;

  return (
    <>
      <span
        className={`avroster ${uids.length > 4 ? "avroster--scroll" : ""}`}
        onMouseLeave={() => setPeek(null)}
      >
        {uids.map((uid) => {
          const name = names[uid] ?? "?";
          return (
            <button
              key={uid}
              type="button"
              className="avroster__a"
              aria-label={`${name} — view profile`}
              aria-haspopup="dialog"
              onMouseEnter={(e) => showPeek(uid, e.currentTarget)}
              onFocus={(e) => showPeek(uid, e.currentTarget)}
              onBlur={() => setPeek(null)}
              onClick={() => {
                warm(uid);
                setOpenUid(uid);
              }}
            >
              <Avatar name={name} />
            </button>
          );
        })}
      </span>
      {peek && (
        <span className="peek" style={{ left: peek.x, top: peek.y }} aria-hidden="true">
          <span className="peek__name">
            {names[peek.uid] ?? "?"}
            {peeked && <span className="peek__lvl">L{levelOf(peeked.xp).level}</span>}
          </span>
          <span className="peek__line">
            {peeked === undefined
              ? "…"
              : peeked === null
                ? "Profile unavailable"
                : peeked.headline || peeked.building || `${peeked.stage} · ${peeked.country}`}
          </span>
          <span className="peek__hint">Full profile →</span>
        </span>
      )}
      {viewing && <ProfileModal profile={viewing} onClose={() => setOpenUid(null)} />}
    </>
  );
}
