"use client";

/**
 * The mentor-shaped onboarding: identity → edge → proof, in 3 short steps.
 *
 * Extracted from /mentor/join so the two ways to become a mentor run the
 * IDENTICAL flow: the invite-code path (`/mentor/join?code=…`) and the
 * founding-batch allowlist path (`/login/verify`, magic link). Deliberately
 * different from operator onboarding — no DOB and no parent email; mentors
 * attest 18+, get `ageBand: "18+"` and consent `granted`, and never get a
 * privateProfiles doc.
 *
 * The component owns the form and its validation; the caller owns what
 * "submit" means (redeem an invite vs. mint from the allowlist) and returns
 * an error string to display, or null on success.
 */
import { useMemo, useState } from "react";
import { localDay } from "../lib/gamify";
import { DOMAINS, SKILLS } from "../lib/types";
import { COUNTRIES } from "../lib/countries";
import { Bar } from "./ui";
import { TagField, MAX_EXPERTISE, MAX_COACH } from "./TagField";
import type { MentorSignupInput, VentureStage } from "../lib/types";

const STAGES: { id: VentureStage; label: string }[] = [
  { id: "idea", label: "Just an idea" },
  { id: "building", label: "Building it" },
  { id: "launched", label: "Launched" },
  { id: "revenue", label: "Has revenue" },
];

// Presets are a starting point, not a ceiling — TagField carries the caps.
const EXPERTISE_PRESETS = DOMAINS.filter((d) => d !== "Other");

/** Split a provider display name into first / rest, for prefill. */
function splitName(full: string | null | undefined): [string, string] {
  if (!full) return ["", ""];
  const [first, ...rest] = full.split(" ");
  return [first ?? "", rest.join(" ")];
}

export interface MentorOnboardingProps {
  /** Provider display name to prefill from, when there is one. Read once at
   *  mount — callers render this only after auth has resolved. */
  prefillName?: string | null;
  /** Label for the final button, e.g. "Join as mentor". */
  submitLabel?: string;
  /** Persist the finished profile. Return an error message to show, or null
   *  on success (the caller navigates). */
  onSubmit: (input: MentorSignupInput) => Promise<string | null>;
}

export function MentorOnboarding({
  prefillName,
  submitLabel = "Join as mentor",
  onSubmit,
}: MentorOnboardingProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [firstName, setFirstName] = useState(() => splitName(prefillName)[0]);
  const [lastName, setLastName] = useState(() => splitName(prefillName)[1]);
  const [country, setCountry] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [isAdult, setIsAdult] = useState(false);
  const [headline, setHeadline] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [proofUrl, setProofUrl] = useState("");
  const [proofNote, setProofNote] = useState("");
  const [building, setBuilding] = useState("");
  const [stage, setStage] = useState<VentureStage | null>(null);
  const [bio, setBio] = useState("");
  const [github, setGithub] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [site, setSite] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Every IANA zone the browser knows, with the detected one guaranteed in.
  const timezones = useMemo(() => {
    const all =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [];
    return all.includes(timezone) ? all : [timezone, ...all];
  }, [timezone]);

  function nextFromIdentity() {
    if (!firstName.trim() || !lastName.trim() || !country.trim()) {
      setError("Name and country are required.");
      return;
    }
    if (!isAdult) {
      setError("Mentors must be 18 or older.");
      return;
    }
    setError("");
    setStep(2);
  }

  function nextFromEdge() {
    if (!headline.trim()) {
      setError("Add a headline — it's how operators know who's verifying them.");
      return;
    }
    if (domains.length === 0 || skills.length === 0) {
      setError("Pick at least one expertise area and one thing you can coach.");
      return;
    }
    setError("");
    setStep(3);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const message = await onSubmit({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      country: country.trim(),
      timezone,
      headline: headline.trim(),
      building: building.trim(),
      stage: building.trim() && stage ? stage : "idea",
      domains,
      skills,
      proofUrl: proofUrl.trim(),
      proofNote: proofNote.trim(),
      bio: bio.trim(),
      links: {
        github: github.trim(),
        linkedin: linkedin.trim(),
        site: site.trim(),
      },
      localDay: localDay(),
    });
    // On success the caller navigates away; only surface a failure.
    if (message) {
      setError(message);
      setBusy(false);
    }
  }

  const hasBuilding = building.trim().length > 0;

  return (
    <section className="ob">
      <div className="ob__bar">
        <span className="micro">{step}/3</span>
        <Bar value={step / 3} ember xs />
      </div>

      <h1 className="h1">
        {step === 1
          ? "Need some quick info first…"
          : step === 2
          ? "What's your edge?"
          : "Proof, then polish."}
      </h1>
      <p className="ob__sub">
        {step === 1
          ? "Operators only ever see “First L.” — the credibility comes next."
          : step === 2
          ? "Your headline and expertise are how operators know who's verifying them."
          : "All optional — but proof is the highest-signal thing on your profile."}
      </p>

      {step === 1 && (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="mo-first">First name</label>
              <input
                id="mo-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Grace"
                maxLength={60}
              />
            </div>
            <div className="field">
              <label htmlFor="mo-last">Last name</label>
              <input
                id="mo-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Hopper"
                maxLength={60}
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="mo-country">Country</label>
              <select
                id="mo-country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              >
                <option value="" disabled>
                  Pick one
                </option>
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mo-tz">Timezone</label>
              <select
                id="mo-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <small className="field__hint">
            Schedules your office hours. Nothing more precise.
          </small>

          <label className="admin-check">
            <input
              type="checkbox"
              checked={isAdult}
              onChange={(e) => setIsAdult(e.target.checked)}
            />
            <span>I&apos;m 18 or older</span>
          </label>

          {error && <p className="form-err">{error}</p>}

          <div className="row-actions">
            <button className="btn btn--primary" onClick={nextFromIdentity}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="field">
            <label htmlFor="mo-headline">Headline</label>
            <input
              id="mo-headline"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Founder of Loop (acq. 2024) · ex-Shopify growth"
              maxLength={90}
            />
          </div>

          <TagField
            label="Expertise"
            presets={EXPERTISE_PRESETS}
            value={domains}
            max={MAX_EXPERTISE}
            onChange={setDomains}
          />

          <TagField
            label="Can coach"
            presets={SKILLS}
            value={skills}
            max={MAX_COACH}
            onChange={setSkills}
          />

          {error && <p className="form-err">{error}</p>}

          <div className="row-actions">
            <button className="btn btn--ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn btn--primary" onClick={nextFromEdge}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="field">
            <label>Proof of work · optional</label>
            <input
              value={proofUrl}
              onChange={(e) => setProofUrl(e.target.value)}
              placeholder="Link the best thing you've shipped"
              maxLength={300}
            />
            <input
              value={proofNote}
              onChange={(e) => setProofNote(e.target.value)}
              placeholder="Why it matters — one line"
              maxLength={200}
            />
          </div>

          <div className="field">
            <label htmlFor="mo-building">Building now · optional</label>
            <textarea
              id="mo-building"
              value={building}
              onChange={(e) => setBuilding(e.target.value)}
              placeholder="Mentors build too — what's on your bench?"
              maxLength={300}
            />
          </div>

          {hasBuilding && (
            <div className="field">
              <label>Where&apos;s it at?</label>
              <div className="chip-row">
                {STAGES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`pick ${stage === s.id ? "sel" : ""}`}
                    onClick={() => setStage(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="mo-bio">Bio · optional</label>
            <textarea
              id="mo-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Personality, not résumé"
              maxLength={300}
            />
          </div>

          <div className="field">
            <label>Links · optional</label>
            <input
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="LinkedIn"
              maxLength={200}
            />
            <input
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder="GitHub"
              maxLength={200}
            />
            <input
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="Personal site"
              maxLength={200}
            />
          </div>

          {error && <p className="form-err">{error}</p>}

          <div className="row-actions">
            <button className="btn btn--ghost" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              className="btn btn--primary"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? "…" : submitLabel}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
