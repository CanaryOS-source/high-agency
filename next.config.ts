import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only. Lets a second browser origin (127.0.0.1) load dev assets so an
  // operator and a mentor can be signed in side by side during local QA —
  // Firebase Auth keeps one session per origin. See docs/qa-e2e.md.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
