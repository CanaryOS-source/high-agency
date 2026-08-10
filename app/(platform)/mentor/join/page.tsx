"use client";

/**
 * Mentor signup — deliberately unlinked from any nav. Mentors arrive only via
 * an invite URL (`/mentor/join?code=…`) minted by scripts/mentor-invite.js and
 * shared 1:1 by staff. Flow: validate the single-use code → sign in / create
 * an account → the shared 3-step mentor onboarding (MentorOnboarding) → the
 * server redeems the code and mints `role: "mentor"` (app/api/mentor/redeem —
 * clients can't write the role). An invitee who already has an operator
 * account gets promoted in place.
 *
 * This is the BREAK-GLASS path and stays working regardless of the temporary
 * founding-batch allowlist gate; an allowlisted mentor reaches the identical
 * onboarding via /login/verify instead.
 */
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "../../../lib/firebase";
import { useAuth } from "../../../components/AuthProvider";
import { peekMentorInvite, redeemMentorInvite } from "../../../lib/db";
import { MentorOnboarding } from "../../../components/MentorOnboarding";
import type { MentorSignupInput } from "../../../lib/types";

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

  // ---- auth (mirrors /mentor/join's own history; mentors usually need a
  // fresh account, and this path must keep working without the email gate) ----
  const [mode, setMode] = useState<"signin" | "create">("create");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  /** Redeem for an existing operator account (no signup form needed). */
  async function promote() {
    setBusy(true);
    setError("");
    try {
      const res = await redeemMentorInvite(code.trim());
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

  /** Fresh signup: redeem the code AND create the mentor profile in one call.
   *  Returns an error string for MentorOnboarding to display, or null. */
  async function redeemWithProfile(input: MentorSignupInput): Promise<string | null> {
    try {
      const res = await redeemMentorInvite(code.trim(), input);
      if (res.ok) {
        router.replace("/mentor");
        return null;
      }
      if (res.error && INVITE_ERRORS[res.error]) {
        setCodeOk(false);
        return INVITE_ERRORS[res.error];
      }
      return "Couldn't finish signup. Try again.";
    } catch {
      return "Couldn't finish signup. Try again.";
    }
  }

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
            onClick={() => void promote()}
            disabled={busy}
          >
            {busy ? "…" : "Become a mentor"}
          </button>
        </div>
      </section>
    );
  }

  /* ---------------- Mentor onboarding: the shared 3-step flow ---------- */

  return (
    <MentorOnboarding
      prefillName={user.displayName}
      submitLabel="Join as mentor"
      onSubmit={redeemWithProfile}
    />
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
