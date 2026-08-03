"use client";

/**
 * Mentor signup — deliberately unlinked from any nav. Mentors arrive only via
 * an invite URL (`/mentor/join?code=…`) minted by scripts/mentor-invite.js and
 * shared 1:1 by staff. Flow: validate the single-use code → sign in / create
 * an account → a 3-step mentor-shaped onboarding (identity + expertise +
 * proof; no DOB, no parent email — mentors attest 18+) → the server redeems
 * the code and mints `role: "mentor"` (app/api/mentor/redeem — clients can't
 * write the role). An invitee who already has an operator account gets
 * promoted in place.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "../../../lib/firebase";
import { useAuth } from "../../../components/AuthProvider";
import { peekMentorInvite, redeemMentorInvite } from "../../../lib/db";
import { localDay } from "../../../lib/gamify";
import { DOMAINS, SKILLS } from "../../../lib/types";
import { COUNTRIES } from "../../../lib/countries";
import { Bar } from "../../../components/ui";
import {
  TagField,
  MAX_EXPERTISE,
  MAX_COACH,
} from "../../../components/TagField";
import type { VentureStage } from "../../../lib/types";

const STAGES: { id: VentureStage; label: string }[] = [
  { id: "idea", label: "Just an idea" },
  { id: "building", label: "Building it" },
  { id: "launched", label: "Launched" },
  { id: "revenue", label: "Has revenue" },
];

// Presets are a starting point, not a ceiling — TagField carries the caps.
const EXPERTISE_PRESETS = DOMAINS.filter((d) => d !== "Other");

const INVITE_ERRORS: Record<string, string> = {
  invalid: "That code isn't valid. Check the link you were sent.",
  used: "This invite has already been used. Ask the team for a fresh one.",
  expired: "This invite has expired. Ask the team for a fresh link.",
};

/** Friendly copy for the Firebase auth error codes email/password can throw. */
function authErrorMessage(code: string): string {
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    case "auth/missing-password":
      return "Enter your password.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/email-already-in-use":
      return "That email already has an account — switch to sign in.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Wrong email or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment, then try again.";
    default:
      return "Sign-in failed. Try again.";
  }
}

function MentorJoin() {
  const { user, profile } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const [code, setCode] = useState(params.get("code") ?? "");
  const [codeOk, setCodeOk] = useState(false);

  // ---- auth (mirrors /login; mentors usually need a fresh account) ----
  const [mode, setMode] = useState<"signin" | "create">("create");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // ---- mentor onboarding, 3 short steps (identity → edge → proof) ----
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
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

  // Prefill name from the Google account so it rarely has to be typed.
  useEffect(() => {
    if (user?.displayName) {
      const [first, ...rest] = user.displayName.split(" ");
      setFirstName((n) => n || first);
      setLastName((n) => n || rest.join(" "));
    }
  }, [user]);

  async function checkCode() {
    if (busy) return;
    if (!code.trim()) {
      setError("Paste your invite code first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const status = await peekMentorInvite(code.trim());
      if (status === "valid") setCodeOk(true);
      else setError(INVITE_ERRORS[status] ?? INVITE_ERRORS.invalid);
    } catch {
      setError("Couldn't check the code. Try again.");
    }
    setBusy(false);
  }

  async function signInGoogle() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signInWithPopup(getFirebaseAuth(), googleProvider);
    } catch (e) {
      const c = (e as { code?: string }).code ?? "";
      if (c !== "auth/popup-closed-by-user" && c !== "auth/cancelled-popup-request") {
        setError("Sign-in failed. Try again.");
      }
    }
    setBusy(false);
  }

  async function signInEmail(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Email and password are both required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const auth = getFirebaseAuth();
      if (mode === "create") {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (err) {
      setError(authErrorMessage((err as { code?: string }).code ?? ""));
    }
    setBusy(false);
  }

  /** Shared by the fresh-signup form and the operator-promotion button. */
  async function redeem(withProfile: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await redeemMentorInvite(
        code.trim(),
        withProfile
          ? {
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
            }
          : undefined
      );
      if (res.ok) {
        router.replace("/mentor");
        return;
      }
      if (res.error && INVITE_ERRORS[res.error]) {
        // Code went bad between peek and redeem — back to step 1.
        setCodeOk(false);
        setError(INVITE_ERRORS[res.error]);
      } else {
        setError("Couldn't finish signup. Try again.");
      }
    } catch {
      setError("Couldn't finish signup. Try again.");
    }
    setBusy(false);
  }

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

  const hasBuilding = building.trim().length > 0;

  /* ---------------- Step 0: the invite code ---------------- */

  if (!codeOk) {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">Mentor access</h1>
          <p className="gate__sub">Invite-only. Paste the code you were sent.</p>

          <div className="field">
            <label htmlFor="mj-code">Invite code</label>
            <input
              id="mj-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="From your invite link"
              maxLength={120}
              autoComplete="off"
            />
          </div>

          {error && <p className="form-err">{error}</p>}

          <button
            className="btn btn--primary btn--block"
            onClick={checkCode}
            disabled={busy}
          >
            {busy ? "…" : "Continue"}
          </button>
        </div>
      </section>
    );
  }

  /* ---------------- Sign in / create the account ---------------- */

  if (user === undefined || (user && profile === undefined)) {
    return (
      <section className="gate">
        <div className="gate__inner">
          <p className="gate__sub">…</p>
        </div>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">Welcome, mentor.</h1>
          <p className="gate__sub">Code accepted — now create your account.</p>

          <button
            className="btn btn--primary btn--block"
            onClick={signInGoogle}
            disabled={busy}
          >
            Continue with Google
          </button>

          <div className="auth-or">
            <span>or</span>
          </div>

          <form onSubmit={signInEmail}>
            <div className="field">
              <label htmlFor="mj-email">Email</label>
              <input
                id="mj-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                maxLength={254}
              />
            </div>
            <div className="field">
              <label htmlFor="mj-password">Password</label>
              <input
                id="mj-password"
                type="password"
                autoComplete={mode === "create" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "create" ? "6+ characters" : "Your password"}
                maxLength={128}
              />
            </div>
            <button className="btn btn--ink btn--block" type="submit" disabled={busy}>
              {busy ? "…" : mode === "create" ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="auth-switch">
            {mode === "create" ? "Already have an account?" : "New here?"}{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode((m) => (m === "create" ? "signin" : "create"));
                setError("");
              }}
            >
              {mode === "create" ? "Sign in" : "Create one"}
            </button>
          </p>

          {error && <p className="form-err">{error}</p>}
        </div>
      </section>
    );
  }

  /* ---------------- Signed in with an existing profile ---------------- */

  if (profile?.role === "mentor") {
    return (
      <section className="gate">
        <div className="gate__inner">
          <h1 className="h1">You&apos;re already a mentor.</h1>
          <p className="gate__sub">Nothing to redeem — your squads are waiting.</p>
          <button
            className="btn btn--primary btn--block"
            onClick={() => router.replace("/mentor")}
          >
            Go to your dashboard
          </button>
        </div>
      </section>
    );
  }

  if (profile) {
    return (
      <section className="gate">
        <div className="gate__inner">
          <h1 className="h1">Upgrade this account?</h1>
          <p className="gate__sub">
            You&apos;re signed in as {profile.name} with an operator account.
            Redeeming this invite makes it a mentor account — your profile and
            history stay.
          </p>
          {error && <p className="form-err">{error}</p>}
          <button
            className="btn btn--primary btn--block"
            onClick={() => void redeem(false)}
            disabled={busy}
          >
            {busy ? "…" : "Become a mentor"}
          </button>
        </div>
      </section>
    );
  }

  /* ---------------- Mentor onboarding: 3 short steps ---------------- */

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
              <label htmlFor="mj-first">First name</label>
              <input
                id="mj-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Grace"
                maxLength={60}
              />
            </div>
            <div className="field">
              <label htmlFor="mj-last">Last name</label>
              <input
                id="mj-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Hopper"
                maxLength={60}
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="mj-country">Country</label>
              <select
                id="mj-country"
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
              <label htmlFor="mj-tz">Timezone</label>
              <select
                id="mj-tz"
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
            <label htmlFor="mj-headline">Headline</label>
            <input
              id="mj-headline"
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
            <label htmlFor="mj-building">Building now · optional</label>
            <textarea
              id="mj-building"
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
            <label htmlFor="mj-bio">Bio · optional</label>
            <textarea
              id="mj-bio"
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
              onClick={() => void redeem(true)}
              disabled={busy}
            >
              {busy ? "…" : "Join as mentor"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default function MentorJoinPage() {
  // useSearchParams needs a Suspense boundary so the rest of the route can
  // still prerender (Next 16 app-router requirement).
  return (
    <Suspense fallback={null}>
      <MentorJoin />
    </Suspense>
  );
}
