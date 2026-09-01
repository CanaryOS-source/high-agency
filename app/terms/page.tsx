import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Use · High Agency",
  description: "The short set of rules for using the High Agency platform.",
};

const EFFECTIVE = "1 September 2026";
const CONTACT = "info@high-agency.io";

export default function TermsPage() {
  return (
    <main className="legal">
      <div className="wrap legal__inner">
        <Link href="/" className="brand">
          <span className="brand__mark" />
          HIGH&nbsp;AGENCY
        </Link>

        <h1>Terms of Use</h1>
        <p className="legal__meta">Effective {EFFECTIVE}</p>

        <p>
          These are the rules for using high-agency.io and the High Agency platform. By
          applying, creating an account, or joining a session you agree to them. Questions go
          to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>

        <h2>Who can use it</h2>
        <p>
          The program is for students aged 13 to 19. Members under 18 need a parent or
          guardian&apos;s consent, which we collect before their account can take part.
          Mentors are adults invited by High Agency.
        </p>

        <h2>Your account</h2>
        <p>
          Keep your sign-in link private and tell us if you think someone else has used your
          account. You are responsible for what is posted from it.
        </p>

        <h2>How to behave</h2>
        <p>
          Be honest about what you have built and what you have done. Treat your squad, your
          mentor, and everyone in a session with respect. Do not post anything illegal,
          hateful, or intended to harm someone, and do not share other members&apos; personal
          details. We may remove content or close accounts that break these rules.
        </p>

        <h2>Your work</h2>
        <p>
          What you build is yours. By posting on the platform you let High Agency show that
          content to your squad, your mentor, and staff so the program can run. If we want to
          feature your work publicly, we will ask you first.
        </p>

        <h2>Sessions</h2>
        <p>
          Workshops and check-ins run on Google Meet. Seats are limited; if you enroll and
          cannot make it, give the seat back so someone else can use it.
        </p>

        <h2>The service</h2>
        <p>
          High Agency is provided as is. We work hard to keep it running, but we cannot promise
          it will always be available or error-free, and we are not liable for losses that
          come from relying on it beyond what the law requires.
        </p>

        <h2>Changes</h2>
        <p>
          We may update these terms. If a change matters, we will tell members by email and
          update the date above.
        </p>

        <p className="legal__foot">
          High Agency · <a href={`mailto:${CONTACT}`}>{CONTACT}</a> ·{" "}
          <Link href="/privacy">Privacy policy</Link>
        </p>
      </div>
    </main>
  );
}
