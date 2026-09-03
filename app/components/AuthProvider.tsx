"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { getFirebaseAuth } from "../lib/firebase";
import { watchProfile } from "../lib/db";
import type { Profile } from "../lib/types";

interface AuthState {
  /** undefined = still resolving, null = signed out */
  user: User | null | undefined;
  /** undefined = still resolving, null = signed in but not onboarded */
  profile: Profile | null | undefined;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  // Tagged with the uid it belongs to, so "whose profile is this?" is answered
  // by a comparison at render rather than by clearing state in an effect —
  // switching accounts can never surface the previous user's profile.
  const [snap, setSnap] = useState<{ uid: string; profile: Profile | null } | null>(null);

  useEffect(() => {
    return onAuthStateChanged(getFirebaseAuth(), setUser);
  }, []);

  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    return watchProfile(uid, (p) => setSnap({ uid, profile: p }));
  }, [user]);

  const profile: Profile | null | undefined =
    user === undefined ? undefined
    : user === null ? null
    : snap?.uid === user.uid ? snap.profile
    : undefined;

  const logout = () => signOut(getFirebaseAuth());

  return (
    <AuthContext.Provider value={{ user, profile, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
