"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "../components/AuthProvider";
import {
  Hud,
  HomeIcon,
  SquadIcon,
  ZapIcon,
  UserIcon,
  CalendarIcon,
} from "../components/ui";

type Tab = {
  href: string;
  label: string;
  icon: (p: { size?: number }) => React.ReactElement;
  /** Which other routes light this tab up. */
  owns?: (pathname: string) => boolean;
};

/** Operators: the game. Home → squads → learn → your card. */
const OPERATOR_TABS: Tab[] = [
  { href: "/dashboard", label: "Home", icon: HomeIcon },
  {
    href: "/cohorts",
    label: "Squads",
    icon: SquadIcon,
    owns: (p) => p.startsWith("/cohorts"),
  },
  { href: "/learn", label: "Learn", icon: ZapIcon },
  { href: "/profile", label: "You", icon: UserIcon },
];

/** Mentors: the job. A mentor is not an operator with an extra page — none of
 *  the operator surfaces (the track, XP, the build log, squad discovery) are
 *  things they do, so they don't get them. Squad detail pages are shared,
 *  because that's where a mentor verifies milestones 4–7. */
const MENTOR_TABS: Tab[] = [
  { href: "/mentor", label: "Home", icon: HomeIcon },
  { href: "/mentor/workshops", label: "Workshops", icon: CalendarIcon },
  {
    href: "/mentor/squads",
    label: "Squads",
    icon: SquadIcon,
    owns: (p) => p.startsWith("/cohorts"),
  },
  { href: "/mentor/you", label: "You", icon: UserIcon },
];

function useTabs() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const tabs = profile?.role === "mentor" ? MENTOR_TABS : OPERATOR_TABS;
  const isOn = (t: Tab) => pathname === t.href || !!t.owns?.(pathname);
  return { tabs, isOn };
}

/** Desktop: slim left rail — logo, icon tabs, HUD at the bottom. */
function Rail() {
  const { profile, logout } = useAuth();
  const { tabs, isOn } = useTabs();
  // The HUD is the operator's game state (streak + level ring). Mentors have
  // neither, so the rail just ends after the tabs for them.
  const showHud = profile && profile.role !== "mentor";

  return (
    <aside className="rail">
      <Link
        href={profile?.role === "mentor" ? "/mentor" : "/dashboard"}
        className="rail__logo"
        aria-label="High Agency home"
      >
        <img src="/brand/high-agency-mark.svg" alt="" />
      </Link>
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`rail__tab ${isOn(t) ? "rail__tab--on" : ""}`}
        >
          <t.icon />
          {t.label}
        </Link>
      ))}
      <div className="rail__foot">
        {showHud && <Hud profile={profile} col />}
        <button className="rail__out" onClick={logout}>
          Exit
        </button>
      </div>
    </aside>
  );
}

/** Mobile: sticky top bar with brand + HUD. */
function TopBar() {
  const { profile } = useAuth();
  const home = profile?.role === "mentor" ? "/mentor" : "/dashboard";
  return (
    <header className="topbar">
      <Link href={home} className="topbar__logo" aria-label="High Agency home">
        <img src="/brand/high-agency-mark.svg" alt="" />
      </Link>
      {profile && profile.role !== "mentor" && <Hud profile={profile} />}
    </header>
  );
}

/** Mobile: fixed bottom tab bar — the game console controls. */
function TabBar() {
  const { tabs, isOn } = useTabs();
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`tabbar__tab ${isOn(t) ? "tabbar__tab--on" : ""}`}
        >
          <t.icon />
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  // Only the invite-only mentor signup renders bare — the rest of /mentor/*
  // is the mentor's app and wants the shell around it.
  const bare =
    pathname === "/login" ||
    pathname === "/onboarding" ||
    pathname === "/mentor/join";

  if (bare || !user) return <main>{children}</main>;

  return (
    <div className="shell">
      <Rail />
      <div className="shell__main">
        <TopBar />
        <main>{children}</main>
      </div>
      <TabBar />
    </div>
  );
}

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  );
}
