/**
 * Ops email transport. Server-only.
 *
 * Same posture as consentEmail.ts and the same FROM address: Resend when
 * RESEND_API_KEY is set, otherwise the message is logged to the server console
 * so the flow is exercisable end-to-end without a provider secret. The one
 * consumer today is the daily unassigned-squads sweep — a squad sitting with
 * no mentor is a product failure that must reach a human, not a dashboard
 * nobody opens.
 */
import { Resend } from "resend";
import type { EmailDelivery } from "./consentEmail";

const FROM =
  process.env.CONSENT_EMAIL_FROM ?? "High Agency <onboarding@resend.dev>";

/** Where operational alerts land. Overridable, but this is the crew inbox. */
export const OPS_EMAIL_TO = process.env.OPS_EMAIL_TO ?? "info@high-agency.io";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface StaleSquad {
  id: string;
  name: string;
  mission: string;
  members: number;
  daysWaiting: number;
}

function staleSquadsHtml(squads: StaleSquad[], appUrl: string): string {
  const rows = squads
    .map(
      (s) => `
      <tr>
        <td style="padding:10px 12px;border-top:1px solid #e6e0d7">
          <a href="${appUrl}/cohorts/${encodeURIComponent(s.id)}"
             style="color:#211d18;font-weight:600;text-decoration:none">${escapeHtml(s.name)}</a>
          <div style="font-size:13px;color:#6b645b">${escapeHtml(s.mission)}</div>
        </td>
        <td style="padding:10px 12px;border-top:1px solid #e6e0d7;white-space:nowrap;font-size:13px;color:#6b645b">
          ${s.members} member${s.members === 1 ? "" : "s"}
        </td>
        <td style="padding:10px 12px;border-top:1px solid #e6e0d7;white-space:nowrap;font-size:13px;color:#6b645b">
          ${s.daysWaiting}d waiting
        </td>
      </tr>`
    )
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#211d18;line-height:1.55">
    <h1 style="font-size:20px;margin:0 0 8px">
      ${squads.length} squad${squads.length === 1 ? "" : "s"} still without a mentor
    </h1>
    <p style="margin:0 0 18px;color:#6b645b;font-size:14px">
      Each has been waiting more than a week. A squad can't activate — or clear
      milestones 4–7 — until a mentor adopts it in /admin → Squads.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
    <p style="margin:22px 0 0">
      <a href="${appUrl}/admin"
         style="display:inline-block;background:#ff5a1e;color:#fff;text-decoration:none;
                font-weight:600;padding:11px 22px;border-radius:12px">
        Open the feed
      </a>
    </p>
  </div>`;
}

/** One summary email for the whole sweep — never one per squad. */
export async function sendStaleSquadsEmail(params: {
  squads: StaleSquad[];
  appUrl: string;
}): Promise<EmailDelivery> {
  const { squads, appUrl } = params;
  const subject = `${squads.length} High Agency squad${
    squads.length === 1 ? "" : "s"
  } waiting on a mentor`;
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      `[ops] No RESEND_API_KEY set — would email ${OPS_EMAIL_TO}: ${subject}\n` +
        squads
          .map((s) => `[ops]   ${s.name} (${s.id}) — ${s.daysWaiting}d, ${s.members} members`)
          .join("\n")
    );
    return "logged";
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM,
    to: OPS_EMAIL_TO,
    subject,
    html: staleSquadsHtml(squads, appUrl),
  });
  if (error) {
    throw new Error(`Resend failed: ${error.message ?? String(error)}`);
  }
  return "sent";
}
