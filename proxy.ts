import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PLATFORM_ENABLED } from "./app/lib/flags";

// Next.js 16 renamed `middleware` → `proxy` (Node.js runtime by default).
//
// When the platform is disabled (production / waitlist-only), seal off every
// authenticated route so the deployed site is just the marketing waitlist at
// `/`. When enabled (local dev), this proxy no-ops and login/app work normally.
//
// Keep this list in sync with the routes under `app/(platform)/` plus `/login`.
const PLATFORM_PREFIXES = [
  "/login",
  "/onboarding",
  "/dashboard",
  "/cohorts",
  "/profile",
  "/learn",
  "/mentor",
];

export function proxy(request: NextRequest) {
  if (PLATFORM_ENABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const isPlatformRoute = PLATFORM_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );

  if (isPlatformRoute) {
    // Send would-be platform visitors back to the waitlist.
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

// Matcher values must be static literals (analyzed at build time). Include both
// the bare path and the wildcard so `/login` and `/login/...` are both covered.
export const config = {
  matcher: [
    "/login",
    "/login/:path*",
    "/onboarding",
    "/onboarding/:path*",
    "/dashboard",
    "/dashboard/:path*",
    "/cohorts",
    "/cohorts/:path*",
    "/profile",
    "/profile/:path*",
    "/learn",
    "/learn/:path*",
    "/mentor",
    "/mentor/:path*",
  ],
};
