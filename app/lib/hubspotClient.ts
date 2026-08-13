/**
 * Browser half of the HubSpot sync — one fire-and-forget ping.
 *
 * Kept out of firebase.ts and db.ts on purpose: those are the permanent data
 * layer, and this file is the CRM's only foothold in the client. If HubSpot is
 * ever dropped, deleting the `hubspot*` files and the one call site in
 * ApplyModal is the whole removal.
 *
 * It CANNOT fail in a way the applicant sees. No return value, no throw, no
 * await required: the server route answers 200 even when HubSpot is
 * unconfigured, and if the request never lands at all the cron reconcile picks
 * the application up on its next pass.
 */

/** Tell the server a fresh application is ready to push to the CRM. */
export function notifyHubspotApplication(applicationId: string | undefined): void {
  if (!applicationId) return;
  try {
    void fetch("/api/hubspot/application", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId }),
      // Survives the modal advancing to the success step / a fast navigation.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Nothing to do and nothing to report — the cron is the backstop.
  }
}
