"use client";

/* Shared data + guard for the mentor app. Every mentor screen reads from
   here so the queues are defined once and can't drift between Home and the
   surface that actually works them. */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";
import type { Unsubscribe } from "firebase/firestore";
import { useAuth } from "./AuthProvider";
import {
  watchMentoredCohorts,
  watchUnassignedCohorts,
  watchCheckIns,
  watchSubmissions,
  watchPendingConsent,
  UNASSIGNED_SCAN_LIMIT,
  CONSENT_QUEUE_LIMIT,
  type ListenerErrorHandler,
} from "../lib/db";
import { milestone } from "../lib/milestones";
import type {
  Cohort,
  CheckIn,
  MilestoneSubmission,
  Profile,
} from "../lib/types";
import type { Milestone } from "../lib/milestones";

/** Route guard for every /mentor screen. Signed out → login. Signed in with
 *  no profile → onboarding. Signed in as an operator → the operator app,
 *  because none of this is theirs. Returns null-ish while resolving so pages
 *  can bail out with one check. */
export function useMentorGate(): { user: User | null; profile: Profile | null } {
  const { user, profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (user && profile === null) router.replace("/onboarding");
    else if (profile && profile.role !== "mentor") router.replace("/dashboard");
  }, [user, profile, router]);

  if (!user || !profile || profile.role !== "mentor") {
    return { user: null, profile: null };
  }
  return { user, profile };
}

export interface CheckInRequest {
  cohort: Cohort;
  checkIn: CheckIn;
}

export interface VerifyItem {
  cohort: Cohort;
  submission: MilestoneSubmission;
  milestone: Milestone;
}

export interface MentoredSquads {
  /** Squads this mentor owns. */
  mine: Cohort[];
  /** Still resolving the first snapshot. */
  loading: boolean;
  /** Check-ins per squad, keyed by cohort id. */
  checkIns: Record<string, CheckIn[]>;
  /** Outstanding "we want time" requests across every owned squad, oldest first. */
  requests: CheckInRequest[];
  /** Submissions waiting on *this mentor* — milestones 4–7 only. Peer-lead
   *  milestones (1–3) are the squad's own job and never surface here. */
  verifyQueue: VerifyItem[];
  /** Confirmed check-ins still ahead, soonest first. */
  upcomingCheckIns: CheckInRequest[];
}

/** Just the squads a mentor owns — one listener, no children. For surfaces
 *  that need the roster but not the queues hanging off it. */
export function useMentoredSquadList(mentorUid: string | null): {
  mine: Cohort[];
  loading: boolean;
} {
  const [mine, setMine] = useState<Cohort[] | null>(null);

  useEffect(() => {
    if (!mentorUid) return;
    return watchMentoredCohorts(mentorUid, setMine);
  }, [mentorUid]);

  return { mine: useMemo(() => mine ?? [], [mine]), loading: mine === null };
}

/** Everything hanging off the squads a mentor owns. One subscription per
 *  squad — mentors hold a handful, and going per-squad keeps every read on
 *  the squad-scoped rules the squad page already uses (no collection-group
 *  query, no extra index). */
export function useMentoredSquads(mentorUid: string | null): MentoredSquads {
  const { mine: squads, loading } = useMentoredSquadList(mentorUid);
  const [checkIns, setCheckIns] = useState<Record<string, CheckIn[]>>({});
  const [subs, setSubs] = useState<Record<string, MilestoneSubmission[]>>({});
  const [now] = useState(() => Date.now());

  // Keyed on the ids rather than the array so an unrelated field changing on
  // a squad doesn't tear down and rebuild every child listener.
  const ids = squads.map((c) => c.id).join(",");

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    const unsubs: Unsubscribe[] = [];

    /* The adopt race.
     *
     * `watchMentoredCohorts` fires from Firestore's local cache the instant
     * adoptCohort() writes — before the server has the write. The squad shows
     * up here, we attach its check-in listener, and the rules evaluate
     * `isCohortMentor` against a server-side doc that still has no mentorUid.
     * The listener is denied, and a denied listener is torn down permanently
     * by the SDK: the queue would stay empty until a full reload.
     *
     * So: re-attach on permission-denied, backing off, a few times. Everything
     * else (a real denial, a mentor who genuinely can't read this squad) gives
     * up quietly rather than looping. */
    const attach = <T>(
      make: (onData: (v: T) => void, onError: ListenerErrorHandler) => Unsubscribe,
      onData: (v: T) => void,
      tries = 0
    ): void => {
      unsubs.push(
        make(onData, (e) => {
          if (cancelled || e.code !== "permission-denied" || tries >= 3) return;
          setTimeout(() => {
            if (!cancelled) attach(make, onData, tries + 1);
          }, 400 * 2 ** tries);
        })
      );
    };

    for (const id of ids.split(",")) {
      attach<CheckIn[]>(
        (onData, onError) => watchCheckIns(id, onData, onError),
        (list) => setCheckIns((p) => ({ ...p, [id]: list }))
      );
      attach<MilestoneSubmission[]>(
        (onData, onError) => watchSubmissions(id, onData, onError),
        (list) => setSubs((p) => ({ ...p, [id]: list }))
      );
    }

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [ids]);

  const requests = useMemo(
    () =>
      squads
        .flatMap((c) =>
          (checkIns[c.id] ?? [])
            .filter((k) => k.status === "requested")
            .map((k) => ({ cohort: c, checkIn: k }))
        )
        .sort(
          (a, b) =>
            (a.checkIn.createdAt?.toMillis() ?? 0) -
            (b.checkIn.createdAt?.toMillis() ?? 0)
        ),
    [squads, checkIns]
  );

  const upcomingCheckIns = useMemo(
    () =>
      squads
        .flatMap((c) =>
          (checkIns[c.id] ?? [])
            .filter(
              (k) =>
                k.status === "confirmed" &&
                k.startsAt &&
                k.startsAt.toDate().getTime() > now
            )
            .map((k) => ({ cohort: c, checkIn: k }))
        )
        .sort(
          (a, b) =>
            a.checkIn.startsAt!.toDate().getTime() -
            b.checkIn.startsAt!.toDate().getTime()
        ),
    [squads, checkIns, now]
  );

  const verifyQueue = useMemo(
    () =>
      squads
        .flatMap((c) =>
          (subs[c.id] ?? [])
            .filter((s) => s.status === "submitted")
            .map((s) => ({ cohort: c, submission: s, milestone: milestone(s.milestoneId) }))
        )
        .filter(
          (x): x is VerifyItem => !!x.milestone && x.milestone.verifier === "mentor"
        )
        .sort(
          (a, b) =>
            (a.submission.createdAt?.toMillis() ?? 0) -
            (b.submission.createdAt?.toMillis() ?? 0)
        ),
    [squads, subs]
  );

  return { mine: squads, loading, checkIns, requests, verifyQueue, upcomingCheckIns };
}

export interface UnassignedFeed {
  squads: Cohort[] | null;
  /** The scan window filled up, so there may be older squads not shown. */
  truncated: boolean;
}

/** Squads with nobody looking after them — the adoption feed. */
export function useUnassignedSquads(enabled: boolean): UnassignedFeed {
  const [squads, setSquads] = useState<Cohort[] | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    return watchUnassignedCohorts((list) => {
      setSquads(list);
      // The watcher scans a bounded window of the newest squads; a full
      // window means older ones may exist beyond it.
      setTruncated(list.length >= UNASSIGNED_SCAN_LIMIT);
    });
  }, [enabled]);

  return { squads, truncated };
}

export interface ConsentQueue {
  pending: Profile[] | null;
  /** The queue is capped — there are likely more behind these. */
  truncated: boolean;
}

/** Minors waiting on a parent's OK. Capped; see CONSENT_QUEUE_LIMIT. */
export function useConsentQueue(enabled: boolean): ConsentQueue {
  const [pending, setPending] = useState<Profile[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return watchPendingConsent(setPending);
  }, [enabled]);

  const sorted = useMemo(
    () =>
      pending
        ? [...pending].sort((a, b) => {
            // Longest-waiting first: never-emailed at the top, then oldest send.
            const at = a.consentEmailSentAt?.toMillis() ?? 0;
            const bt = b.consentEmailSentAt?.toMillis() ?? 0;
            return at - bt || a.name.localeCompare(b.name);
          })
        : null,
    [pending]
  );

  return {
    pending: sorted,
    truncated: (pending?.length ?? 0) >= CONSENT_QUEUE_LIMIT,
  };
}
