"use client";

/* Google Calendar for mentors: one card that says whether this mentor's
   calendar is connected, and the button that connects or disconnects it.
   Sessions and check-ins get their Meet room from here. */

import { useEffect, useState, useSyncExternalStore } from "react";
import { calendarStatus, connectCalendar, disconnectCalendar, type CalendarStatus } from "../lib/api";
import { CalendarIcon, CheckIcon } from "./ui";

/** Fetched once per mount. `null` while loading. */
export function useCalendarStatus(): {
  status: CalendarStatus | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stale = false;
    calendarStatus()
      .then((s) => !stale && setStatus(s))
      .catch(() => !stale && setStatus({ configured: false, connected: false, email: "" }));
    return () => {
      stale = true;
    };
  }, [tick]);
  return { status, refresh: () => setTick((t) => t + 1) };
}

/** The `?calendar=` value this page load came back from Google with. Latched
 *  at module scope on first read so it survives the history rewrite below —
 *  the URL is cleared, but the message it produced stays on screen until the
 *  next real navigation. Also keeps the snapshot stable, which
 *  useSyncExternalStore requires. */
let landedWith: string | null = null;

function readLanded(): string {
  if (landedWith === null) {
    landedWith = new URL(window.location.href).searchParams.get("calendar") ?? "";
  }
  return landedWith;
}

/** What the browser came back with after the OAuth round trip, read from the
 *  URL once and then cleared so a reload doesn't repeat the message. Read
 *  through useSyncExternalStore rather than an effect: the URL is an external
 *  store, and the server snapshot ("") keeps hydration honest. */
function useReturnFlash(): string {
  const landed = useSyncExternalStore(
    () => () => {}, // fixed for the life of the page load
    readLanded,
    () => ""
  );

  useEffect(() => {
    if (!landed) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [landed]);

  return landed === "connected"
    ? "Google Calendar connected."
    : landed === "denied"
      ? "No access was granted — nothing changed."
      : landed
        ? "Couldn't connect. Try again."
        : "";
}

export function CalendarConnect({
  returnTo,
  compact = false,
}: {
  /** App path to land on after Google. */
  returnTo: string;
  /** One line + button, for the home screen. */
  compact?: boolean;
}) {
  const { status, refresh } = useCalendarStatus();
  const flash = useReturnFlash();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function connect() {
    setBusy(true);
    setErr("");
    try {
      await connectCalendar(returnTo);
    } catch {
      setErr("Couldn't start the connection. Try again.");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect Google Calendar? Existing events stay on your calendar.")) return;
    setBusy(true);
    setErr("");
    try {
      await disconnectCalendar();
      refresh();
    } catch {
      setErr("Couldn't disconnect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (status === null) return null;

  if (!status.configured) {
    if (compact) return null;
    return (
      <div className="tile tile--flat">
        <div className="tile__head">
          <h2 className="h3">
            <CalendarIcon size={18} /> Google Calendar
          </h2>
        </div>
        <p className="muted">
          Not set up on this server yet. Until it is, sessions use whatever Meet link you paste.
        </p>
      </div>
    );
  }

  if (status.connected) {
    return (
      <div className={compact ? "notice" : "tile tile--lime"}>
        {!compact && (
          <div className="tile__head">
            <h2 className="h3">
              <span className="signal"><CheckIcon /></span> Google Calendar
            </h2>
          </div>
        )}
        <span>
          {compact ? <span className="signal"><CheckIcon size={14} /></span> : null} Connected as{" "}
          <b>{status.email || "your Google account"}</b>.
          {!compact && (
            <small>
              New sessions and check-ins get a Meet room and land on your calendar. Operators who
              enroll get the invite.
            </small>
          )}
        </span>
        {flash && <span className="micro signal">{flash}</span>}
        <button className="btn btn--ghost btn--sm" onClick={disconnect} disabled={busy}>
          Disconnect
        </button>
        {err && <p className="form-err">{err}</p>}
      </div>
    );
  }

  return (
    <div className={compact ? "notice" : "tile tile--ember"}>
      {!compact && (
        <div className="tile__head">
          <h2 className="h3">
            <CalendarIcon size={18} /> Google Calendar
          </h2>
        </div>
      )}
      <span>
        {compact ? "Connect Google Calendar" : "Connect your calendar."}
        <small>
          Every session and check-in you schedule gets a Meet room automatically, and enrolled
          operators get the invite on their own calendar.
        </small>
      </span>
      {flash && <span className="micro">{flash}</span>}
      <button className="btn btn--primary btn--sm" onClick={connect} disabled={busy}>
        {busy ? "…" : "Connect"}
      </button>
      {err && <p className="form-err">{err}</p>}
    </div>
  );
}
