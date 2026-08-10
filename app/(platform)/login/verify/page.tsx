"use client";

/**
 * TEMPORARY — founding-batch access gate (step 2 of 2).
 *
 * The magic link from /api/access/request lands here. This page completes the
 * Firebase email-link sign-in, re-checks the allowlist SERVER-side
 * (/api/access/claim — signing in is not the same as being allowed in), and
 * routes to the right onboarding or app for the role.
 *
 * Delete with the rest of the gate — see app/lib/accessGate.ts.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
} from "firebase/auth";
import { getFirebaseAuth } from "../../../lib/firebase";
import {
  claimAccess,
  createApprovedMentorProfile,
  ACCESS_EMAIL_KEY,
} from "../../../lib/accessClient";
import { MentorOnboarding } from "../../../components/MentorOnboarding";
import type { MentorSignupInput } from "../../../lib/types";

type Phase =
  /** Completing the sign-in. */
  | "working"
  /** Link opened on another device — Firebase needs the email back. */
  | "need-email"
  /** Allowlisted mentor with no profile: run mentor onboarding here. */
  | "mentor-onboarding"
  /** Signed in fine, but not on the list — already signed back out. */
  | "not-approved"
  /** Link expired, already used, or isn't a sign-in link at all. */
  | "bad-link"
  | "error";

function readStoredEmail(): string {
  try {
    return window.localStorage.getItem(ACCESS_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function clearStoredEmail(): void {
  try {
    window.localStorage.removeItem(ACCESS_EMAIL_KEY);
  } catch {
    /* storage disabled — nothing to clean up */
  }
}

export default function VerifyPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("working");
  const [promptEmail, setPromptEmail] = useState("");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    /** Finish sign-in with `email`, then decide where this person goes. */
    async function complete(email: string): Promise<void> {
      const auth = getFirebaseAuth();
      try {
        const cred = await signInWithEmailLink(auth, email, window.location.href);
        if (cancelled) return;
        clearStoredEmail();
        setDisplayName(cred.user.displayName);
      } catch (e) {
        if (cancelled) return;
        const code = (e as { code?: string }).code ?? "";
        if (code === "auth/invalid-email") {
          setError("That email doesn't match the one the link was sent to.");
          setPhase("need-email");
        } else {
          setPhase("bad-link");
        }
        return;
      }

      // Signing in proves the mailbox, not the entitlement. The allowlist is
      // re-read server-side against the verified token before anyone is let in.
      try {
        const claim = await claimAccess();
        if (cancelled) return;

        if (!claim.ok) {
          await signOut(auth);
          if (!cancelled) setPhase("not-approved");
          return;
        }
        if (claim.hasProfile) {
          router.replace(claim.role === "mentor" ? "/mentor" : "/dashboard");
          return;
        }
        if (claim.role === "mentor") {
          setPhase("mentor-onboarding");
          return;
        }
        // Operators go through the existing onboarding untouched, parental
        // consent and all.
        router.replace("/onboarding");
      } catch {
        if (!cancelled) setPhase("error");
      }
    }

    async function run(): Promise<void> {
      const auth = getFirebaseAuth();
      // Await first so no setState below runs synchronously inside the effect,
      // and so Firebase has restored any persisted session before we act.
      await auth.authStateReady();
      if (cancelled) return;

      if (!isSignInWithEmailLink(auth, window.location.href)) {
        setPhase("bad-link");
        return;
      }
      const stored = readStoredEmail();
      if (!stored) {
        // Link opened on a different device/browser than it was requested
        // from. This is a real Firebase requirement, not an edge case we can
        // skip: the email is half of the credential.
        setPhase("need-email");
        return;
      }
      await complete(stored);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = promptEmail.trim();
    if (!trimmed) {
      setError("Enter the email the link was sent to.");
      return;
    }
    setBusy(true);
    setError("");
    setPhase("working");

    const auth = getFirebaseAuth();
    try {
      const cred = await signInWithEmailLink(auth, trimmed, window.location.href);
      clearStoredEmail();
      setDisplayName(cred.user.displayName);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      setPhase("need-email");
      setError(
        code === "auth/invalid-email"
          ? "That email doesn't match the one the link was sent to."
          : "That link is no longer valid. Request a fresh one."
      );
      setBusy(false);
      return;
    }

    try {
      const claim = await claimAccess();
      if (!claim.ok) {
        await signOut(auth);
        setPhase("not-approved");
        setBusy(false);
        return;
      }
      if (claim.hasProfile) {
        router.replace(claim.role === "mentor" ? "/mentor" : "/dashboard");
        return;
      }
      if (claim.role === "mentor") {
        setPhase("mentor-onboarding");
        setBusy(false);
        return;
      }
      router.replace("/onboarding");
    } catch {
      setPhase("error");
      setBusy(false);
    }
  }

  /** Mentor onboarding submit — the allowlist twin of redeeming an invite. */
  async function createMentor(input: MentorSignupInput): Promise<string | null> {
    try {
      const res = await createApprovedMentorProfile(input);
      if (res.ok) {
        router.replace("/mentor");
        return null;
      }
      if (res.error === "not-approved") {
        return "Your mentor access couldn't be confirmed. Ask the team for a fresh invite.";
      }
      return "Couldn't finish signup. Try again.";
    } catch {
      return "Couldn't finish signup. Try again.";
    }
  }

  /* ---------------- Mentor onboarding ---------------- */

  if (phase === "mentor-onboarding") {
    return (
      <MentorOnboarding
        prefillName={displayName}
        submitLabel="Finish setup"
        onSubmit={createMentor}
      />
    );
  }

  /* ---------------- Not on the list ---------------- */

  if (phase === "not-approved") {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">You&apos;re not in the batch yet.</h1>
          <p className="gate__sub">
            That email isn&apos;t on the founding-batch list, so we&apos;ve
            signed you back out. Applications are open — we&apos;re adding
            people as spots free up.
          </p>
          <button
            className="btn btn--primary btn--block"
            onClick={() => router.push("/")}
          >
            Apply to join
          </button>
        </div>
      </section>
    );
  }

  /* ---------------- Expired / invalid link ---------------- */

  if (phase === "bad-link" || phase === "error") {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">
            {phase === "bad-link" ? "This link has expired." : "Something went wrong."}
          </h1>
          <p className="gate__sub">
            {phase === "bad-link"
              ? "Sign-in links are single-use and don't last long. Request a fresh one — it only takes a second."
              : "We couldn't finish signing you in. Try requesting a new link."}
          </p>
          <button
            className="btn btn--primary btn--block"
            onClick={() => router.push("/login")}
          >
            Get a new link
          </button>
        </div>
      </section>
    );
  }

  /* ---------------- Ask for the email ---------------- */

  if (phase === "need-email") {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">One more thing.</h1>
          <p className="gate__sub">
            It looks like you opened this link on a different device. Confirm
            the email you requested it with and we&apos;ll finish signing you in.
          </p>
          <form onSubmit={submitEmail}>
            <div className="field">
              <label htmlFor="verify-email">Email</label>
              <input
                id="verify-email"
                type="email"
                autoComplete="email"
                value={promptEmail}
                onChange={(e) => setPromptEmail(e.target.value)}
                placeholder="you@email.com"
                maxLength={254}
                autoFocus
              />
            </div>
            <button
              className="btn btn--primary btn--block"
              type="submit"
              disabled={busy}
            >
              {busy ? "…" : "Finish signing in"}
            </button>
          </form>
          {error && <p className="form-err">{error}</p>}
        </div>
      </section>
    );
  }

  /* ---------------- Working ---------------- */

  return (
    <section className="gate">
      <div className="gate__inner">
        <span className="gate__logo" aria-hidden="true">
          <img src="/brand/high-agency-mark.svg" alt="" />
        </span>
        <h1 className="h1">Signing you in…</h1>
        <p className="gate__sub">One moment.</p>
      </div>
    </section>
  );
}
