/**
 * Server-only. A mentor confirming a squad check-in: put a time on it and,
 * when their Google Calendar is connected, create the event with a Meet room
 * and the whole squad on the guest list (hidden from each other). Without a
 * connection the mentor pastes a link, same as before.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebaseAdmin";
import { HttpError } from "./serverAuth";
import { accessTokenFor, createMeetEvent } from "./googleCalendar";

export interface ConfirmWire {
  cohortId: string;
  checkInId: string;
  /** ISO datetime. */
  startsAt: string;
  durationMins: number;
  meetLink?: string;
}

export async function confirmCheckIn(
  mentorUid: string,
  mentor: Record<string, unknown>,
  input: Partial<ConfirmWire>
): Promise<{ calendar: "linked" | "manual" }> {
  const cohortId = typeof input.cohortId === "string" ? input.cohortId : "";
  const checkInId = typeof input.checkInId === "string" ? input.checkInId : "";
  if (!cohortId || !checkInId) throw new HttpError(400, "bad-request");
  const startsAt = new Date(typeof input.startsAt === "string" ? input.startsAt : NaN);
  if (isNaN(startsAt.getTime())) throw new HttpError(400, "bad-start");
  const durationMins = Math.round(Number(input.durationMins));
  if (!(durationMins > 0 && durationMins <= 600)) throw new HttpError(400, "bad-duration");
  const manualLink =
    typeof input.meetLink === "string" && /^https?:\/\//i.test(input.meetLink.trim())
      ? input.meetLink.trim().slice(0, 500)
      : "";

  const db = adminDb();
  const cohortRef = db.collection("cohorts").doc(cohortId);
  const checkInRef = cohortRef.collection("checkIns").doc(checkInId);
  const [cohortSnap, checkInSnap] = await Promise.all([cohortRef.get(), checkInRef.get()]);
  const cohort = cohortSnap.data();
  const checkIn = checkInSnap.data();
  if (!cohort || !checkIn) throw new HttpError(404, "not-found");
  if (cohort.mentorUid !== mentorUid) throw new HttpError(403, "forbidden");
  if (checkIn.status !== "requested") throw new HttpError(409, "already-confirmed");

  let meetLink = manualLink;
  let calendarEventId = "";
  const token = await accessTokenFor(mentorUid);
  if (token) {
    const members: string[] = Array.isArray(cohort.memberUids) ? cohort.memberUids : [];
    const users = members.length
      ? (await adminAuth().getUsers(members.slice(0, 100).map((uid) => ({ uid })))).users
      : [];
    const ev = await createMeetEvent(token, {
      summary: `${String(cohort.name ?? "Squad")} · check-in`,
      description:
        `High Agency squad check-in with ${String(mentor.name ?? "your mentor")}.` +
        (checkIn.note ? `\n\nAsked for: ${String(checkIn.note)}` : ""),
      start: startsAt,
      end: new Date(startsAt.getTime() + durationMins * 60_000),
      timezone: String(mentor.timezone ?? "UTC"),
      attendees: users.map((u) => u.email).filter((e): e is string => !!e),
    });
    meetLink = ev.meetLink || meetLink;
    calendarEventId = ev.eventId;
  }

  await checkInRef.update({
    status: "confirmed",
    startsAt: Timestamp.fromDate(startsAt),
    durationMins,
    meetLink,
    ...(calendarEventId ? { calendarEventId } : {}),
    confirmedAt: FieldValue.serverTimestamp(),
  });
  return { calendar: calendarEventId ? "linked" : "manual" };
}
