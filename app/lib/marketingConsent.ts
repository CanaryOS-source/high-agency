/**
 * Optional marketing consent — the shared vocabulary.
 *
 * Pure and dependency-free for the same reason app/lib/referral.ts is: the
 * apply form, the Firestore write path, the HubSpot mapping and the rules
 * tests all have to agree on the field names and on what a granted consent
 * looks like, and a fourth copy of "marketingConsentSource" spelled slightly
 * differently is exactly the kind of drift that only shows up in production.
 *
 * IMPORTANT — this records an INTENTION, it does not subscribe anybody to
 * anything. There is no sender, no list, no campaign and no automation behind
 * it (see docs/hubspot-integration.md). The value of writing it down now is
 * that when a campaign is eventually configured, the people who said yes are
 * already distinguishable from the people who were never asked.
 */

/** Where a consent was collected. The only source today is the public form. */
export const MARKETING_CONSENT_SOURCE = "waitlist";

/**
 * The source is checked for EXACT equality, not for length, in three places
 * that must agree: here, `firestore.rules` (which cannot import, so it spells
 * `'waitlist'` out), and the mapping. `tests/referral.test.mts` pins the
 * literal to this constant so a rename that lands in only one of them fails.
 */

/**
 * The checkbox copy, in one place so the form, the docs and any future
 * preference-centre render the same promise. Deliberately concise: what we'd
 * send, and that leaving is always possible.
 */
export const MARKETING_CONSENT_LABEL =
  "Email me High Agency updates and future cohort opportunities.";
export const MARKETING_CONSENT_HINT =
  "Optional — this has no effect on your application. Unsubscribe anytime.";

/**
 * The consent fields to merge into an application document.
 *
 * A granted consent carries WHEN and WHERE, because a bare `true` is not
 * evidence of anything a year from now. A declined one is stored as a plain
 * `false` with no timestamp: recording that the box was shown and left
 * unchecked is worth keeping, but there is no event to date-stamp.
 *
 * `timestamp` is supplied by the caller (a `serverTimestamp()` sentinel on the
 * real write path) so this file needs no Firebase import and stays testable.
 */
export function marketingConsentFields<T>(
  granted: boolean,
  timestamp: T
): { marketingConsent: boolean } & Partial<{
  marketingConsentAt: T;
  marketingConsentSource: string;
}> {
  if (!granted) return { marketingConsent: false };
  return {
    marketingConsent: true,
    marketingConsentAt: timestamp,
    marketingConsentSource: MARKETING_CONSENT_SOURCE,
  };
}

/**
 * What a stored application actually proves about marketing consent.
 *
 *   `granted`  — opted in, WITH coherent proof: a resolvable timestamp and the
 *                exact source this form writes.
 *   `declined` — asked, said no.
 *   `unknown`  — never asked (every application that predates the checkbox), OR
 *                a `true` whose proof does not hold up.
 *
 * **That last case is the point of this function.** `firestore.rules` refuses
 * to store an opt-in without both proofs, so an incoherent one should not
 * exist — but "should not exist" is not a thing to bet a person's inbox on. A
 * record whose proof is missing, malformed, or from a source we do not
 * recognise is reported as `unknown`, never as `granted`: the failure mode of
 * treating a corrupt row as consent is mailing somebody who never agreed, and
 * the failure mode of the reverse is a blank field a human can look into.
 *
 * `consentedOn` is the timestamp already normalized by the caller (a date
 * string, or undefined when it could not be read) — passing it in is what
 * keeps this module free of any date/Firestore dependency.
 */
export type MarketingConsentState = "granted" | "declined" | "unknown";

export function marketingConsentState(
  consent: unknown,
  source: unknown,
  consentedOn: string | undefined
): MarketingConsentState {
  if (typeof consent !== "boolean") return "unknown";
  if (!consent) return "declined";
  if (source !== MARKETING_CONSENT_SOURCE) return "unknown";
  if (!consentedOn) return "unknown";
  return "granted";
}
