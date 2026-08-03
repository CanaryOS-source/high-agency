"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "../../lib/firebase";
import { useAuth } from "../../components/AuthProvider";

type Mode = "signin" | "create";

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

export default function LoginPage() {
  const { user, profile } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Email/password path — a direct identity API call with no off-localhost
  // redirect, so it works inside sandboxed previews where the Google popup
  // (which must hand off to highagency-62e67.firebaseapp.com) is blocked. It's also
  // the email fallback the PRD calls for when SSO isn't available.
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Already signed in → route past login. Profile decides the destination:
  // no profile means onboarding, and mentors get their own app, not the
  // operator one.
  useEffect(() => {
    if (user && profile !== undefined) {
      router.replace(
        !profile ? "/onboarding" : profile.role === "mentor" ? "/mentor" : "/dashboard"
      );
    }
  }, [user, profile, router]);

  async function signInGoogle() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signInWithPopup(getFirebaseAuth(), googleProvider);
      // redirect handled by the effect above once profile resolves
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        setError("Sign-in failed. Try again.");
      }
      setBusy(false);
    }
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
      // redirect handled by the effect above once profile resolves
    } catch (err) {
      setError(authErrorMessage((err as { code?: string }).code ?? ""));
      setBusy(false);
    }
  }

  return (
    <section className="gate">
      <div className="gate__inner">
        <span className="gate__logo" aria-hidden="true">
          <img src="/brand/high-agency-mark.svg" alt="" />
        </span>
        <h1 className="h1">Ready to build?</h1>
        <p className="gate__sub">Your squad&apos;s waiting.</p>

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
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              maxLength={254}
            />
          </div>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
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
          {mode === "create" ? "Already in?" : "New here?"}{" "}
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
