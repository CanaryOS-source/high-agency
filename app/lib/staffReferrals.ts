/**
 * Staff lead-source referral codes — roster and planning logic.
 *
 * PURE: no I/O, no Admin SDK, no env. Everything here is a total function of
 * its arguments so `scripts/staff-referrals.js` can be reasoned about — and
 * tested — without touching a real project. The script does the reading and
 * writing; this file only decides what SHOULD be true.
 *
 * The problem it solves: five people on the team need a referral link they can
 * put in a post today. Minting them an application would be a lie (they are not
 * applicants and do not belong in the queue), and minting them an account would
 * be worse (the founding-batch gate exists precisely to stop accounts appearing
 * for people who were never approved). So they get a counter and nothing else:
 * `referrals/{code}` with `kind: "staff"`, exactly the shape an incoming
 * `?ref=` already knows how to resolve and credit. See STAFF_COUNTER_KIND in
 * ./referral for why that document is inert as a queue position.
 *
 * This module is admin tooling data. It is imported by the provisioning script
 * and by tests/staffReferrals.test.mts — never by a client component, so the
 * roster never reaches a browser bundle.
 */
import { REFERRAL_CODE_RE, STAFF_COUNTER_KIND, STAFF_BASE_POS } from "./referral";

/**
 * Admin-only mapping collection, slug → code. Its whole job is idempotency:
 * without it a second run would mint a second code for the same person and
 * quietly split their attribution in two.
 *
 * Deny-all to clients (firestore.rules), same posture as `mentorInvites` and
 * `approvedMembers`. The public counter it points at carries no name and no
 * Slack id; those live here, where nobody but the Admin SDK can read them.
 */
export const STAFF_CODES_COLLECTION = "staffReferralCodes";

export interface StaffMember {
  /** Document id in STAFF_CODES_COLLECTION. Stable, human-readable, lowercase. */
  slug: string;
  /** Display name, for the terminal output and the link handover. */
  name: string;
  /** Slack member id — the stable identity the team already uses. */
  slackId: string;
}

/**
 * The approved roster. Adding a person here and re-running the script is the
 * whole provisioning process; everyone already provisioned is left untouched.
 *
 * Slug is derived from the name and then FROZEN — it is a document id, so
 * changing one orphans a mapping rather than renaming it. Rename the `name`
 * field freely; never the slug.
 */
export const STAFF_ROSTER: StaffMember[] = [
  { slug: "evelyn-qiao", name: "Evelyn Qiao", slackId: "U09CSHVBLBZ" },
  { slug: "dhairya-shah", name: "Dhairya Shah", slackId: "U09DFU5N5D4" },
  { slug: "mahathi-dharmavaram", name: "Mahathi (Mahi) Dharmavaram", slackId: "U09DC7UQMS8" },
  { slug: "kejun-liu", name: "Kejun Liu", slackId: "U09DU715ZFB" },
  { slug: "harish-ramasubramanian", name: "Harish Ramasubramanian", slackId: "U09E18UGD5E" },
];

/** Slack member ids are `U`/`W` plus 8–20 uppercase alphanumerics. */
const SLACK_ID_RE = /^[UW][A-Z0-9]{7,19}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The mapping document. `code` is the link between the two halves; everything
 * else is here so a person reading the Console can tell whose code it is
 * without cross-referencing Slack.
 */
export interface StaffMappingDoc {
  slug?: unknown;
  name?: unknown;
  slackId?: unknown;
  code?: unknown;
}

/** The public counter as it comes back from Firestore — every field unknown,
 *  because this is exactly where a hand-edited document would surface. */
export interface CounterDoc {
  code?: unknown;
  basePos?: unknown;
  confirmed?: unknown;
  credited?: unknown;
  kind?: unknown;
}

/**
 * What the script should do about one roster entry.
 *
 * `conflict` is a REFUSAL, never a repair: something in the database disagrees
 * with what this module says should be there, and overwriting it could detach
 * a code that is already printed in somebody's post. A human decides.
 */
export type StaffCodePlan =
  | { action: "create"; member: StaffMember }
  | { action: "exists"; member: StaffMember; code: string; confirmed: number }
  | { action: "conflict"; member: StaffMember; reason: string };

/** Guard the roster itself — a typo in a slug or a Slack id should fail before
 *  anything is written, not after three of five have been provisioned. */
export function validateRoster(roster: StaffMember[] = STAFF_ROSTER): string[] {
  const problems: string[] = [];
  const seenSlug = new Set<string>();
  const seenSlack = new Set<string>();

  for (const member of roster) {
    if (!SLUG_RE.test(member.slug)) {
      problems.push(`"${member.slug}" is not a valid slug (lowercase, hyphen-separated)`);
    }
    if (seenSlug.has(member.slug)) problems.push(`duplicate slug "${member.slug}"`);
    seenSlug.add(member.slug);

    if (!member.name.trim()) problems.push(`${member.slug} has no name`);

    if (!SLACK_ID_RE.test(member.slackId)) {
      problems.push(`${member.slug} has a Slack id that isn't one: "${member.slackId}"`);
    }
    if (seenSlack.has(member.slackId)) {
      problems.push(`duplicate Slack id "${member.slackId}"`);
    }
    seenSlack.add(member.slackId);
  }
  return problems;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Decide what to do about one roster entry, given whatever is currently in the
 * database for it.
 *
 * @param mapping  `staffReferralCodes/{slug}`, or null when absent.
 * @param counter  `referrals/{mapping.code}`, or null when absent. Ignored when
 *                 there is no mapping — there is nothing to look up yet.
 */
export function planStaffCode(
  member: StaffMember,
  mapping: StaffMappingDoc | null,
  counter: CounterDoc | null
): StaffCodePlan {
  if (!mapping) return { action: "create", member };

  const conflict = (reason: string): StaffCodePlan => ({
    action: "conflict",
    member,
    reason,
  });

  const code = typeof mapping.code === "string" ? mapping.code : "";
  if (!REFERRAL_CODE_RE.test(code)) {
    return conflict(
      `mapping exists but its code (${JSON.stringify(mapping.code)}) is not a ` +
        `valid referral code`
    );
  }

  // The Slack id is the IDENTITY check, so it has to be present and exact. A
  // mapping with no slackId — or a number, or a null someone typed in the
  // Console — proves nothing about whose code this is, and treating "can't
  // tell" as "matches" is how a code silently changes hands.
  if (typeof mapping.slackId !== "string" || !mapping.slackId) {
    return conflict(
      `mapping has no usable Slack id (${JSON.stringify(mapping.slackId)}), so ` +
        `there is nothing to prove it belongs to ${member.slug}`
    );
  }
  if (mapping.slackId !== member.slackId) {
    return conflict(
      `mapping is recorded against Slack id ${mapping.slackId}, the roster says ` +
        `${member.slackId}`
    );
  }
  // The slug is the document id, so a mismatch means the document was moved or
  // hand-edited — the pair no longer describes what its own id claims.
  if (mapping.slug !== undefined && mapping.slug !== member.slug) {
    return conflict(
      `mapping is stored at ${member.slug} but names slug ` +
        `${JSON.stringify(mapping.slug)}`
    );
  }

  if (!counter) {
    return conflict(
      `mapping points at referrals/${code}, which does not exist — the pair is ` +
        `half-written`
    );
  }
  if (counter.code !== code) {
    return conflict(
      `referrals/${code} carries code ${JSON.stringify(counter.code)} instead of ` +
        `its own id`
    );
  }
  if (counter.kind !== STAFF_COUNTER_KIND) {
    return conflict(
      `referrals/${code} is not a staff counter (kind=${JSON.stringify(counter.kind)}) ` +
        `— it may belong to a real applicant`
    );
  }
  if (num(counter.basePos) !== STAFF_BASE_POS) {
    return conflict(
      `referrals/${code} has basePos ${JSON.stringify(counter.basePos)}, expected ` +
        `${STAFF_BASE_POS} — a staff counter must have no queue position`
    );
  }

  // `confirmed` is the ONE number a staff counter means anything by, and it is
  // reported to a human deciding whether a link is working. A malformed value
  // must not be laundered into a confident 0 — that reads as "nobody clicked",
  // which is a different and much more actionable claim than "this counter is
  // broken".
  const confirmed = num(counter.confirmed);
  if (confirmed === undefined || confirmed < 0 || !Number.isInteger(confirmed)) {
    return conflict(
      `referrals/${code} has a confirmed count of ` +
        `${JSON.stringify(counter.confirmed)}, which is not a count`
    );
  }

  return { action: "exists", member, code, confirmed };
}

/** The mapping document to write for a freshly minted code. `createdAt` is an
 *  SDK sentinel the caller supplies, same reasoning as staffCounterFields. */
export function staffMappingFields<T>(
  member: StaffMember,
  code: string,
  createdAt: T
): { slug: string; name: string; slackId: string; code: string; createdAt: T } {
  return {
    slug: member.slug,
    name: member.name,
    slackId: member.slackId,
    code,
    createdAt,
  };
}
