"use client";

/* Browser-side wrappers for the server-authoritative routes under app/api.
   Every call carries the signed-in user's Firebase ID token. */

import { getFirebaseAuth } from "./firebase";
import type { WorkshopWire } from "./workshopServer";
import type { ConfirmWire } from "./checkinServer";

export type { WorkshopWire };

async function authed<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("not-signed-in");
  const idToken = await user.getIdToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

/* ---------------- Workshops ---------------- */

export async function createWorkshop(
  input: WorkshopWire
): Promise<{ id: string; calendar: "linked" | "manual" }> {
  const r = await authed<{ id: string; calendar: "linked" | "manual"; error?: string }>(
    "/api/workshops",
    { method: "POST", body: JSON.stringify(input) }
  );
  if (!r.ok) throw new Error(r.data.error ?? "failed");
  return r.data;
}

export async function updateWorkshop(id: string, input: WorkshopWire): Promise<void> {
  const r = await authed<{ error?: string }>(`/api/workshops/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(r.data.error ?? "failed");
}

export async function deleteWorkshop(id: string): Promise<void> {
  const r = await authed<{ error?: string }>(`/api/workshops/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(r.data.error ?? "failed");
}

export type SeatResult = "enrolled" | "already" | "full" | "left" | "not-enrolled";

export async function enrollWorkshop(id: string): Promise<SeatResult> {
  const r = await authed<{ status?: SeatResult; error?: string }>(`/api/workshops/${id}/enroll`, {
    method: "POST",
  });
  if (!r.ok || !r.data.status) throw new Error(r.data.error ?? "failed");
  return r.data.status;
}

export async function leaveWorkshop(id: string): Promise<SeatResult> {
  const r = await authed<{ status?: SeatResult; error?: string }>(`/api/workshops/${id}/enroll`, {
    method: "DELETE",
  });
  if (!r.ok || !r.data.status) throw new Error(r.data.error ?? "failed");
  return r.data.status;
}

/* ---------------- Streak actions ---------------- */

/** One line to the squad's build log. The server writes the log and the
 *  streak together; the live profile listener moves the flame. */
export async function postBuildLog(cohortId: string, text: string): Promise<void> {
  const r = await authed<{ error?: string }>("/api/build-log", {
    method: "POST",
    body: JSON.stringify({ cohortId, text }),
  });
  if (!r.ok) throw new Error(r.data.error ?? "failed");
}

/** "We met" — once per ISO week per squad, counts the day for the caller. */
export async function markRitual(cohortId: string): Promise<void> {
  const r = await authed<{ error?: string }>("/api/ritual", {
    method: "POST",
    body: JSON.stringify({ cohortId }),
  });
  if (!r.ok) throw new Error(r.data.error ?? "failed");
}

/* ---------------- Check-ins ---------------- */

export async function confirmCheckIn(input: ConfirmWire): Promise<{ calendar: "linked" | "manual" }> {
  const r = await authed<{ calendar: "linked" | "manual"; error?: string }>("/api/checkins/confirm", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(r.data.error ?? "failed");
  return r.data;
}

/* ---------------- Google Calendar ---------------- */

export interface CalendarStatus {
  /** The OAuth client exists on the server at all. */
  configured: boolean;
  /** This mentor has connected an account. */
  connected: boolean;
  email: string;
}

export async function calendarStatus(): Promise<CalendarStatus> {
  const r = await authed<Partial<CalendarStatus>>("/api/google/status");
  return {
    configured: !!r.data.configured,
    connected: !!r.data.connected,
    email: r.data.email ?? "",
  };
}

/** Kick off the connect flow: the browser leaves for Google and comes back to
 *  `returnTo` with ?calendar=connected. */
export async function connectCalendar(returnTo: string): Promise<void> {
  const r = await authed<{ url?: string; error?: string }>("/api/google/connect", {
    method: "POST",
    body: JSON.stringify({ returnTo }),
  });
  if (!r.ok || !r.data.url) throw new Error(r.data.error ?? "failed");
  window.location.assign(r.data.url);
}

export async function disconnectCalendar(): Promise<void> {
  const r = await authed<{ error?: string }>("/api/google/disconnect", { method: "POST" });
  if (!r.ok) throw new Error(r.data.error ?? "failed");
}
