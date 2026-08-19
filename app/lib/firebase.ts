import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from "firebase/firestore";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import {
  REFERRALS_COLLECTION,
  REFERRAL_MAX,
  effectivePos,
  newReferralCode,
  normalizeReferralCode,
  type ReferralCounter,
} from "./referral";

// Applicants notionally ahead of #1, so early queue numbers don't read
// "#1, #2" while the founding batch fills. Set to 0 for a true raw count.
const QUEUE_BASE = 46;

// Firebase web config is public by design, gating happens via Firestore
// security rules, not by hiding these keys. Values can be overridden per
// environment with NEXT_PUBLIC_FIREBASE_* vars; the literals are the default.
const firebaseConfig = {
  apiKey:
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??
    "AIzaSyAtO9pwIutE9v-nXOTs_wjzqSTLltNRA3k",
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??
    "highagency-62e67.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "highagency-62e67",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
    "highagency-62e67.firebasestorage.app",
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "273177671346",
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ??
    "1:273177671346:web:f1045e955d48c9ea4dfbab",
  measurementId:
    process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ?? "G-5ED8XF61EQ",
};

let app: FirebaseApp | undefined;
let db: Firestore | undefined;
let auth: Auth | undefined;

export function getDb(): Firestore {
  if (!app) app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  if (!db) db = getFirestore(app);
  return db;
}

export function getFirebaseAuth(): Auth {
  if (!app) app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  if (!auth) auth = getAuth(app);
  return auth;
}

export const googleProvider = new GoogleAuthProvider();

export const WAITLIST_COLLECTION = "applications";

export interface ApplicationInput {
  name: string;
  email: string;
  age: string;
  /** LinkedIn or personal site. Optional — empty string when not provided. */
  social: string;
  building: string;
  boldest: string;
  impact: string;
  problem: string;
  plan: string;
}

export interface ApplicationRecord extends ApplicationInput {
  opId: string;
  queuePos: number;
  submitted: true;
  ts: number;
  /** Firestore document id. Absent on the offline fallback record, and on
   *  records restored from localStorage that predate this field. Used only to
   *  tell the CRM sync which document to pick up. */
  docId?: string;
  /** This applicant's own share code — the doc id of their `referrals` counter.
   *  Absent on the offline fallback (no counter doc exists to back it) and on
   *  records saved before referrals shipped; the share UI hides itself then. */
  referralCode?: string;
  /** The code that brought them in, "" when they arrived on their own. */
  referredBy?: string;
}

/** Thrown inside the write transaction when a freshly minted code is taken. */
class CodeCollision extends Error {}

/** Codes are 30^6 ≈ 7e8, so this loop realistically never runs twice. */
const CODE_ATTEMPTS = 3;

/** True for the one failure that a rules deploy, not a bug, explains. */
function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "permission-denied";
}

interface SubmitResult {
  opId: string;
  queuePos: number;
  docId: string;
}

/**
 * One attempt at the whole write. `code` is null for the referral-free
 * variant — see the fallback in submitApplication.
 */
async function writeApplication(
  db: Firestore,
  input: ApplicationInput,
  code: string | null,
  referredBy: string
): Promise<SubmitResult> {
  const col = collection(db, WAITLIST_COLLECTION);
  // Single public counter doc — the only readable thing under meta. Application
  // docs stay create-only so applicant PII is never exposed. The transaction
  // makes the position monotonic even under concurrent submissions.
  const counterRef = doc(db, "meta", "waitlist");
  const myCounterRef = code ? doc(db, REFERRALS_COLLECTION, code) : null;
  const referrerRef =
    code && referredBy ? doc(db, REFERRALS_COLLECTION, referredBy) : null;

  return runTransaction(db, async (tx) => {
    // Firestore requires every read before any write in a transaction.
    const snap = await tx.get(counterRef);
    const mine = myCounterRef ? await tx.get(myCounterRef) : null;
    const referrer = referrerRef ? await tx.get(referrerRef) : null;

    // A code that already exists belongs to somebody else — reusing it would
    // quietly hand this applicant's referrals away. Refuse and re-roll.
    if (mine?.exists()) throw new CodeCollision();

    const current = (snap.exists() ? snap.data().count : 0) || 0;
    const pos = QUEUE_BASE + current + 1;
    const id = "HA-" + String(pos).padStart(3, "0");

    const appRef = doc(col); // new auto-id within the create-only collection
    tx.set(appRef, {
      // name/email/age/building/boldest keep their original names so the
      // applications already on record stay readable alongside the new ones.
      name: input.name,
      email: input.email,
      age: input.age,
      social: input.social,
      building: input.building,
      boldest: input.boldest,
      impact: input.impact,
      problem: input.problem,
      plan: input.plan,
      opId: id,
      queuePos: pos,
      // Attribution lives here, on the private doc, not on the public counter
      // — a readable referral graph is not worth the exposure.
      ...(code ? { referralCode: code, referredBy } : {}),
      createdAt: serverTimestamp(),
      source: "waitlist",
    });
    tx.set(
      counterRef,
      { count: current + 1, updatedAt: serverTimestamp() },
      { merge: true }
    );

    if (myCounterRef && code) {
      // The applicant's own public counter. `pos` is denormalised so the share
      // screen renders from exactly one document read.
      tx.set(myCounterRef, {
        code,
        opId: id,
        basePos: pos,
        confirmed: 0,
        credited: 0,
        pos,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    // Credit the referrer. A code pointing at nothing (mistyped, or from a
    // deleted counter) is simply not credited — never a failed signup.
    if (referrerRef && referrer?.exists()) {
      const data = referrer.data();
      const basePos = typeof data.basePos === "number" ? data.basePos : pos;
      const confirmed =
        (typeof data.confirmed === "number" ? data.confirmed : 0) + 1;
      const credited = Math.min(
        (typeof data.credited === "number" ? data.credited : 0) + 1,
        REFERRAL_MAX
      );
      tx.update(referrerRef, {
        confirmed,
        credited,
        pos: effectivePos(basePos, credited),
        updatedAt: serverTimestamp(),
      });
    }

    return { opId: id, queuePos: pos, docId: appRef.id };
  });
}

/**
 * Persist a founding-batch application to Firestore and, in the same
 * transaction, mint the applicant's referral counter and credit whoever
 * referred them.
 *
 * The queue position is the real number of applications on record
 * (QUEUE_BASE + existing count + 1), not a random value, so it's stable and
 * grows by one with each genuine signup. Referrals then subtract from it —
 * see `effectivePos` in ./referral for why that is arithmetic rather than a
 * re-sort of the queue.
 *
 * Cost: 2 reads (3 when referred), 4 writes, one round trip. There is no query
 * and no fan-out anywhere in the referral path, so this stays flat as the
 * waitlist grows.
 *
 * Returns the local record used to render the success step. Throws on write
 * failure so the caller can fall back gracefully.
 */
export async function submitApplication(
  input: ApplicationInput,
  /** Raw `?ref=` value; anything that isn't a well-formed code is ignored. */
  referredByRaw = ""
): Promise<ApplicationRecord> {
  const db = getDb();
  const referredBy = normalizeReferralCode(referredByRaw);

  for (let attempt = 0; ; attempt++) {
    const code = newReferralCode();
    try {
      const result = await writeApplication(db, input, code, referredBy);
      return {
        ...input,
        ...result,
        referralCode: code,
        referredBy,
        submitted: true,
        ts: Date.now(),
      };
    } catch (err) {
      if (err instanceof CodeCollision && attempt < CODE_ATTEMPTS - 1) continue;

      // The referral collection is newer than the rest of this write path, so
      // the one failure worth surviving is a ruleset that predates it: without
      // this, a rules file that hasn't been deployed yet would turn every
      // application into a local-only fallback record. Drop the referral half
      // and keep the signup — the success screen already hides the share block
      // when there's no code behind it.
      if (isPermissionDenied(err)) {
        console.warn(
          "[waitlist] referral write denied — is firestore.rules deployed? " +
            "Falling back to a referral-free application."
        );
        const result = await writeApplication(db, input, null, "");
        return { ...input, ...result, submitted: true, ts: Date.now() };
      }
      throw err;
    }
  }
}

/**
 * Live referral standing for one code — the single read behind the share
 * screen. Returns null for an unknown or malformed code, and never throws:
 * the caller is always a UI that has something to show without it.
 */
export async function fetchReferralCounter(
  rawCode: string
): Promise<ReferralCounter | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  try {
    const snap = await getDoc(doc(getDb(), REFERRALS_COLLECTION, code));
    if (!snap.exists()) return null;
    const d = snap.data();
    const basePos = typeof d.basePos === "number" ? d.basePos : 0;
    const credited = typeof d.credited === "number" ? d.credited : 0;
    return {
      code,
      opId: typeof d.opId === "string" ? d.opId : "",
      basePos,
      confirmed: typeof d.confirmed === "number" ? d.confirmed : 0,
      credited,
      // Trust the stored position, but fall back to the arithmetic if a doc
      // predates the field or was written by hand.
      pos: typeof d.pos === "number" ? d.pos : effectivePos(basePos, credited),
    };
  } catch {
    return null;
  }
}
