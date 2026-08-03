"use client";

/* Operator OS v2 primitives — game glyphs, HUD, avatars, bars.
   All icons are inline SVG, stroke 2.2, currentColor (see design-system.md). */

import type { Profile } from "../lib/types";
import { levelOf, levelProgress, localDay } from "../lib/gamify";

type IconProps = { size?: number; filled?: boolean };

/** Blobby streak flame — always solid, with an inner-tongue cutout.
 *  Color comes from currentColor (ember in the HUD via `.flame`). */
const FLAME_OUTER =
  "M12.4 2.2C13.5 4.8 15.9 6.9 17.4 9.2C18.3 10.6 18.8 12.1 18.8 13.8C18.8 18 15.7 21.5 12 21.5C8.3 21.5 5.2 18 5.2 13.8C5.2 11 6.8 8.9 8.5 6.9C9.9 5.3 11.7 4.6 12.4 2.2Z";
const FLAME_INNER =
  "M11.6 12C13.2 13.3 14.3 14.7 14.3 16.3C14.3 18 13 19.2 11.4 19.2C9.8 19.2 8.6 18 8.6 16.4C8.6 14.6 10 13.3 11.6 12Z";

export function FlameIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={FLAME_OUTER + FLAME_INNER} />
    </svg>
  );
}

export function BoltIcon({ size = 16, filled = true }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function LockIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="3" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

export function HomeIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5" />
    </svg>
  );
}

export function SquadIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 010 6.8M18.5 14.4c2 .8 3 2.6 3 5.6" />
    </svg>
  );
}

export function ZapIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

export function UserIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </svg>
  );
}

export function CalendarIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function WrenchIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4.5 4.5 0 006 6L9.6 23.4a2.1 2.1 0 01-3-3L17.7 9.3a4.5 4.5 0 00-6-6l3 3-1.4 1.4-3-3z" transform="scale(0.9) translate(1.5 0)" />
    </svg>
  );
}

/** Level ring — SVG progress ring with the level number inside. */
export function LevelRing({ xp, size = 40 }: { xp: number; size?: number }) {
  const lvl = levelOf(xp);
  const p = levelProgress(xp);
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="lvlring" title={`Level ${lvl.level} · ${lvl.name} · ${xp} XP`}>
      <svg width={size} height={size} aria-hidden="true">
        <circle className="lvlring__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="5" />
        <circle
          className="lvlring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth="5"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
        />
      </svg>
      <span className="lvlring__n">L{lvl.level}</span>
    </span>
  );
}

/** The always-on game state: flame · level ring (XP lives inside the ring —
 *  it only exists to fill it). Never restated in copy.
 *  `col` stacks the stats vertically for the 96px desktop rail. */
export function Hud({ profile, col = false }: { profile: Profile; col?: boolean }) {
  const alive = profile.lastActiveDay === localDay();
  return (
    <div className={`hud ${col ? "hud--col" : ""}`}>
      <span className={`hud__stat ${alive ? "hud__stat--fire" : ""}`} title={`${profile.streak}-day streak`}>
        <span className="flame">
          <FlameIcon />
        </span>
        {profile.streak}
      </span>
      <LevelRing xp={profile.xp} />
    </div>
  );
}

export function Avatar({ name, size }: { name: string; size?: "sm" | "lg" }) {
  return (
    <span className={`av ${size ? `av--${size}` : ""}`} aria-hidden="true">
      {(name || "?").slice(0, 1)}
    </span>
  );
}

/** Overlapping avatar discs — the default way to show "who's here". */
export function AvStack({ names, max = 5 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="avstack" title={names.join(", ")}>
      {shown.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} />
      ))}
      {extra > 0 && <span className="avstack__more">+{extra}</span>}
    </span>
  );
}

export function Bar({
  value,
  ember = false,
  xs = false,
}: {
  /** 0..1 */
  value: number;
  ember?: boolean;
  xs?: boolean;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      className={`bar ${ember ? "bar--ember" : ""} ${xs ? "bar--xs" : ""}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}
