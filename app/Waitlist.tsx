"use client";

import { useCallback, useEffect, useState } from "react";
import Reveal from "./components/Reveal";
import Counter from "./components/Counter";
import Marquee from "./components/Marquee";
import Faq from "./components/Faq";
import ApplyModal from "./components/ApplyModal";
import { CheckIcon, FlameIcon, SquadIcon, ZapIcon } from "./components/ui";
import AsciiCanvas from "./components/ascii/AsciiCanvas";
import VideoAscii from "./components/ascii/VideoAscii";
import rocketLaunch from "./components/ascii/programs/rocketLaunch";
import waitingRoom from "./components/ascii/programs/waitingRoom";
import trajectory from "./components/ascii/programs/trajectory";
import engineBurn from "./components/ascii/programs/engineBurn";
import { PLATFORM_ENABLED } from "./lib/flags";
import { fetchReferralCounter } from "./lib/firebase";
import {
  REFERRAL_JUMP,
  REFERRAL_PARAM,
  isStaffCounter,
  normalizeReferralCode,
} from "./lib/referral";

const APPLICATION_KEY = "ha_application";
const REFERRAL_KEY = "ha_ref";

/**
 * Resolve the referral code this visitor arrived on, once, on mount.
 *
 * Read straight off `window.location` rather than through `useSearchParams`:
 * this component is the whole marketing page, and that hook would drop the
 * entire tree out of the prerender (see the Suspense note in the Next docs for
 * useSearchParams). A code in the URL is a client-only concern — the static
 * HTML is identical either way.
 *
 * The code survives in sessionStorage so it still applies after the visitor
 * has clicked around the page, and the query string is scrubbed from the URL
 * so nobody re-shares a link that credits someone else.
 */
interface IncomingReferral {
  /** "" until a code has actually resolved against a counter document. */
  code: string;
  /** True for a staff lead-source code — see STAFF_COUNTER_KIND in ./lib/referral.
   *  A staff code brings people in but has no queue position of its own, so the
   *  banner must not promise their "referrer" a jump that cannot happen. */
  staff: boolean;
}

function useReferralCode(): IncomingReferral {
  const [ref, setRef] = useState<IncomingReferral>({ code: "", staff: false });

  useEffect(() => {
    let live = true;
    let incoming = "";
    try {
      const url = new URL(window.location.href);
      incoming = normalizeReferralCode(url.searchParams.get(REFERRAL_PARAM));
      if (!incoming) incoming = normalizeReferralCode(sessionStorage.getItem(REFERRAL_KEY));
      if (url.searchParams.has(REFERRAL_PARAM)) {
        url.searchParams.delete(REFERRAL_PARAM);
        window.history.replaceState(null, "", url.toString());
      }
    } catch {
      return;
    }
    if (!incoming) return;

    // Nobody refers themselves. The saved receipt knows this visitor's own
    // code, so the loop is closed before it ever reaches Firestore.
    try {
      const saved = JSON.parse(localStorage.getItem(APPLICATION_KEY) || "null");
      if (saved?.referralCode === incoming) return;
    } catch {}

    // One read, and only for a visitor who actually followed a link: an
    // unknown code must not put a banner on the page promising a boost that
    // the write path would then decline to give.
    fetchReferralCounter(incoming).then((counter) => {
      if (!live || !counter) return;
      try {
        sessionStorage.setItem(REFERRAL_KEY, incoming);
      } catch {}
      setRef({ code: incoming, staff: isStaffCounter(counter) });
    });

    return () => {
      live = false;
    };
  }, []);

  return ref;
}

/** The "you were invited" line. Renders nothing until a code has resolved. */
function ReferralBanner({ code, staff }: IncomingReferral) {
  if (!code) return null;
  return (
    <Reveal className="invited" d={1}>
      <span className="invited__mark" aria-hidden="true" />
      <span>
        <b>You were invited.</b>{" "}
        {staff
          ? // A staff code has no queue position, so there is nothing to promise
            // on their behalf. Say the true thing instead of the generic one.
            "Someone on the High Agency team sent you this link."
          : `Apply and your referrer moves up ${REFERRAL_JUMP} places.`}
      </span>
    </Reveal>
  );
}

function CaptureForm({
  label,
  onApply,
}: {
  label: string;
  onApply: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  return (
    <form
      className="capture"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(email.trim());
      }}
    >
      <div className="capture__field">
        {/* Password-manager extensions rewrite autocomplete on email fields
            before React hydrates; the mismatch is attribute-only noise. */}
        <input
          type="email"
          name="email"
          placeholder="you@email.com"
          autoComplete="email"
          aria-label="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          suppressHydrationWarning
        />
      </div>
      <button type="submit" className="btn btn--primary">
        {label}
      </button>
    </form>
  );
}

export default function Waitlist() {
  const [modalOpen, setModalOpen] = useState(false);
  const [prefillEmail, setPrefillEmail] = useState("");
  const [applied, setApplied] = useState(false);
  const incoming = useReferralCode();

  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(APPLICATION_KEY) || "null"
      );
      if (saved && saved.submitted) setApplied(true);
    } catch {}
  }, []);

  const openModal = useCallback((email = "") => {
    setPrefillEmail(email);
    setModalOpen(true);
  }, []);

  const applyLabel = applied ? "Applied" : "Apply";

  return (
    <>
      {/* ===================== NAV ===================== */}
      <header className="nav">
        <div className="wrap nav__inner">
          <a className="brand" href="#top">
            <span className="brand__mark" />
            HIGH&nbsp;AGENCY
          </a>
          <nav className="nav__right">
            <div className="nav__links">
              <a href="#problem">Problem</a>
              <a href="#system">What you join</a>
              <a href="#faq">FAQ</a>
              {PLATFORM_ENABLED && <a href="/login">Log in</a>}
            </div>
            <button
              className="btn btn--primary nav__cta"
              onClick={() => openModal()}
            >
              {applyLabel}
            </button>
          </nav>
        </div>
      </header>

      <main id="top">
        {/* ===================== HERO ===================== */}
        <section className="hero hero--launch">
          {/* Generative launch loop. If a licensed clip exists at
              /public/video/launch.mp4 it plays as luminance-mapped ASCII;
              otherwise the procedural rocketLaunch program runs. */}
          <VideoAscii
            src="/video/launch.mp4"
            fallback={rocketLaunch}
            className="hero__ascii"
          />
          <div className="wrap">
            <div className="hero__copy">
              <Reveal className="eyebrow hero__tag">
                <span className="dot" />
                Founding Batch 01
              </Reveal>
              <Reveal as="h1" className="display" d={1}>
                School is a <span className="strike">waiting room.</span>
                <br />
                You weren&apos;t built to wait.
              </Reveal>
              <Reveal as="p" className="lead hero__sub" d={2}>
                Empowering teens who&apos;d rather <b>build</b>.
              </Reveal>
              <Reveal d={2}>
                <CaptureForm label="Request access" onApply={openModal} />
              </Reveal>
              <Reveal className="capture__note" d={3}>
                <span><b>By application</b> · Free · Ages 13–19</span>
              </Reveal>
              <ReferralBanner {...incoming} />
            </div>
          </div>
        </section>

        {/* proof strip */}
        <div className="strip">
          <Marquee />
        </div>

        {/* ===================== PROBLEM ===================== */}
        <section className="section section--void" id="problem">
          <AsciiCanvas program={waitingRoom} cell={13} />
          <div className="wrap">
            <Reveal as="h2" className="h2" d={2}>
              The world rewards action.{" "}
              <span className="accent">Stop waiting for permission.</span>
            </Reveal>

            <div className="statgrid">
              <Reveal className="tile stat" d={1}>
                <div className="stat__n">
                  <Counter to={75} />
                  <span className="u">%</span>
                </div>
                <div className="stat__d">feel unprepared for real decisions.</div>
              </Reveal>
              <Reveal className="tile stat" d={1}>
                <div className="stat__n">
                  <Counter to={3} />
                  <span className="u">/4</span>
                </div>
                <div className="stat__d">say school feels meaningless.</div>
              </Reveal>
              <Reveal className="tile stat" d={2}>
                <div className="stat__n">
                  <Counter to={22} />
                  <span className="u">%</span>
                </div>
                <div className="stat__d">feel a real sense of purpose.</div>
              </Reveal>
              <Reveal className="tile stat" d={2}>
                <div className="stat__n">
                  &lt;<Counter to={10} />
                  <span className="u">%</span>
                </div>
                <div className="stat__d">of unis teach any AI literacy.</div>
              </Reveal>
            </div>
          </div>
        </section>

        <div className="divider" />

        {/* ===================== WHAT YOU JOIN ===================== */}
        <section className="section section--chart" id="system">
          <AsciiCanvas
            program={trajectory}
            cell={13}
            className="chart__ascii"
          />
          <div className="wrap">
            <div className="shead">
              <Reveal className="eyebrow eyebrow--accent">
                <span className="dot" />
                What you join
              </Reveal>
              <Reveal as="h2" className="h2" d={1}>
                Not school. A launchpad.
              </Reveal>
            </div>

            <div className="loop">
              <Reveal as="article" className="tile loop__card" d={1}>
                <span className="loop__n">
                  <SquadIcon size={20} />
                </span>
                <h3 className="h3">Your squad</h3>
                <p>3–8 builders, one weekly ritual. They notice when you ghost.</p>
              </Reveal>

              <Reveal as="article" className="tile loop__card" d={2}>
                <span className="loop__n">
                  <CheckIcon size={20} />
                </span>
                <h3 className="h3">Real milestones</h3>
                <p>Ship an MVP, land users, get paid — verified by a human, never a quiz.</p>
              </Reveal>

              <Reveal as="article" className="tile loop__card" d={3}>
                <span className="loop__n">
                  <ZapIcon size={20} />
                </span>
                <h3 className="h3">Live mentors</h3>
                <p>Workshops and office hours with operators who&apos;ve done it.</p>
              </Reveal>
            </div>
          </div>
        </section>

        <div className="divider" />

        {/* ===================== HOW IT WORKS ===================== */}
        <section className="section">
          <div className="wrap how">
            <div>
              <div className="shead" style={{ marginBottom: 24 }}>
                <Reveal className="eyebrow">
                  <span className="dot" />
                  The loop
                </Reveal>
                <Reveal as="h2" className="h2" d={1}>
                  Ambition in.
                  <br />
                  Momentum out.
                </Reveal>
                <Reveal as="p" className="lead" d={2}>
                  Seven milestones. Every one is a real-world win —
                  and every win is XP, levels, and status you earned, not bought.
                </Reveal>
              </div>
              <Reveal d={2}>
                <CaptureForm label={applyLabel} onApply={openModal} />
              </Reveal>
            </div>

            {/* the actual product visual: a quest path */}
            <Reveal className="tile demo-path" d={2} aria-hidden="true">
              <div className="micro">
                <span>The Ignition Track</span>
                <span className="live">
                  <span className="blip" />
                  live
                </span>
              </div>
              <div className="path">
                <div className="path__item done">
                  <span className="path__node"><CheckIcon size={18} /></span>
                  <div className="path__body">
                    <div className="path__top">
                      <span className="path__name">Mission locked</span>
                      <span className="xp">+100</span>
                    </div>
                  </div>
                </div>
                <div className="path__item done">
                  <span className="path__node"><CheckIcon size={18} /></span>
                  <div className="path__body">
                    <div className="path__top">
                      <span className="path__name">20 cold asks out</span>
                      <span className="xp">+150</span>
                    </div>
                  </div>
                </div>
                <div className="path__item active">
                  <span className="path__node">3</span>
                  <div className="path__body">
                    <div className="path__top">
                      <span className="path__name">MVP live</span>
                      <div className="path__meta">
                        <span className="xp">+250</span>
                        <span className="badge badge--level">you are here</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="path__item locked">
                  <span className="path__node">4</span>
                  <div className="path__body">
                    <div className="path__top">
                      <span className="path__name">First users</span>
                      <span className="path__count">locked</span>
                    </div>
                  </div>
                </div>
                <div className="path__item locked">
                  <span className="path__node">5</span>
                  <div className="path__body">
                    <div className="path__top">
                      <span className="path__name">First revenue</span>
                      <span className="path__count">locked</span>
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <span className="hud__stat hud__stat--fire">
                  <FlameIcon size={14} /> 12
                </span>
                <span className="hud__stat hud__stat--xp">
                  <ZapIcon size={13} /> 480
                </span>
                <span className="badge badge--earned">
                  <CheckIcon size={11} /> verified by a human
                </span>
              </div>
            </Reveal>
          </div>
        </section>

        <div className="divider" />

        {/* ===================== MENTOR ===================== */}
        <section className="section">
          <div className="wrap mentor">
            <Reveal className="mentor__photo">
              <img
                className="mentor__img"
                src="/images/joshua-newall-2026.jpg"
                alt="Joshua Newall, Founder and Lead Mentor at High Agency"
              />
              <div className="mentor__badge">
                <div className="nm">Joshua Newall</div>
                <div className="rl">Founder &amp; Lead Mentor · High Agency</div>
              </div>
            </Reveal>
            <div>
              <Reveal className="eyebrow">
                <span className="dot" />
                Who you learn from
              </Reveal>
              <Reveal as="h2" className="h2" d={1}>
                Mentors who&apos;ve done it.
              </Reveal>
              <Reveal as="p" className="lead" d={2}>
                Build next to someone who&apos;s already walked the road.
              </Reveal>
              <Reveal className="creds" d={2}>
                <div className="cred">
                  <span className="cred__k">Enterprise</span>
                  <span className="cred__v">Advised Fortune 500s at scale.</span>
                </div>
                <div className="cred">
                  <span className="cred__k">Frontier</span>
                  <span className="cred__v">Worked on space startups.</span>
                </div>
                <div className="cred">
                  <span className="cred__k">Research</span>
                  <span className="cred__v">Published research background.</span>
                </div>
                <div className="cred">
                  <span className="cred__k">Mission</span>
                  <span className="cred__v">Teaches what school can&apos;t.</span>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        <div className="divider" />

        {/* ===================== FAQ ===================== */}
        <section className="section" id="faq">
          <div className="wrap faq-grid">
            <div className="faq-grid__head">
              <Reveal className="eyebrow" style={{ marginBottom: 16 }}>
                <span className="dot" />
                Before you apply
              </Reveal>
              <Reveal as="h2" className="h2" d={1}>
                Questions, answered straight.
              </Reveal>
            </div>
            <Reveal d={1}>
              <Faq />
            </Reveal>
          </div>
        </section>

        {/* ===================== FINAL CTA ===================== */}
        <section className="section final">
          <div className="wrap">
            <div className="final__grid">
              <div className="final__inner">
                <Reveal className="eyebrow eyebrow--accent">
                  <span className="dot" />
                  Applications open
                </Reveal>
                <Reveal as="h2" className="h2" d={1}>
                  Ambition is the only prerequisite.
                </Reveal>
                <Reveal as="p" className="lead" d={2}>
                  Stop rehearsing. Start building.
                </Reveal>
                <Reveal d={2}>
                  <CaptureForm label="Apply now" onApply={openModal} />
                </Reveal>
                <Reveal className="capture__note" d={3}>
                  <span><b>By application</b> · Free</span>
                </Reveal>
              </div>
              <div className="final__pad" aria-hidden="true">
                <AsciiCanvas
                  program={engineBurn}
                  cell={12}
                  className="final__burn"
                />
                <div className="mc-line">
                  T-MINUS 00 · Systems: go · Pad: ready
                  <span className="mc-cursor">_</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===================== FOOTER ===================== */}
        <footer className="footer">
          <div className="wrap footer__inner">
            <a className="brand" href="#top">
              <span className="brand__mark" />
              HIGH&nbsp;AGENCY
            </a>
            <div className="footer__links">
              <a href="#problem">Problem</a>
              <a href="#system">What you join</a>
              <a href="#faq">FAQ</a>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  openModal();
                }}
              >
                Apply
              </a>
            </div>
            <small>© 2026 High Agency · A launchpad.</small>
          </div>
        </footer>
      </main>

      <ApplyModal
        open={modalOpen}
        prefillEmail={prefillEmail}
        referredBy={incoming.code}
        onClose={() => setModalOpen(false)}
        onApplied={() => setApplied(true)}
      />
    </>
  );
}
