import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · High Agency",
  description: "What High Agency collects, why, and how to get it removed.",
};

const EFFECTIVE = "1 September 2026";
const CONTACT = "info@high-agency.io";

/** Public, static, no sign-in. Linked from the waitlist footer and from the
 *  Google OAuth consent screen (Google requires a public policy URL for any
 *  app that touches Calendar). Keep it honest and specific: every collection
 *  named here exists in the codebase, and nothing collected is left out. */
export default function PrivacyPage() {
  return (
    <main className="legal">
      <div className="wrap legal__inner">
        <Link href="/" className="brand">
          <span className="brand__mark" />
          HIGH&nbsp;AGENCY
        </Link>

        <h1>Privacy Policy</h1>
        <p className="legal__meta">Effective {EFFECTIVE}</p>

        <p>
          High Agency is a live cohort program for ambitious students aged 13 to 19. This
          policy explains what we collect when you use high-agency.io and the High Agency
          platform, what we do with it, and how to get it removed. If anything here is
          unclear, write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>

        <h2>What we collect</h2>
        <h3>When you apply to the waitlist</h3>
        <p>
          Your name, email address, age, and your answers to the application questions. If
          you arrived through a referral link, we record which code referred you. If you tick
          the optional marketing box, we record that you did and when.
        </p>
        <h3>When you have an account</h3>
        <p>
          We sign you in with your email address. Your public profile, visible to other
          signed-in members, holds only your first name and last initial, an age band (13–15,
          16–17, or 18+), your country and timezone, and what you tell us about what you are
          building. Your exact date of birth, full name, city, and a parent&apos;s email
          address are stored separately and are visible only to you and to High Agency staff.
        </p>
        <h3>When you use the platform</h3>
        <p>
          What you and your squad do on the platform: squads you create or apply to, build
          logs you post, the steps your mentor records on your squad&apos;s track, check-ins
          you request, workshops you enroll in, and your streak. Squad content is visible to
          your squad members, your mentor, and High Agency staff.
        </p>
        <h3>If you are under 18</h3>
        <p>
          We ask for a parent or guardian&apos;s email address and send them a consent link.
          Until they approve, your account can read the platform but cannot post, apply, or
          join a squad. A parent or guardian can withdraw consent at any time by writing to
          us, and we will close the account.
        </p>

        <h2>Google Calendar (mentors)</h2>
        <p>
          Mentors may connect their Google account so that the workshops and squad check-ins
          they schedule appear on their Google Calendar with a Google Meet room. When a mentor
          connects, we ask Google for permission to manage calendar events
          (<code>calendar.events</code>) and to see the email address of the connected
          account.
        </p>
        <ul>
          <li>
            We use this access only to create, update, and cancel the events High Agency
            schedules, and to add or remove the students who enroll in them as guests. We do
            not read, store, or display any other event on the mentor&apos;s calendar.
          </li>
          <li>
            Students who enroll in a workshop are added to the event as guests using the
            email address they sign in with. Guests cannot see each other&apos;s email
            addresses; the hosting mentor can.
          </li>
          <li>
            We store the mentor&apos;s Google refresh token encrypted on our servers so we do
            not have to ask again. A mentor can disconnect at any time from their profile
            page, which revokes the token at Google and deletes our copy.
          </li>
          <li>
            High Agency&apos;s use of information received from Google APIs adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. We never sell this data or use it for
            advertising.
          </li>
        </ul>

        <h2>How we use it</h2>
        <ul>
          <li>To run the program: form squads, match you with a mentor, schedule sessions.</li>
          <li>To contact you about your application, your account, and the sessions you join.</li>
          <li>To obtain and record parental consent for members under 18.</li>
          <li>To keep the platform safe, which includes letting staff review squad content.</li>
        </ul>
        <p>We do not sell personal information and we do not show advertising.</p>

        <h2>Who processes it for us</h2>
        <p>
          We rely on a small number of providers to run the service: Google Firebase (sign-in
          and database), Vercel (hosting), Resend (transactional email), HubSpot (keeping track
          of waitlist applicants), and Google Calendar for mentors who connect it. Each
          processes data only to provide its service to us.
        </p>

        <h2>How long we keep it</h2>
        <p>
          For as long as you have an account or a live application. Ask us to delete your
          account and we will remove your profile, your private details, and your posts within
          30 days. We may keep records we are required to keep, such as a parent&apos;s consent
          or withdrawal of it.
        </p>

        <h2>Your rights</h2>
        <p>
          You, or your parent or guardian, can ask what we hold about you, ask us to correct
          it, or ask us to delete it. Write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from
          the email address on the account and we will respond within 30 days.
        </p>

        <h2>Changes</h2>
        <p>
          If we change this policy in a way that matters, we will tell members by email and
          update the date at the top of this page.
        </p>

        <p className="legal__foot">
          High Agency · <a href={`mailto:${CONTACT}`}>{CONTACT}</a> ·{" "}
          <Link href="/terms">Terms of use</Link>
        </p>
      </div>
    </main>
  );
}
