"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../../components/AuthProvider";
import {
  useMentorGate,
  useMentoredSquadList,
} from "../../../components/mentorData";
import { saveProfile, watchMyUpcomingWorkshops } from "../../../lib/db";
import { localDay } from "../../../lib/gamify";
import { DOMAINS, SKILLS } from "../../../lib/types";
import type { Workshop } from "../../../lib/types";
import { Avatar } from "../../../components/ui";
import {
  TagField,
  MAX_EXPERTISE,
  MAX_COACH,
} from "../../../components/TagField";

const EXPERTISE_PRESETS = DOMAINS.filter((d) => d !== "Other");

export default function MentorYouPage() {
  const { user, profile } = useMentorGate();
  const { logout } = useAuth();
  const { mine } = useMentoredSquadList(user?.uid ?? null);

  const [sessions, setSessions] = useState<Workshop[]>([]);

  const [headline, setHeadline] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [building, setBuilding] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [proofNote, setProofNote] = useState("");
  const [bio, setBio] = useState("");
  const [github, setGithub] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [site, setSite] = useState("");

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    return watchMyUpcomingWorkshops(user.uid, setSessions);
  }, [user]);

  useEffect(() => {
    if (profile && !loaded) {
      setHeadline(profile.headline ?? "");
      setDomains(profile.domains ?? []);
      setSkills(profile.skills ?? []);
      setBuilding(profile.building ?? "");
      setProofUrl(profile.proofUrl ?? "");
      setProofNote(profile.proofNote ?? "");
      setBio(profile.bio ?? "");
      setGithub(profile.links?.github ?? "");
      setLinkedin(profile.links?.linkedin ?? "");
      setSite(profile.links?.site ?? "");
      setLoaded(true);
    }
  }, [profile, loaded]);

  async function submit() {
    if (!user || !profile) return;
    if (!headline.trim() || domains.length === 0 || skills.length === 0) {
      setError("A headline, one area of expertise, and one thing you can coach.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // The security rule validates the whole merged document, so we write a
      // complete, valid profile: the edited fields plus every identity field
      // this page deliberately doesn't expose. `stage` is an operator concept
      // and is carried through untouched rather than surfaced to a mentor.
      await saveProfile(
        user.uid,
        {
          name: profile.name,
          ageBand: profile.ageBand,
          country: profile.country,
          timezone: profile.timezone,
          headline: headline.trim(),
          building: building.trim(),
          stage: profile.stage ?? "building",
          domains,
          skills,
          proofUrl: proofUrl.trim(),
          proofNote: proofNote.trim(),
          bio: bio.trim(),
          links: {
            github: github.trim(),
            linkedin: linkedin.trim(),
            site: site.trim(),
          },
          consentStatus: profile.consentStatus,
          xp: profile.xp,
          streak: profile.streak,
          streakFreezes: profile.streakFreezes,
          lastActiveDay:
            profile.lastActiveDay?.length === 10 ? profile.lastActiveDay : localDay(),
          lastBuildLogDay: profile.lastBuildLogDay ?? "",
          lastRitualWeek: profile.lastRitualWeek ?? "",
          enrolledWorkshops: profile.enrolledWorkshops,
          attendedWorkshops: profile.attendedWorkshops,
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

  if (!user || !profile) return null;

  return (
    <div className="screen">
      {/* ---- Who you are here. No level, no XP, no streak: a mentor's
              standing is the work, and none of the game applies to them. ---- */}
      <section className="tile screen__block">
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Avatar name={profile.name} size="lg" />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 className="h2">{profile.name}</h1>
            <span className="micro">
              Mentor · {profile.country} · {profile.timezone}
            </span>
          </div>
        </div>
        <div className="creds" style={{ marginTop: 16 }}>
          <div className="cred">
            <span className="cred__k">Squads</span>
            <span className="cred__v">{mine.length}</span>
          </div>
          <div className="cred">
            <span className="cred__k">Sessions ahead</span>
            <span className="cred__v">{sessions.length}</span>
          </div>
        </div>
      </section>

      {/* ---- What operators see when they land on one of your sessions ---- */}
      <section className="tile" style={{ maxWidth: 640 }}>
        <div className="tile__head">
          <h2 className="h3">Your card</h2>
          <span className="micro">what operators see</span>
        </div>

        <div className="field">
          <label htmlFor="my-headline">Headline</label>
          <input
            id="my-headline"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="Founder of Loop (acq. 2024) · ex-Shopify growth"
            maxLength={90}
          />
        </div>

        <TagField
          label="Expertise"
          presets={EXPERTISE_PRESETS}
          value={domains}
          max={MAX_EXPERTISE}
          onChange={setDomains}
        />

        <TagField
          label="Can coach"
          presets={SKILLS}
          value={skills}
          max={MAX_COACH}
          onChange={setSkills}
        />

        <div className="field">
          <label htmlFor="my-building">What you&apos;re working on</label>
          <textarea
            id="my-building"
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
            placeholder="Optional — the thing that makes you worth listening to right now."
            maxLength={300}
          />
        </div>

        <div className="field">
          <label htmlFor="my-proof">Proof of work</label>
          <input
            id="my-proof"
            value={proofUrl}
            onChange={(e) => setProofUrl(e.target.value)}
            placeholder="Link the best thing you've shipped"
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
          <label htmlFor="my-bio">Bio</label>
          <textarea
            id="my-bio"
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
          <button className="btn btn--ghost" onClick={() => logout()}>
            Sign out
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? "…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
