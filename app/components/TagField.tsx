"use client";

import { useState } from "react";
import { normalizeFocusTag, MAX_TAG_LEN } from "../lib/types";

/** Chip picker with the squad-style "add your own" escape hatch: preset chips,
 *  removable custom chips, and a normalized free-text input behind a "+".
 *  Shared by mentor signup and the mentor profile so the two never drift. */
export function TagField({
  label,
  presets,
  value,
  max,
  onChange,
}: {
  label: string;
  presets: readonly string[];
  value: string[];
  max: number;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const atCap = value.length >= max;
  const custom = value.filter((t) => !presets.includes(t));

  function togglePreset(t: string) {
    onChange(
      value.includes(t)
        ? value.filter((x) => x !== t)
        : atCap
          ? value
          : [...value, t]
    );
  }

  // Normalize, fold a typed preset name onto its chip, dedupe
  // case-insensitively, and silently no-op at the cap or on junk input.
  function addCustom() {
    const t = normalizeFocusTag(draft);
    setDraft("");
    if (!t || atCap) return;
    const folded = presets.find((p) => p.toLowerCase() === t.toLowerCase()) ?? t;
    if (value.some((x) => x.toLowerCase() === folded.toLowerCase())) return;
    onChange([...value, folded]);
  }

  return (
    <div className="field">
      <label>{label}</label>
      <div className="chip-row">
        {presets.map((t) => (
          <button
            key={t}
            type="button"
            className={`pick ${value.includes(t) ? "sel" : ""}`}
            disabled={!value.includes(t) && atCap}
            onClick={() => togglePreset(t)}
          >
            {t}
          </button>
        ))}
        {custom.map((t) => (
          <button
            key={t}
            type="button"
            className="pick sel"
            onClick={() => onChange(value.filter((x) => x !== t))}
            title="Remove"
          >
            {t} ×
          </button>
        ))}
      </div>
      <div className="tag-add">
        <input
          aria-label={`Add your own — ${label}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Add your own…"
          maxLength={MAX_TAG_LEN}
          disabled={atCap}
        />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={addCustom}
          disabled={atCap || !draft.trim()}
          aria-label={`Add — ${label}`}
        >
          +
        </button>
      </div>
      <small className="field__hint">
        {atCap
          ? `That's the max — ${max}.`
          : `Pick a few or add your own. ${value.length}/${max}.`}
      </small>
    </div>
  );
}

/** Mentors are niche experts: presets are a starting point, not a ceiling —
 *  custom tags replace the catch-all "Other". Caps mirror firestore.rules
 *  (domains ≤ 9, skills ≤ 7 — bounded there by validStringList). */
export const MAX_EXPERTISE = 9;
export const MAX_COACH = 7;
