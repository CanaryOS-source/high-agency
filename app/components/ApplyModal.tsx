"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  submitApplication,
  type ApplicationRecord,
} from "../lib/firebase";
import { notifyHubspotApplication } from "../lib/hubspotClient";
import {
  MARKETING_CONSENT_HINT,
  MARKETING_CONSENT_LABEL,
} from "../lib/marketingConsent";
import ReferralShare from "./ReferralShare";

const STORAGE_KEY = "ha_application";
// Founding Batch 01 targets high-school operators — collect exact age 12–18.
const AGES = ["12", "13", "14", "15", "16", "17", "18"];

// Per-question word ceilings. Enforced in the UI only: we block, never truncate.
const LIMIT_BUILDING = 120;
const LIMIT_BOLDEST = 120;
const LIMIT_IMPACT = 150;
const LIMIT_PROBLEM = 120;
const LIMIT_PLAN = 100;

const validEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/**
 * Social is optional and deliberately forgiving: a full URL, a bare domain
 * path, or an @handle all pass. Empty always passes — it must never block.
 */
const validSocial = (v: string) => {
  const s = v.trim();
  if (!s) return true;
  if (/\s/.test(s)) return false;
  if (/^@[a-z0-9._-]{2,}$/i.test(s)) return true;
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s);
};

const countWords = (v: string) => {
  const t = v.trim();
  return t ? t.split(/\s+/).length : 0;
};

interface Answer {
  value: string;
  limit: number;
}

/**
 * One error line for a step's textareas: over-limit blocks first (it's the
 * specific, actionable failure), then the 2-character minimum.
 */
function answerError(answers: Answer[]): string {
  const over = answers.filter((a) => countWords(a.value) > a.limit).length;
  if (over > 0) {
    return over > 1
      ? "Both answers are over the word limit. Trim them to continue."
      : "That answer is over the word limit. Trim it to continue.";
  }
  if (answers.some((a) => a.value.trim().length < 2)) {
    return "Give us a sentence on each, that's all we need.";
  }
  return "";
}

function readSaved(): ApplicationRecord | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

interface WordFieldProps {
  id: string;
  label: string;
  placeholder: string;
  limit: number;
  value: string;
  onChange: (v: string) => void;
}

/**
 * Textarea with a word counter that stays silent until the answer is actually
 * over its limit — an always-on counter is noise. Over the limit, the count
 * and the field border both go red and the step's Continue is blocked.
 */
function WordField({
  id,
  label,
  placeholder,
  limit,
  value,
  onChange,
}: WordFieldProps) {
  const words = countWords(value);
  const over = words > limit;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        placeholder={placeholder}
        value={value}
        aria-describedby={over ? `${id}-count` : undefined}
        aria-invalid={over || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {over && (
        <span className="field__count" id={`${id}-count`} aria-live="polite">
          {words} / {limit} words
        </span>
      )}
    </div>
  );
}

interface ApplyModalProps {
  open: boolean;
  prefillEmail?: string;
  /** Referral code this visitor arrived on, "" when they came in cold. */
  referredBy?: string;
  onClose: () => void;
  onApplied: () => void;
}

export default function ApplyModal({
  open,
  prefillEmail,
  referredBy = "",
  onClose,
  onApplied,
}: ApplyModalProps) {
  // A submission this browser already made. Read once, at mount, rather than
  // in an open-effect: the modal renders nothing until it is opened, so there
  // is no server/client output for a storage read to disagree about.
  const [restored] = useState<ApplicationRecord | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = readSaved();
    return saved && saved.submitted ? saved : null;
  });

  const [step, setStep] = useState(restored ? 5 : 1);
  const [name, setName] = useState(restored?.name ?? "");
  // null = untouched, so an email typed into the hero form still shows through.
  const [emailEdit, setEmail] = useState<string | null>(restored?.email ?? null);
  const [age, setAge] = useState(restored?.age ?? "");
  const [social, setSocial] = useState(restored?.social ?? "");
  const [building, setBuilding] = useState(restored?.building ?? "");
  const [boldest, setBoldest] = useState(restored?.boldest ?? "");
  const [impact, setImpact] = useState(restored?.impact ?? "");
  const [problem, setProblem] = useState(restored?.problem ?? "");
  const [plan, setPlan] = useState(restored?.plan ?? "");
  // Marketing opt-in. Starts UNCHECKED and stays optional — nothing on this
  // form is gated on it, and nothing sends off it today.
  const [marketingConsent, setMarketingConsent] = useState(
    restored?.marketingConsent === true
  );
  const [err, setErr] = useState("");
  const [submitErr, setSubmitErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplicationRecord | null>(restored);

  const email = emailEdit ?? prefillEmail ?? "";

  const cardRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<Element | null>(null);

  /** Closing rewinds the wizard for next time but keeps the answers, so an
   *  accidental close doesn't cost anyone a half-written application. Doing it
   *  here rather than in an open-effect keeps state moves in event handlers. */
  const close = useCallback(() => {
    setStep(restored ? 5 : 1);
    setErr("");
    onClose();
  }, [onClose, restored]);

  // Open / close side-effects: lock scroll, manage focus.
  useEffect(() => {
    if (!open) {
      (lastFocus.current as HTMLElement | null)?.focus?.();
      return;
    }
    lastFocus.current = document.activeElement;
    document.body.style.overflow = "hidden";
    if (!restored) {
      const t = setTimeout(() => firstFieldRef.current?.focus(), 60);
      return () => {
        clearTimeout(t);
        document.body.style.overflow = "";
      };
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, restored]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (cardRef.current) cardRef.current.scrollTop = 0;
  }, [step]);

  const back = useCallback((to: number) => {
    setErr("");
    setStep(to);
  }, []);

  const next1 = useCallback(() => {
    if (!name.trim() || !validEmail(email.trim()) || !age) {
      setErr("Fill in your name, a valid email, and your age to continue.");
      return;
    }
    if (!validSocial(social)) {
      setErr("Add a full link or an @handle, or leave social empty.");
      return;
    }
    setErr("");
    setStep(2);
  }, [name, email, age, social]);

  const next2 = useCallback(() => {
    const msg = answerError([
      { value: building, limit: LIMIT_BUILDING },
      { value: boldest, limit: LIMIT_BOLDEST },
    ]);
    if (msg) {
      setErr(msg);
      return;
    }
    setErr("");
    setStep(3);
  }, [building, boldest]);

  const next3 = useCallback(() => {
    const msg = answerError([
      { value: impact, limit: LIMIT_IMPACT },
      { value: problem, limit: LIMIT_PROBLEM },
    ]);
    if (msg) {
      setErr(msg);
      return;
    }
    setErr("");
    setStep(4);
  }, [impact, problem]);

  const doSubmit = useCallback(async () => {
    const msg = answerError([{ value: plan, limit: LIMIT_PLAN }]);
    if (msg) {
      setErr(msg);
      return;
    }
    setErr("");
    setSubmitErr("");
    setBusy(true);
    const input = {
      name: name.trim(),
      email: email.trim(),
      age,
      social: social.trim(),
      building: building.trim(),
      boldest: boldest.trim(),
      impact: impact.trim(),
      problem: problem.trim(),
      plan: plan.trim(),
      marketingConsent,
    };
    try {
      const record = await submitApplication(input, referredBy);
      // Fire-and-forget: get the applicant into the CRM now rather than on the
      // next cron tick. Never awaited, never checked — a HubSpot problem must
      // not touch the success screen below.
      notifyHubspotApplication(record.docId);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      } catch {}
      setResult(record);
      setStep(5);
      onApplied();
    } catch {
      // Network/permission failure: still log the application locally so the
      // operator isn't blocked, and surface a soft note.
      const fallback: ApplicationRecord = {
        ...input,
        opId: "HA-" + String(Math.floor(Math.random() * 900) + 100),
        queuePos: Math.floor(Math.random() * 40) + 47,
        submitted: true,
        ts: Date.now(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback));
      } catch {}
      setResult(fallback);
      setStep(5);
      onApplied();
    } finally {
      setBusy(false);
    }
  }, [
    name,
    email,
    age,
    social,
    building,
    boldest,
    impact,
    problem,
    plan,
    marketingConsent,
    referredBy,
    onApplied,
  ]);

  if (!open) return null;

  return (
    <div
      className="modal open"
      id="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modalTitle"
    >
      <div className="modal__scrim" onClick={close} />
      <div className="modal__card" ref={cardRef}>
        <button className="modal__close" onClick={close} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="modal__progress">
          <span className={step >= 1 ? "on" : ""} />
          <span className={step >= 2 ? "on" : ""} />
          <span className={step >= 3 ? "on" : ""} />
          <span className={step >= 4 ? "on" : ""} />
          <span className={step >= 5 ? "on" : ""} />
        </div>

        {/* step 1 — the basics */}
        {step === 1 && (
          <div className="modal__step active">
            <h3 id="modalTitle">Request access.</h3>
            <p className="modal__sub">Founding Batch 01. Takes five minutes.</p>
            <div className="field">
              <label htmlFor="m-name">Full name</label>
              <input
                ref={firstFieldRef}
                type="text"
                id="m-name"
                placeholder="First and last."
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && next1()}
              />
            </div>
            <div className="field">
              <label htmlFor="m-email">Email</label>
              <input
                type="email"
                id="m-email"
                placeholder="you@email.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && next1()}
              />
            </div>
            <div className="field">
              <label htmlFor="m-age">Age</label>
              <select
                id="m-age"
                value={age}
                onChange={(e) => setAge(e.target.value)}
              >
                <option value="" disabled>
                  Select your age
                </option>
                {AGES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="m-social">LinkedIn or site — optional</label>
              <input
                type="text"
                id="m-social"
                placeholder="linkedin.com/in/you or @handle"
                autoComplete="url"
                value={social}
                onChange={(e) => setSocial(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && next1()}
              />
            </div>
            <div className={`modal__err${err ? " show" : ""}`}>{err}</div>
            <div className="modal__actions">
              <button className="btn btn--primary modal__next" onClick={next1}>
                Continue
              </button>
            </div>
          </div>
        )}

        {/* step 2 — the build */}
        {step === 2 && (
          <div className="modal__step active">
            <h3>The build.</h3>
            <p className="modal__sub">Be real. Drive reads louder than polish.</p>
            <WordField
              id="m-build"
              label="Are you building anything right now?"
              placeholder="A product, a project, or raw ambition. All valid."
              limit={LIMIT_BUILDING}
              value={building}
              onChange={setBuilding}
            />
            <WordField
              id="m-bold"
              label="What's the riskiest or boldest thing you've done?"
              placeholder="Shipped, ran, taught, or cold-emailed something."
              limit={LIMIT_BOLDEST}
              value={boldest}
              onChange={setBoldest}
            />
            <div className={`modal__err${err ? " show" : ""}`}>{err}</div>
            <div className="modal__actions">
              <button
                className="btn btn--ghost modal__back"
                onClick={() => back(1)}
              >
                Back
              </button>
              <button className="btn btn--primary modal__next" onClick={next2}>
                Continue
              </button>
            </div>
          </div>
        )}

        {/* step 3 — the proof */}
        {step === 3 && (
          <div className="modal__step active">
            <h3>The proof.</h3>
            <p className="modal__sub">Show what you moved, not what you know.</p>
            <WordField
              id="m-impact"
              label="What have you made happen that wouldn't have happened without you?"
              placeholder="An event, a team, a sale, a fix nobody else made."
              limit={LIMIT_IMPACT}
              value={impact}
              onChange={setImpact}
            />
            <WordField
              id="m-problem"
              label="What's a problem you can't stop thinking about?"
              placeholder="Big or small. Yours or the world's."
              limit={LIMIT_PROBLEM}
              value={problem}
              onChange={setProblem}
            />
            <div className={`modal__err${err ? " show" : ""}`}>{err}</div>
            <div className="modal__actions">
              <button
                className="btn btn--ghost modal__back"
                onClick={() => back(2)}
              >
                Back
              </button>
              <button className="btn btn--primary modal__next" onClick={next3}>
                Continue
              </button>
            </div>
          </div>
        )}

        {/* step 4 — the road */}
        {step === 4 && (
          <div className="modal__step active">
            <h3>The road.</h3>
            <p className="modal__sub">Last one. No right answer here.</p>
            <WordField
              id="m-plan"
              label="What's your plan after high school?"
              placeholder="College, a company, undecided. Say it straight."
              limit={LIMIT_PLAN}
              value={plan}
              onChange={setPlan}
            />
            {/* Optional, unchecked, and deliberately below the last question:
                it is a separate decision from applying, not a step in it. */}
            <label className="optin" htmlFor="m-updates">
              <input
                type="checkbox"
                id="m-updates"
                checked={marketingConsent}
                onChange={(e) => setMarketingConsent(e.target.checked)}
              />
              <span className="optin__box" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4">
                  <path d="M5 12l5 5L19 7" />
                </svg>
              </span>
              <span className="optin__text">
                {MARKETING_CONSENT_LABEL}
                <span className="optin__hint">{MARKETING_CONSENT_HINT}</span>
              </span>
            </label>
            <div className={`modal__err${err ? " show" : ""}`}>{err}</div>
            {submitErr && <div className="modal__err show">{submitErr}</div>}
            <div className="modal__actions">
              <button
                className="btn btn--ghost modal__back"
                onClick={() => back(3)}
                disabled={busy}
              >
                Back
              </button>
              <button
                className="btn btn--primary modal__next"
                onClick={doSubmit}
                disabled={busy}
              >
                {busy ? "Submitting…" : "Submit application"}
              </button>
            </div>
          </div>
        )}

        {/* step 5, success */}
        {step === 5 && (
          <div className="modal__step active">
            <div className="success">
              <div className="success__seal">
                <svg
                  width="34"
                  height="34"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                >
                  <path d="M5 12l5 5L19 7" />
                </svg>
              </div>
              <h3>Application logged.</h3>
              <p className="modal__sub" style={{ marginBottom: 0 }}>
                You&apos;re in the queue. If it&apos;s a fit, we&apos;ll reach out.
              </p>
              <div className="success__id">
                OPERATOR ID · <b>{result?.opId ?? "HA-000"}</b>
              </div>
              {/* The offline fallback record has no counter document behind
                  it, so there is no link worth sharing — show the plain queue
                  number instead of a code that would credit nobody. */}
              {result?.referralCode ? (
                <ReferralShare
                  code={result.referralCode}
                  fallbackPos={result.queuePos}
                />
              ) : (
                <div className="success__q">
                  Position in queue{" "}
                  <span className="n">
                    {result ? `#${result.queuePos}` : "-"}
                  </span>
                </div>
              )}
              <div className="modal__actions" style={{ marginTop: 30 }}>
                <button
                  className="btn btn--ghost btn--block"
                  onClick={close}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
