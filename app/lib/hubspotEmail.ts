/**
 * "You're in" email for a newly approved applicant. Server-only.
 *
 * OFF BY DEFAULT, AND THAT IS THE POINT. These are real 13–18 year olds, and
 * an approval flipped in a CRM should not be able to mail a minor before a
 * human has decided that is what happens. Nothing is sent unless
 * HUBSPOT_APPROVAL_EMAIL is exactly "on"; the default return is "off".
 *
 * Transport is the same Resend posture as consentEmail/accessEmail: when
 * RESEND_API_KEY is missing the message is logged instead, so the flow is
 * exercisable locally without a provider secret.
 *
 * Note what this email deliberately does NOT contain: a sign-in link. Access
 * still runs through /login, which mails a single-use link only to an address
 * on the allowlist. This is an announcement, not a credential.
 */
import { Resend } from "resend";
import type { EmailDelivery } from "./consentEmail";

/** "off" is a real outcome, not a failure — callers log it and move on. */
export type ApprovalDelivery = EmailDelivery | "off";

const FROM =
  process.env.ACCESS_EMAIL_FROM ??
  process.env.CONSENT_EMAIL_FROM ??
  "High Agency <onboarding@resend.dev>";

export function approvalEmailEnabled(): boolean {
  return process.env.HUBSPOT_APPROVAL_EMAIL === "on";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function approvalHtml(appUrl: string, firstName?: string): string {
  const greeting = firstName
    ? `${escapeHtml(firstName)}, you're in.`
    : "You're in.";
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#211d18;line-height:1.55">
    <h1 style="font-size:22px;margin:0 0 16px">${greeting}</h1>
    <p style="margin:0 0 14px">
      You've been accepted into the <strong>High Agency</strong> founding batch —
      a live cohort program where you join a small squad, ship real milestones,
      and learn from people who've actually done it.
    </p>
    <p style="margin:0 0 14px">
      Head to the sign-in page and enter this same email address. We'll send you
      a single-use link that gets you straight in — no password to remember.
    </p>
    <p style="margin:0 0 28px">
      <a href="${appUrl}/login"
         style="display:inline-block;background:#ff5a1e;color:#fff;text-decoration:none;
                font-weight:600;padding:13px 26px;border-radius:12px">
        Sign in to High Agency
      </a>
    </p>
    <p style="margin:0;font-size:13px;color:#6b645b">
      If you're under 18, we'll ask for a parent's email during setup so they can
      approve your account. That's a one-click step for them.
    </p>
  </div>`;
}

/**
 * Announce an approval. Returns "off" when the flag isn't set — which is the
 * default and the expected result in production until Sai turns it on.
 */
export async function sendApprovalEmail(params: {
  to: string;
  firstName?: string;
  appUrl: string;
}): Promise<ApprovalDelivery> {
  if (!approvalEmailEnabled()) return "off";

  const { to, firstName, appUrl } = params;
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Dev inbox. Only the address is logged, never the application answers.
    console.log(`[hubspot] No RESEND_API_KEY set — would email ${to} an approval.`);
    return "logged";
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: "You're in — High Agency founding batch",
    html: approvalHtml(appUrl.replace(/\/$/, ""), firstName),
  });
  if (error) {
    throw new Error(`Resend failed: ${error.message ?? String(error)}`);
  }
  return "sent";
}
