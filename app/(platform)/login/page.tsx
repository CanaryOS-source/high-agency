"use client";

/**
 * TEMPORARY — founding-batch access gate (step 1 of 2).
 *
 * For the free founding batch, production is open to strangers but accounts
 * are not: the only way in is an email that staff has added to the
 * `approvedMembers` allowlist. So this page asks for one thing — an email —
 * and either mails a sign-in link or says, politely, that they're not in the
 * batch yet and points them at the waitlist.
 *
 * There is deliberately NO Google button, NO password field and NO
 * create-account toggle here: every one of those would mint an account for
 * someone who isn't on the list. (The break-glass mentor path,
 * /mentor/join?code=…, still has them — it is gated by a single-use code
 * instead.) Step 2 is app/(platform)/login/verify.
 *
 * Delete with the rest of the gate — see app/lib/accessGate.ts for the
 * checklist and restore an ordinary sign-in form here.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { requestAccessLink, ACCESS_EMAIL_KEY } from "../../lib/accessClient";

type GateState = "idle" | "sent" | "not-approved" | "error";

export default function LoginPage() {
  const { user, profile } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [state, setState] = useState<GateState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** The address we actually sent to, so the confirmation can name it even if
   *  the input is later edited. */
  const [sentTo, setSentTo] = useState("");

  // Already signed in → route past login. Unchanged from before the gate:
  // no profile means onboarding, and mentors get their own app.
  useEffect(() => {
    if (user && profile !== undefined) {
      router.replace(
        !profile ? "/onboarding" : profile.role === "mentor" ? "/mentor" : "/dashboard"
      );
    }
  }, [user, profile, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email.");
      return;
    }
    setBusy(true);
    setError("");

    const res = await requestAccessLink(trimmed);

    if (res.status === "sent") {
      // Firebase needs this address back to complete the sign-in on /verify.
      try {
        window.localStorage.setItem(ACCESS_EMAIL_KEY, trimmed.toLowerCase());
      } catch {
        // Private mode / storage disabled — /verify falls back to asking.
      }
      setSentTo(trimmed);
      setState("sent");
    } else if (res.status === "not-approved") {
      setState("not-approved");
    } else {
      setState("error");
      setError(
        res.message ??
          (res.status === "bad-email"
            ? "That doesn't look like a valid email."
            : "Something went wrong. Try again shortly.")
      );
    }
    setBusy(false);
  }

  function reset() {
    setState("idle");
    setError("");
    setSentTo("");
  }

  /* ---------------- Not in the batch ---------------- */

  if (state === "not-approved") {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">You&apos;re not in the batch yet.</h1>
          <p className="gate__sub">
            High Agency is running a small founding batch right now, and
            <strong> {sentTo || email.trim()}</strong> isn&apos;t on the list.
            That&apos;s not a no — applications are open, and we&apos;re adding
            people as spots free up.
          </p>
          <button
            className="btn btn--primary btn--block"
            onClick={() => router.push("/")}
          >
            Apply to join
          </button>
          <p className="auth-switch">
            Wrong email?{" "}
            <button type="button" className="link-btn" onClick={reset}>
              Try another
            </button>
          </p>
        </div>
      </section>
    );
  }

  /* ---------------- Link sent ---------------- */

  if (state === "sent") {
    return (
      <section className="gate">
        <div className="gate__inner">
          <span className="gate__logo" aria-hidden="true">
            <img src="/brand/high-agency-mark.svg" alt="" />
          </span>
          <h1 className="h1">Check your inbox.</h1>
          <p className="gate__sub">
            We sent a sign-in link to <strong>{sentTo}</strong>. It&apos;s
            single-use and expires shortly — open it on this device if you can.
          </p>
          <p className="auth-switch">
            Didn&apos;t arrive? Check spam, or{" "}
            <button type="button" className="link-btn" onClick={reset}>
              use a different email
            </button>
            .
          </p>
        </div>
      </section>
    );
  }

  /* ---------------- The gate ---------------- */

  return (
    <section className="gate">
      <div className="gate__inner">
        <span className="gate__logo" aria-hidden="true">
          <img src="/brand/high-agency-mark.svg" alt="" />
        </span>
        <h1 className="h1">Ready to build?</h1>
        <p className="gate__sub">
          High Agency is invite-only while the founding batch runs. Enter the
          email you applied with and we&apos;ll send you a sign-in link.
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="gate-email">Email</label>
            <input
              id="gate-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              maxLength={254}
              autoFocus
            />
          </div>
          <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
            {busy ? "Checking…" : "Send me a sign-in link"}
          </button>
        </form>

        {error && <p className="form-err">{error}</p>}

        <p className="auth-switch">
          Not in the batch?{" "}
          <button type="button" className="link-btn" onClick={() => router.push("/")}>
            Apply to join
          </button>
        </p>
      </div>
    </section>
  );
}
