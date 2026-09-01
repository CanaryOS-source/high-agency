/**
 * Server-only. Google Calendar for mentors: OAuth connect, encrypted token
 * storage, and the handful of event operations the product needs — create a
 * session with a Meet room, keep its guest list in step with enrollment,
 * move it, delete it.
 *
 * Auth model: each mentor connects their OWN Google account once. Events land
 * on their calendar and they host the Meet. The refresh token is the only
 * secret, and it is stored AES-256-GCM encrypted in `googleTokens/{uid}`
 * (deny-all to clients — see firestore.rules) under GOOGLE_TOKEN_KEY.
 *
 * Operators are invited as guests with `guestsCanSeeOtherGuests: false`, so
 * they get a real invite and reminders, the mentor sees who's coming, and no
 * operator ever sees another's email.
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (OAuth web client with the
 * /api/google/callback redirect), GOOGLE_TOKEN_KEY (32 bytes, hex).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { adminDb } from "./firebaseAdmin";

export const GOOGLE_TOKENS = "googleTokens";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
].join(" ");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? "";
}
function clientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET ?? "";
}

/** True when the OAuth client is set up. When false, every calendar feature
 *  degrades to "paste a link" and the UI says so. */
export function isCalendarConfigured(): boolean {
  return !!clientId() && !!clientSecret() && !!tokenKey();
}

export function redirectUri(origin: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? origin).replace(/\/$/, "");
  return `${base}/api/google/callback`;
}

/* ------------------------------------------------------------------ */
/* Crypto — token at rest, and the OAuth state parameter               */
/* ------------------------------------------------------------------ */

function tokenKey(): Buffer | null {
  const hex = process.env.GOOGLE_TOKEN_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function encrypt(plain: string): string {
  const key = tokenKey();
  if (!key) throw new Error("GOOGLE_TOKEN_KEY missing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

function decrypt(blob: string): string {
  const key = tokenKey();
  if (!key) throw new Error("GOOGLE_TOKEN_KEY missing");
  const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** The OAuth `state`: which uid started the dance, signed so the callback
 *  can't be pointed at someone else's account, expiring in 10 minutes. */
export function signState(uid: string, returnTo: string): string {
  const key = tokenKey();
  if (!key) throw new Error("GOOGLE_TOKEN_KEY missing");
  const payload = Buffer.from(
    JSON.stringify({ uid, returnTo, exp: Date.now() + 10 * 60_000, n: randomBytes(8).toString("hex") })
  ).toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string): { uid: string; returnTo: string } | null {
  const key = tokenKey();
  if (!key) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expect = createHmac("sha256", key).update(payload).digest("base64url");
  if (expect.length !== sig.length || expect !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.uid !== "string" || data.exp < Date.now()) return null;
    return { uid: data.uid, returnTo: typeof data.returnTo === "string" ? data.returnTo : "/mentor" };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* OAuth                                                               */
/* ------------------------------------------------------------------ */

export function connectUrl(state: string, origin: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    // Force the consent screen so a refresh token is issued every time —
    // Google only returns one on first consent otherwise.
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!res.ok) throw new Error(`google-token:${data.error ?? res.status}`);
  return data;
}

/** Email inside the id_token, without verifying it — it came straight from
 *  Google's token endpoint over TLS, and it's display-only. */
function emailFromIdToken(idToken?: string): string {
  if (!idToken) return "";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

/** Finish the connect: swap the code, store the refresh token. */
export async function completeConnect(uid: string, code: string, origin: string): Promise<void> {
  const tokens = await tokenRequest({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token) throw new Error("google-token:no-refresh-token");
  await adminDb()
    .collection(GOOGLE_TOKENS)
    .doc(uid)
    .set({
      refreshTokenEnc: encrypt(tokens.refresh_token),
      accessTokenEnc: encrypt(tokens.access_token),
      accessExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      email: emailFromIdToken(tokens.id_token),
      scope: tokens.scope ?? SCOPES,
      connectedAt: Date.now(),
    });
}

export interface CalendarConnection {
  connected: boolean;
  email: string;
}

export async function connectionStatus(uid: string): Promise<CalendarConnection> {
  const snap = await adminDb().collection(GOOGLE_TOKENS).doc(uid).get();
  const data = snap.data();
  return { connected: !!data?.refreshTokenEnc, email: typeof data?.email === "string" ? data.email : "" };
}

/** Revoke at Google (best effort) and forget the token. */
export async function disconnect(uid: string): Promise<void> {
  const ref = adminDb().collection(GOOGLE_TOKENS).doc(uid);
  const data = (await ref.get()).data();
  if (data?.refreshTokenEnc) {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(decrypt(data.refreshTokenEnc))}`, {
        method: "POST",
      });
    } catch {
      /* revoked or already gone — either way we drop it */
    }
  }
  await ref.delete();
}

/** A live access token for this mentor, refreshing if needed. Null when the
 *  mentor never connected (or their grant was revoked, in which case the
 *  stale doc is removed so the UI shows "connect" again). */
export async function accessTokenFor(uid: string): Promise<string | null> {
  if (!isCalendarConfigured()) return null;
  const ref = adminDb().collection(GOOGLE_TOKENS).doc(uid);
  const data = (await ref.get()).data();
  if (!data?.refreshTokenEnc) return null;

  if (data.accessTokenEnc && typeof data.accessExpiresAt === "number" && data.accessExpiresAt > Date.now()) {
    return decrypt(data.accessTokenEnc);
  }
  try {
    const tokens = await tokenRequest({
      refresh_token: decrypt(data.refreshTokenEnc),
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
    });
    await ref.set(
      {
        accessTokenEnc: encrypt(tokens.access_token),
        accessExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      },
      { merge: true }
    );
    return tokens.access_token;
  } catch (err) {
    if (String(err).includes("invalid_grant")) {
      await ref.delete();
      return null;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export interface EventInput {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  /** IANA zone the times are displayed in on the calendar. */
  timezone: string;
  /** Guest emails. Hidden from each other; the mentor sees all. */
  attendees: string[];
}

export interface EventResult {
  eventId: string;
  meetLink: string;
  htmlLink: string;
}

async function calendarFetch(token: string, url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`google-calendar:${res.status}:${text.slice(0, 200)}`);
  }
  return res;
}

function eventBody(input: EventInput) {
  return {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
    attendees: input.attendees.map((email) => ({ email })),
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
    reminders: { useDefault: true },
  };
}

/** Create the event with a Meet room attached. Guests are emailed. */
export async function createMeetEvent(token: string, input: EventInput): Promise<EventResult> {
  const url = `${CAL_BASE}?conferenceDataVersion=1&sendUpdates=all`;
  const res = await calendarFetch(token, url, {
    method: "POST",
    body: JSON.stringify({
      ...eventBody(input),
      conferenceData: {
        createRequest: {
          requestId: randomBytes(8).toString("hex"),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  });
  const ev = (await res.json()) as { id: string; hangoutLink?: string; htmlLink?: string };
  return { eventId: ev.id, meetLink: ev.hangoutLink ?? "", htmlLink: ev.htmlLink ?? "" };
}

/** Move / retitle. Guests are notified of the change. */
export async function updateEvent(
  token: string,
  eventId: string,
  input: Omit<EventInput, "attendees">
): Promise<void> {
  const { attendees: _drop, ...body } = eventBody({ ...input, attendees: [] });
  void _drop;
  await calendarFetch(token, `${CAL_BASE}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** Replace the guest list wholesale — enrollment is the source of truth. */
export async function setAttendees(token: string, eventId: string, emails: string[]): Promise<void> {
  await calendarFetch(token, `${CAL_BASE}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: "PATCH",
    body: JSON.stringify({ attendees: emails.map((email) => ({ email })) }),
  });
}

/** Cancel. Guests are notified. A 404 (already gone) is fine. */
export async function deleteEvent(token: string, eventId: string): Promise<void> {
  await calendarFetch(token, `${CAL_BASE}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: "DELETE",
  });
}
