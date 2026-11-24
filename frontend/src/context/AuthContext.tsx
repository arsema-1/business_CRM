import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { api } from "../api/client";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "SALES" | "WAREHOUSE" | "ACCOUNTS";
  // Self-registered and not yet approved by an admin
  pendingApproval?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  // True until the initial session check finishes; routes must wait for it or
  // they would bounce a signed-in user to /login on every refresh.
  loading: boolean;
  // Returns whether a second factor is still required before the session exists.
  login: (email: string, password: string, recaptchaToken?: string) => Promise<{ mfaRequired: boolean }>;
  logout: () => Promise<void>;
  // Re-reads the session from the server (used after passkey sign-in and after
  // profile changes).
  refreshUser: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await api.get("/auth/me");
      setUser(res.user);
      return res.user as AuthUser;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  // The session is a cookie, so the app has to ask the server who it is; there is
  // no stored profile to trust. A stale access token is transparently refreshed
  // by the API client.
  useEffect(() => {
    let cancelled = false;

    // Drop anything left over from the old localStorage-based auth
    localStorage.removeItem("token");
    localStorage.removeItem("user");

    api
      .get("/auth/me")
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function login(email: string, password: string, recaptchaToken?: string) {
    const res = await api.post("/auth/login", { email, password, recaptchaToken });
    // With MFA enabled the server deliberately creates no session yet; the
    // caller must collect the code and call /auth/mfa/verify.
    if (res.mfaRequired) return { mfaRequired: true };
    const me = await api.get("/auth/me");
    setUser(me.user);
    return { mfaRequired: false };
  }

  async function logout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // Session may already be gone; clearing local state is still correct.
    }
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
