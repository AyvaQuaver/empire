import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Button, Field, Input, ErrorBanner, Panel } from "../components/ui";
import { useSession } from "../App";
import { Page } from "../App";

function AuthLayout({ children, title }: { children: React.ReactNode; title: string }) {
  const session = useSession();
  return (
    <Page>
      <Link to="/" className="wordmark wordmark-lg wordmark-underline" aria-label="Back to home">
        EMPIRE
      </Link>
      <h2 style={{ fontSize: 26 }}>{title}</h2>
      {session.accountsEnabled === false ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p className="error-text" role="alert">
            <span aria-hidden="true">🔒</span> Guest preview — accounts are not available yet. You can play as a guest.
          </p>
          <Link to="/" className="btn-secondary btn-cta">
            Play a game
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
      )}
    </Page>
  );
}

interface UserPayload {
  user: { id: string; username: string; emailVerified: boolean } | null;
}

function failMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

export function SignInPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<UserPayload>("/api/auth/sign-in", { username, password });
      // A full reload guarantees every route reads the new session cookie.
      window.location.href = "/";
    } catch (err) {
      setError(failMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Welcome back">
      <form onSubmit={submit} noValidate>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" />
          </Field>
          <Field label="Password">
            <Input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show password
          </label>
          <ErrorBanner error={error} />
          <Button type="submit" className="btn-primary btn-cta" loading={busy}>
            Sign in
          </Button>
          <Button className="btn-ghost" onClick={() => navigate("/forgot-password")}>
            Forgot password
          </Button>
          <p className="status-text">
            New here? <Link to="/register">Create an account</Link> — or just{" "}
            <Link to="/join">play as a guest</Link>.
          </p>
        </div>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<UserPayload>("/api/auth/register", { username, email, password });
      setDone(true);
    } catch (err) {
      setError(failMessage(err));
    }
    setBusy(false);
  };

  if (done) {
    return (
      <AuthLayout title="Check your inbox">
        <p>
          We sent a verification link to your email. Verifying keeps your account recoverable — you can play as guest
          while you wait.
        </p>
        <Button className="btn-primary btn-cta" onClick={() => (window.location.href = "/")}>
          Continue to Empire
        </Button>
        <Panel heading="Dev mailbox">
          <p className="status-text">
            In local development without SMTP, the email lands in the local outbox (see README). It never leaves your
            machine.
          </p>
        </Panel>
      </AuthLayout>
    );
  }

  const emailVerifiedPlaceholder = !email.includes("@");
  void emailVerifiedPlaceholder;

  return (
    <AuthLayout title="Create an account">
      <form onSubmit={submit} noValidate>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="Username" hint="3–24 letters, numbers or underscores. Used to find friends.">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" maxLength={24} />
          </Field>
          <Field label="Email (private)" hint="Only used for verification and password reset.">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              name="email"
            />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <Input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              name="new-password"
            />
          </Field>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show password
          </label>
          <ErrorBanner error={error} />
          <Button type="submit" className="btn-primary btn-cta" loading={busy}>
            Create account
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get("token");
  const [busy, setBusy] = useState(!!token);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  void api;

  if (token && busy && !ok && !error) {
    api
      .post("/api/auth/verify", { token })
      .then(() => {
        setOk(true);
        setBusy(false);
      })
      .catch((err) => {
        setError(failMessage(err));
        setBusy(false);
      });
  }

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/resend-verification");
      setError(null);
      window.alert("Verification email sent.");
    } catch (err) {
      setError(failMessage(err));
    }
    setBusy(false);
  };

  return (
    <AuthLayout title="Verify your email">
      {!token && (
        <p>
          Open the verification link from your email, or press below to send a fresh one. {!ok ? "" : ""}
        </p>
      )}
      {!token && (
        <Button className="btn-primary btn-cta" onClick={resend} loading={busy}>
          Resend verification email
        </Button>
      )}
      {ok && <p role="status">Email verified — all set!</p>}
      <ErrorBanner error={error} />
      <Link to="/" className="btn-ghost">
        Back to home
      </Link>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.post("/api/auth/forgot-password", { usernameOrEmail: identity });
      setSent(true);
    } catch (err) {
      setError(failMessage(err));
    }
    setBusy(false);
  };

  return (
    <AuthLayout title="Reset your password">
      {sent ? (
        <p role="status">If that account exists, we've sent a reset link. The link expires in one hour.</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="Username or email">
            <Input value={identity} onChange={(e) => setIdentity(e.target.value)} required />
          </Field>
          <ErrorBanner error={error} />
          <Button type="submit" className="btn-primary btn-cta" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <Link to="/sign-in" className="btn-ghost">
        Back to sign in
      </Link>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.post("/api/auth/reset-password", { token, password });
      setOk(true);
    } catch (err) {
      setError(failMessage(err));
    }
    setBusy(false);
  };

  return (
    <AuthLayout title="Choose a new password">
      {ok ? (
        <>
          <p role="status">Password changed. Every signed-in session was signed out for safety.</p>
          <Button className="btn-primary btn-cta" onClick={() => navigate("/sign-in")}>
            Sign in
          </Button>
        </>
      ) : token ? (
        <form onSubmit={submit} noValidate>
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </Field>
          <ErrorBanner error={error} />
          <Button type="submit" className="btn-primary btn-cta" loading={busy}>
            Set password
          </Button>
        </form>
      ) : (
        <p className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> That reset link is missing its token. Request a fresh one.
        </p>
      )}
    </AuthLayout>
  );
}

export function SignOutButton() {
  const { signOut } = useSession();
  return (
    <Button
      className="btn-ghost"
      onClick={() => {
        void signOut().then(() => (window.location.href = "/"));
      }}
    >
      Sign out
    </Button>
  );
}
