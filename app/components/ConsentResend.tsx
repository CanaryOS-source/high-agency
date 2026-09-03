"use client";

import { useEffect, useState } from "react";
import { requestConsentEmail } from "../lib/db";

/** Keep in step with RESEND_COOLDOWN_MS in app/api/consent/send/route.ts. The
 *  server is authoritative; this only pre-disables the button so a too-early
 *  click doesn't round-trip just to bounce off a 429. */
const COOLDOWN_S = 60;

/**
 * "Resend approval" control for the pending-consent notice. An operator renders
 * it for themselves (omit `uid`); a mentor could target another operator's uid.
 * Rate-limiting is enforced server-side — this reflects the cooldown and syncs
 * to the server's `retryAfter` whenever a resend is refused.
 */
export function ConsentResend({ uid, sentAtMs }: { uid?: string; sentAtMs?: number }) {
  const [busy, setBusy] = useState(false);
  // The cooldown is held as the epoch ms it ends at, not as a ticking count.
  // A deadline is pure data — it can be derived from `sentAtMs` at render — so
  // the only thing the clock effect does is publish "what time is it now",
  // which also stops the countdown drifting or stalling in a backgrounded tab.
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(0); // 0 until the first client tick (SSR-safe)
  const [note, setNote] = useState<string | null>(null);

  const deadline = until ?? (sentAtMs ? sentAtMs + COOLDOWN_S * 1000 : null);

  useEffect(() => {
    if (deadline === null) return;
    const tick = () => setNow(Date.now());
    const raf = requestAnimationFrame(tick); // first read, before paint
    const t = setInterval(tick, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, [deadline]);

  const left =
    deadline && now ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;

  async function resend() {
    if (busy || left > 0) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await requestConsentEmail(uid);
      if (r.ok) {
        setNote("Sent — check their inbox (and spam).");
        setUntil(Date.now() + COOLDOWN_S * 1000);
      } else if (r.error === "rate-limited") {
        setUntil(Date.now() + (r.retryAfter ?? COOLDOWN_S) * 1000);
      } else if (r.error === "no-parent-email") {
        setNote("No parent email on file.");
      } else {
        setNote("Couldn't resend — try again shortly.");
      }
    } catch {
      setNote("Couldn't resend — try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  const label = busy ? "Sending…" : left > 0 ? `Resend in ${left}s` : "Resend approval";

  return (
    <span className="notice__action">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={resend}
        disabled={busy || left > 0}
      >
        {label}
      </button>
      {note && <small className="notice__note">{note}</small>}
    </span>
  );
}
