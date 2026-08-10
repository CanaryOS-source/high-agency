/**
 * TEMPORARY — founding-batch access gate. Server-only.
 *
 * Sign-in-link email transport. Modelled directly on consentEmail.ts: same
 * Resend client, same EmailDelivery contract, same escaping, same brand.
 *
 * When RESEND_API_KEY is absent (local dev) we DON'T fail — the fully-formed
 * sign-in URL is logged to the server console so the whole magic-link flow is
 * testable against a "dev inbox" (the terminal). Delete alongside the rest of
 * the gate; see app/lib/accessGate.ts for the removal checklist.
 */
import { Resend } from "resend";
import type { EmailDelivery } from "./consentEmail";

export type { EmailDelivery };

/** Falls back to the consent sender so a single verified domain serves both
 *  flows — one less thing to configure before production. */
const FROM =
  process.env.ACCESS_EMAIL_FROM ??
  process.env.CONSENT_EMAIL_FROM ??
  "High Agency <onboarding@resend.dev>";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function signInHtml(signInUrl: string, name?: string): string {
  const greeting = name ? `${escapeHtml(name)}, you're in.` : "You're in.";
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#211d18;line-height:1.55">
    <h1 style="font-size:22px;margin:0 0 16px">${greeting}</h1>
    <p style="margin:0 0 14px">
      You're on the list for the <strong>High Agency</strong> founding batch — a live
      cohort program where you join a small squad, ship real milestones, and learn
      from people who've done it. Use the button below to sign in.
    </p>
    <p style="margin:0 0 28px">
      <a href="${signInUrl}"
         style="display:inline-block;background:#ff5a1e;color:#fff;text-decoration:none;
                font-weight:600;padding:13px 26px;border-radius:12px">
        Sign in to High Agency
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b645b">
      If the button doesn't work, paste this link into your browser:
    </p>
    <p style="margin:0 0 24px;font-size:13px;color:#6b645b;word-break:break-all">
      ${signInUrl}
    </p>
    <p style="margin:0;font-size:13px;color:#6b645b">
      This link is single-use and expires shortly. If you didn't ask to sign in,
      you can ignore this email — nothing happens until the link is opened.
    </p>
  </div>`;
}

export async function sendAccessEmail(params: {
  to: string;
  signInUrl: string;
  name?: string;
}): Promise<EmailDelivery> {
  const { to, signInUrl, name } = params;
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Dev inbox: the flow is fully exercisable without a provider secret.
    console.log(
      `[access] No RESEND_API_KEY set — would email ${to} a sign-in link.\n` +
        `[access] Sign-in link: ${signInUrl}`
    );
    return "logged";
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: "Your High Agency sign-in link",
    html: signInHtml(signInUrl, name),
  });
  if (error) {
    throw new Error(`Resend failed: ${error.message ?? String(error)}`);
  }
  return "sent";
}
