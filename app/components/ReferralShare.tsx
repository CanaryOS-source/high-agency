"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchReferralCounter } from "../lib/firebase";
import {
  REFERRAL_JUMP,
  REFERRAL_MAX,
  placesRemaining,
  referralLink,
  type ReferralCounter,
} from "../lib/referral";

/**
 * The share block on the application success step.
 *
 * Costs exactly ONE Firestore read: `referrals/{code}` holds the code, the
 * confirmed count and the already-computed position, so there is nothing to
 * aggregate and nothing to wait on. It also renders immediately from the
 * position the applicant just got, and only swaps in the live numbers when
 * they land — a returning applicant never sees a spinner where their queue
 * number should be.
 */
export default function ReferralShare({
  code,
  fallbackPos,
}: {
  code: string;
  /** Position from the local record, shown until the live counter arrives. */
  fallbackPos: number;
}) {
  const [counter, setCounter] = useState<ReferralCounter | null>(null);
  const [copied, setCopied] = useState(false);

  // Derived, not state: window.location is the only source of truth for the
  // origin. The guard is belt-and-braces — the modal that owns this component
  // renders nothing until it is opened, so this never runs on the server and
  // there is no first paint for it to mismatch.
  const link =
    typeof window === "undefined" ? "" : referralLink(window.location.origin, code);

  useEffect(() => {
    let live = true;
    fetchReferralCounter(code).then((c) => {
      if (live && c) setCounter(c);
    });
    return () => {
      live = false;
    };
  }, [code]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const share = useCallback(async () => {
    if (!link) return;
    // Native share sheet on mobile, clipboard everywhere else. Either way the
    // link is on the clipboard afterwards, so the button never dead-ends.
    if (navigator.share) {
      try {
        await navigator.share({
          title: "High Agency — Founding Batch 01",
          text: "I'm in the queue for High Agency. Apply with my link and we both move up.",
          url: link,
        });
        return;
      } catch {
        // Cancelled or unsupported — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context / permission). The input below is
      // selectable, so there is still a way through.
    }
  }, [link]);

  const credited = counter?.credited ?? 0;
  const pos = counter?.pos ?? fallbackPos;
  const left = placesRemaining(credited);

  return (
    <div className="refer">
      <div className="refer__head">
        <span className="eyebrow eyebrow--accent">
          <span className="dot" />
          Move up the queue
        </span>
        <span className="refer__count">
          {credited} / {REFERRAL_MAX}
        </span>
      </div>

      <p className="refer__copy">
        Bring in up to {REFERRAL_MAX} builders. Every one who applies moves you{" "}
        <b>{REFERRAL_JUMP} places</b> up.
      </p>

      {/* Progress: one pip per referral, filled as they confirm. */}
      <div className="refer__pips" aria-hidden="true">
        {Array.from({ length: REFERRAL_MAX }, (_, i) => (
          <span key={i} className={i < credited ? "on" : ""} />
        ))}
      </div>

      <div className="refer__link">
        <input
          readOnly
          value={link}
          aria-label="Your referral link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn btn--signal refer__btn"
          onClick={share}
          disabled={!link}
        >
          {copied ? "Copied" : "Share"}
        </button>
      </div>

      <div className="refer__foot">
        <span className="refer__pos">
          Position <b>#{pos}</b>
        </span>
        <span className="refer__left">
          {left > 0
            ? `${left} places still on the table`
            : "You've climbed as far as referrals go."}
        </span>
      </div>
    </div>
  );
}
