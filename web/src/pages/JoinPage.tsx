import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Button, Field, Input, ErrorBanner } from "../components/ui";
import { useSession } from "../App";

export interface PreviewResponse {
  title: string;
  genre: string;
  status: string;
}

export interface PreviewState {
  loading: boolean;
  data: PreviewResponse | null;
  notFound: boolean;
  started: boolean;
}

export default function JoinPage() {
  const params = useParams<{ token?: string }>();
  const searchToken = new URLSearchParams(window.location.search).get("token");
  const token = params.token || searchToken || null;
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    loading: !!token,
    data: null,
    notFound: false,
    started: false,
  });
  const navigate = useNavigate();
  const session = useSession();

  // Invitation links pre-fill the code and preview the room identity.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .get<PreviewResponse>(`/api/join/preview?token=${encodeURIComponent(token)}`)
      .then((data) => {
        if (cancelled) return;
        setPreview({ loading: false, data, notFound: false, started: data.status === "started" });
      })
      .catch(() => {
        if (cancelled) return;
        setPreview({ loading: false, data: null, notFound: true, started: false });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const out = await api.post<{ room: { code: string } }>("/api/rooms/join", {
        code: code.trim().toUpperCase(),
        invitationToken: token ?? undefined,
        displayName: displayName.trim(),
      });
      navigate(`/room/${out.room.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not join. Try again.");
      setLoading(false);
    }
  };

  return (
    <main className="page">
      <div className="page-content">
        <Link to="/" className="wordmark wordmark-lg wordmark-underline" aria-label="Back to home">
          EMPIRE
        </Link>
        <h2 style={{ fontSize: 26 }}>Join a game</h2>
        {preview.loading ? (
          <p className="skeleton">Opening invitation…</p>
        ) : preview.notFound ? (
          <p className="error-text" role="alert">
            <span aria-hidden="true">⚠</span> That invite link isn't valid any more. Ask the organiser for a new one.
          </p>
        ) : null}
        {preview.data && (
          <div className="panel">
            <h3 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 20 }}>{preview.data.title}</h3>
            <p style={{ margin: "4px 0 0" }}>
              Genre: <strong>{preview.data.genre}</strong>
            </p>
            {preview.started && (
              <p className="status-text" role="status">
                This round has already started. You'll need to be invited for the next round.
              </p>
            )}
          </div>
        )}
        <form onSubmit={submit} noValidate>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Field label="Room code" hint="Six letters and numbers from the organiser.">
              <Input
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
                disabled={!!token}
                required
                inputMode="text"
                autoCapitalize="characters"
                aria-label="Room code"
              />
            </Field>
            <Field label="Your display name" hint="1–24 characters; must be unique in the room.">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={24}
                autoComplete="nickname"
              />
            </Field>
            <ErrorBanner error={error} />
            <Button type="submit" className="btn-primary btn-cta" loading={loading}>
              Join game
            </Button>
          </div>
        </form>
        {!session.signedIn && (
          <p className="status-text">
            You can play as a guest. <Link to="/sign-in">Sign in</Link> if you have an account.
          </p>
        )}
      </div>
    </main>
  );
}
