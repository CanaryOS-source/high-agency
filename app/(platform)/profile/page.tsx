"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { saveProfile } from "../../lib/db";
import { localDay } from "../../lib/streaks";
import { DOMAINS, SKILLS } from "../../lib/types";
import { Avatar, FlameIcon } from "../../components/ui";
import type { Profile, VentureStage } from "../../lib/types";

const STAGES: { id: VentureStage; label: string }[] = [
  { id: "idea", label: "Just an idea" },
  { id: "building", label: "Building it" },
  { id: "launched", label: "Launched" },
  { id: "revenue", label: "Has revenue" },
];

export default function ProfilePage() {
  const { user, profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (user && profile === null) router.replace("/onboarding");
    // The operator card carries the streak, which a mentor doesn't have.
    // They edit a mentor-shaped card instead.
    else if (profile?.role === "mentor") router.replace("/mentor/you");
  }, [user, profile, router]);

  if (!user || !profile) return null;
  return <ProfileCard key={user.uid} uid={user.uid} profile={profile} />;
}

/** The editable card. Mounted only once the profile has loaded, and keyed by
 *  uid, so every field seeds itself from the profile at mount — nothing has to
 *  copy the profile into state afterwards, and signing in as someone else
 *  remounts the form rather than leaving the previous answers in the boxes. */
function ProfileCard({ uid, profile }: { uid: string; profile: Profile }) {
  const [headline, setHeadline] = useState(profile.headline ?? "");
  const [building, setBuilding] = useState(profile.building ?? "");
  const [stage, setStage] = useState<VentureStage>(profile.stage ?? "idea");
  const [domains, setDomains] = useState<string[]>(profile.domains ?? []);
  const [skills, setSkills] = useState<string[]>(profile.skills ?? []);
  const [proofUrl, setProofUrl] = useState(profile.proofUrl ?? "");
  const [proofNote, setProofNote] = useState(profile.proofNote ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [github, setGithub] = useState(profile.links?.github ?? "");
  const [linkedin, setLinkedin] = useState(profile.links?.linkedin ?? "");
  const [site, setSite] = useState(profile.links?.site ?? "");

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function toggle(list: string[], set: (v: string[]) => void, item: string) {
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  }

  async function submit() {
    if (!headline.trim() || !building.trim() || domains.length === 0 || skills.length === 0) {
      setError("Headline, what you're building, a domain, and an interest — minimum.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // The security rule validates the whole merged document, so we write
      // a complete, valid profile: edited fields plus the existing
      // identity/gamification fields. This also self-heals any profile
      // doc that predates a field (e.g. an empty lastActiveDay).
      await saveProfile(
        uid,
        {
          name: profile.name,
          ageBand: profile.ageBand,
          country: profile.country,
          timezone: profile.timezone,
          headline: headline.trim(),
          building: building.trim(),
          stage,
          domains,
          skills,
          proofUrl: proofUrl.trim(),
          proofNote: proofNote.trim(),
          bio: bio.trim(),
          links: { github: github.trim(), linkedin: linkedin.trim(), site: site.trim() },
          consentStatus: profile.consentStatus,
          streak: profile.streak,
          streakFreezes: profile.streakFreezes,
          lastActiveDay: profile.lastActiveDay?.length === 10 ? profile.lastActiveDay : localDay(),
          lastBuildLogDay: profile.lastBuildLogDay ?? "",
          enrolledWorkshops: profile.enrolledWorkshops,
          pendingApplications: profile.pendingApplications,
        },
        false
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error("saveProfile failed:", e);
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const alive = profile.lastActiveDay === localDay();

  return (
    <div className="screen">
      {/* ---- Player card ---- */}
      <section className="tile tile--lime screen__block">
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Avatar name={profile.name} size="lg" />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 className="h2">{profile.name}</h1>
              <span
                className={`hud__stat ${alive ? "hud__stat--fire" : ""}`}
                title={alive ? "Streak alive today" : "Ship something today to keep it"}
              >
                <FlameIcon size={14} /> {profile.streak}
              </span>
              {profile.streakFreezes > 0 && (
                <span className="badge" title="Streak freezes banked">
                  ×{profile.streakFreezes} freeze{profile.streakFreezes === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <span className="micro">
              {profile.ageBand} · {profile.country}
            </span>
          </div>
        </div>
        <p className="micro" style={{ marginTop: 12 }}>
          {alive
            ? "Counted today. A build log, a ritual, or a workshop keeps it going tomorrow."
            : "Nothing shipped yet today — one build-log line keeps the streak."}
        </p>
      </section>

      {/* ---- Edit ---- */}
      <section className="tile" style={{ maxWidth: 640 }}>
        <div className="tile__head">
          <h2 className="h3">Your card</h2>
          <span className="micro">what squads see</span>
        </div>

        <div className="field">
          <label htmlFor="pf-headline">Headline</label>
          <input
            id="pf-headline"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={80}
          />
        </div>

        <div className="field">
          <label htmlFor="pf-building">Building</label>
          <textarea
            id="pf-building"
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
            maxLength={300}
          />
        </div>

        <div className="field">
          <label>Stage</label>
          <div className="chip-row">
            {STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`pick ${stage === s.id ? "sel" : ""}`}
                onClick={() => setStage(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Domains</label>
          <div className="chip-row">
            {DOMAINS.map((d) => (
              <button
                key={d}
                type="button"
                className={`pick ${domains.includes(d) ? "sel" : ""}`}
                onClick={() => toggle(domains, setDomains, d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Into</label>
          <div className="chip-row">
            {SKILLS.map((s) => (
              <button
                key={s}
                type="button"
                className={`pick ${skills.includes(s) ? "sel" : ""}`}
                onClick={() => toggle(skills, setSkills, s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="pf-proof">Proof of work</label>
          <input
            id="pf-proof"
            value={proofUrl}
            onChange={(e) => setProofUrl(e.target.value)}
            placeholder="Link the best thing you've made"
            maxLength={300}
          />
          <input
            value={proofNote}
            onChange={(e) => setProofNote(e.target.value)}
            placeholder="Why it matters — one line"
            maxLength={200}
          />
        </div>

        <div className="field">
          <label htmlFor="pf-bio">Bio</label>
          <textarea
            id="pf-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={300}
          />
        </div>

        <div className="field">
          <label>Links</label>
          <input
            value={github}
            onChange={(e) => setGithub(e.target.value)}
            placeholder="GitHub"
            maxLength={200}
          />
          <input
            value={linkedin}
            onChange={(e) => setLinkedin(e.target.value)}
            placeholder="LinkedIn"
            maxLength={200}
          />
          <input
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="Personal site"
            maxLength={200}
          />
        </div>

        {error && <p className="form-err">{error}</p>}

        <div className="row-actions">
          <button className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? "…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
