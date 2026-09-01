"use client";

/* The living reference for "Operator OS v2 · Arcade Paper".
   Read design-system.md first — this page just shows the pieces. */

import {
  Avatar,
  AvStack,
  Bar,
  CheckIcon,
  FlameIcon,
  LockIcon,
} from "../components/ui";

const SWATCHES: [string, string, string][] = [
  ["--bg", "#F5F2EB", "paper"],
  ["--surface", "#FFFFFF", "tile"],
  ["--surface-2", "#F1EDE4", "inset"],
  ["--border", "#E9E4D8", "outline"],
  ["--border-strong", "#D8D2C4", "edge"],
  ["--text", "#211C17", "ink"],
  ["--text-muted", "#6E665B", "muted"],
  ["--accent", "#FF5A1E", "ember · action"],
  ["--accent-press", "#CE400C", "ember edge"],
  ["--signal", "#C6F24E", "lime · earned fill"],
  ["--signal-press", "#8FB534", "lime edge"],
  ["--signal-text", "#3F8F1C", "green · earned text"],
  ["--warn", "#C2790F", "returned"],
  ["--danger", "#D63A2C", "errors"],
];

export function StyleguideBody() {
  return (
    <div className="screen sg" style={{ margin: "0 auto" }}>
      <header>
        <span className="micro">design system · v2</span>
        <h1 className="h1" style={{ marginTop: 6 }}>Arcade Paper</h1>
        <p className="lead" style={{ marginTop: 10 }}>
          A game console for shipping real things. Same palette as v1 — every
          piece around it rebuilt. Rules live in <b>design-system.md</b>.
        </p>
      </header>

      {/* ---- Color ---- */}
      <section>
        <span className="micro">01 · color (values unchanged)</span>
        <div className="sg__swatches">
          {SWATCHES.map(([token, hex, label]) => (
            <div key={token} className="sg__swatch">
              <i style={{ background: `var(${token})` }} />
              <span>
                {token}
                <br />
                {hex} · {label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Type ---- */}
      <section>
        <span className="micro">02 · type — Gabarito + Geist Mono</span>
        <div className="stack">
          <span className="display">Ship it.</span>
          <span className="h1">Screen title</span>
          <span className="h3">Tile title</span>
          <p style={{ maxWidth: 480 }}>
            Body is Gabarito 400–500, never below 16px. Copy stays short:
            headings ≤ 4 words, buttons ≤ 2.
          </p>
          <span className="num" style={{ fontSize: 28 }}>1,250 <span className="signal">XP</span></span>
        </div>
      </section>

      {/* ---- Buttons ---- */}
      <section>
        <span className="micro">03 · buttons — push pieces (press one)</span>
        <div className="sg__row">
          <button className="btn btn--primary">Ship</button>
          <button className="btn btn--verify">Verify <span className="num">+250</span></button>
          <button className="btn btn--ink">Continue</button>
          <button className="btn btn--ghost">Cancel</button>
          <button className="btn btn--primary btn--sm">Apply</button>
          <button className="btn btn--primary" disabled>
            Locked
          </button>
        </div>
      </section>

      {/* ---- HUD ---- */}
      <section>
        <span className="micro">04 · hud — the always-on game state</span>
        <div className="sg__row">
          <span className="hud__stat hud__stat--fire">
            <FlameIcon size={15} /> 12
          </span>
          <span className="hud__stat">
            <FlameIcon size={15} /> 12
          </span>
          <span className="badge badge--earned">
            <CheckIcon size={11} /> done
          </span>
          <span className="badge badge--locked">
            <LockIcon /> full
          </span>
        </div>
      </section>

      {/* ---- Tiles ---- */}
      <section>
        <span className="micro">05 · tiles — outline + hard edge</span>
        <div className="grid2">
          <div className="tile">
            <div className="tile__head">
              <span className="h3">Resting tile</span>
              <span className="micro">today</span>
            </div>
            <Bar value={0.6} />
          </div>
          <a href="#" className="tile tile--tap" onClick={(e) => e.preventDefault()}>
            <div className="tile__head">
              <span className="h3">Tap tile</span>
            </div>
            <p className="muted">Press me — I travel.</p>
          </a>
          <div className="tile tile--ember">
            <div className="tile__head">
              <span className="h3">Your move</span>
            </div>
            <p className="muted">Ember tint = action waiting.</p>
          </div>
          <div className="tile tile--lime">
            <div className="tile__head">
              <span className="h3 signal"><CheckIcon /> Earned</span>
            </div>
            <p className="muted">Lime tint = verified, done, yours.</p>
          </div>
        </div>
      </section>

      {/* ---- Path ---- */}
      <section>
        <span className="micro">06 · the quest path</span>
        <div className="tile" style={{ maxWidth: 480 }}>
          <div className="path">
            <div className="path__item done">
              <span className="path__node"><CheckIcon size={18} /></span>
              <div className="path__body">
                <div className="path__top">
                  <span className="path__name">Mission locked</span>
                  <span className="path__count">5/6</span>
                </div>
              </div>
            </div>
            <div className="path__item active">
              <span className="path__node">2</span>
              <div className="path__body">
                <div className="path__top">
                  <span className="path__name">20 asks out</span>
                  <div className="path__meta">
                    <span className="path__count">due Fri</span>
                  </div>
                </div>
                <div className="path__detail">
                  <p className="path__evidence">
                    Twenty sent messages and at least one reply.
                  </p>
                  <button className="btn btn--verify btn--sm">Mark done</button>
                </div>
              </div>
            </div>
            <div className="path__item locked">
              <span className="path__node">3</span>
              <div className="path__body">
                <div className="path__top">
                  <span className="path__name">MVP live</span>
                  <span className="path__count">locked</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Identity ---- */}
      <section>
        <span className="micro">07 · identity</span>
        <div className="sg__row">
          <Avatar name="Ada" size="lg" />
          <Avatar name="Ben" />
          <Avatar name="Chi" size="sm" />
          <AvStack names={["Ada L.", "Ben K.", "Chi O.", "Dev P.", "Eli S.", "Fay W."]} />
        </div>
      </section>

      {/* ---- Fields & picks ---- */}
      <section>
        <span className="micro">08 · fields & picks</span>
        <div className="grid2">
          <div>
            <div className="field">
              <label>Headline</label>
              <input placeholder="Building an AI study planner" readOnly />
            </div>
            <div className="composer">
              <input className="input" placeholder="One line. What shipped?" readOnly />
              <button className="btn btn--primary">Ship</button>
            </div>
          </div>
          <div className="chip-row">
            <button className="pick sel">AI</button>
            <button className="pick">Hardware</button>
            <button className="pick">Content</button>
            <span className="chip chip--why">same timezone</span>
            <span className="chip chip--want">wants Design</span>
            <span className="chip">E-commerce</span>
          </div>
        </div>
      </section>

      {/* ---- Feedback ---- */}
      <section>
        <span className="micro">09 · feedback — warn is never red</span>
        <div className="stack" style={{ maxWidth: 480 }}>
          <span className="path__state path__state--ok">
            <CheckIcon size={12} /> Verified by Sarah M.
          </span>
          <span className="path__state path__state--warn">
            Returned: add the reply screenshot
          </span>
          <p className="form-err">Couldn&apos;t save. Try again.</p>
          <div className="notice">
            <LockIcon size={20} />
            <span>
              Waiting on your parent&apos;s OK.
              <small>Everything unlocks after.</small>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
