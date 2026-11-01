import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { api, type MeResponse } from "./lib/api";
import HomePage from "./pages/HomePage";
import CreatePage from "./pages/CreatePage";
import JoinPage from "./pages/JoinPage";
import RoomPage from "./pages/RoomPage";
import { SignInPage, RegisterPage, VerifyEmailPage, ForgotPasswordPage, ResetPasswordPage } from "./pages/AuthPages";
import { ProfilePage } from "./pages/ProfilePage";
import FriendsPage from "./pages/FriendsPage";
import { HowToPlayPage, PrivacyPage, NotFoundPage } from "./pages/StaticPages";

// ---- auth context ---------------------------------------------------------

interface SessionCtx {
  signedIn: boolean;
  username: string | null;
  emailVerified: boolean;
  loading: boolean;
  /** Server-declared capability flag (guest preview disables accounts). */
  accountsEnabled: boolean | null;
  accountsNotice: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionCtx>({
  signedIn: false,
  username: null,
  emailVerified: false,
  loading: true,
  accountsEnabled: null,
  accountsNotice: null,
  refresh: async () => undefined,
  signOut: async () => undefined,
});

export function useSession(): SessionCtx {
  return useContext(SessionContext);
}

function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{
    signedIn: boolean;
    username: string | null;
    emailVerified: boolean;
    loading: boolean;
    accountsEnabled: boolean | null;
    accountsNotice: string | null;
  }>({
    signedIn: false,
    username: null,
    emailVerified: false,
    loading: true,
    accountsEnabled: null,
    accountsNotice: null,
  });

  const refresh = useCallback(async () => {
    try {
      // Capabilities first: the server says whether accounts are available
      // (guest preview). No configuration or secrets are exposed.
      const caps = await api
        .get<{ accountsEnabled: boolean | null; accountsNotice: string | null }>("/api/capabilities")
        .catch(() => ({ accountsEnabled: null as boolean | null, accountsNotice: null as string | null }));
      localStorage.setItem("empire.accounts", caps.accountsEnabled === false ? "false" : "true");
      const me = await api.get<MeResponse>("/api/me");
      setState({
        signedIn: me.signedIn,
        username: me.user?.username ?? null,
        emailVerified: me.user?.emailVerified ?? false,
        loading: false,
        accountsEnabled: caps.accountsEnabled,
        accountsNotice: caps.accountsNotice,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/auth/sign-out");
    } finally {
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <SessionContext.Provider value={{ ...state, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSessionBridge() {
  return useSession();
}

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="page">
      <div className="page-content">{children}</div>
    </main>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreatePage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/join/:token" element={<JoinPage />} />
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="/room/:code/*" element={<RoomPage />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/friends" element={<FriendsPage />} />
        <Route path="/how-to-play" element={<HowToPlayPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/not-found" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Routes>
    </SessionProvider>
  );
}
