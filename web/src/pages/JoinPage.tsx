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
  // Manual code entry is only for people choosing the "Join with a code" route:
  // a resolved invitation hides the code field completely.
  const [manualRoute, setManualRoute] = useState(!token);
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    loading: !!token,
    data: null,
    notFound: false,
    started: false,
  });
  const navigate = useNavigate();
  const session = useSession();

  // Invitation links resolve automatically into room name + genre. Errors map
  // to friendly copy; an invalid link offers the manual code route instead.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setManualRoute(false);
    setLinkError(null);
    api
      .get<PreviewResponse>(`/api/join/preview?token=${encodeURIComponent(token)}`)
      .then((data) => {
        if (cancelled) return;
        setPreview({ loading: false, data, notFound: false, started: data.status === "started" });
        if (data.status === "started") {
          setLinkError("This round has already started — joining waits for the next one. Ask the organiser for a fresh link after the round ends.");
        } else if (data.status !== "open") {
          setLinkError("This game is no longer open for joins. Ask the organiser for a new invitation link.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview({ loading: false, data: null, notFound: true, started: false });
        setLinkError(
          err instanceof ApiError ? err.message : "That invite link isn't valid any more. Ask the organiser for a new one.",
        );
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
        code: manualRoute ? code.trim().toUpperCase() : undefined,
        invitationToken: manualRoute ? undefined : (token ?? undefined),
        displayName: displayName.trim(),
      });
      navigate(`/room/${out.room.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not join. Try again.");
      setLoading(false);
    }
  };

  const invalidOrDead = preview.notFound || (!!linkError && manualRoute);
  return (
    <main className="page">
      <div className="page-content">
        <Link to="/" className="wordmark wordmark-lg wordmark-underline" aria-label="Back to home">
          EMPIRE
        </Link>
        <h2 style={{ fontSize: 26 }}>{manualRoute ? "Join with a code" : "Join a game"}</h2>

        {/* Resolving an invitation never flashes the code-entry form */}
        {preview.loading ? (
          <p className="skeleton" role="status">
            Opening invitation…
          </p>
        ) : (
          <>
            {preview.notFound && (
              <>
                <p className="error-text" role="alert">
                  <span aria-hidden="true">⚠</span>{" "}
                  {linkError ?? "That invite link isn't valid any more. Ask the organiser for a new one."}
                </p>
                <Button className="btn-secondary btn-cta" onClick={() => setManualRoute(true)}>
                  Enter a room code instead
                </Button>
              </>
            )}

            {preview.data && (
              <div className="panel">
                <h3 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 20 }}>{preview.data.title}</h3>
                <p style={{ margin: "4px 0 0" }}>
                  Genre: <strong>{preview.data.genre}</strong>
                </p>
                {preview.started && (
                  <p className="status-text" role="status">
                    This round has already started. The organiser can invite you when the next round opens — keep this
                    link or ask for a fresh one then.
                  </p>
                )}
              </div>
            )}

            {preview.data?.status === "started" ? (
              <Link to="/" className="btn btn-secondary btn-cta">
                Back home
              </Link>
            ) : invalidOrDead ? null : (
              <form onSubmit={submit} noValidate>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {manualRoute && (
                    <Field label="Room code" hint="Six letters and numbers from the organiser.">
                      <Input
                        className="code-input"
                        value={code}
                        onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
                        required
                        inputMode="text"
                        autoCapitalize="characters"
                        aria-label="Room code"
                      />
                    </Field>
                  )}
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
            )}

            {manualRoute ? (
              <p className="status-text">
                If you don't have a code, ask the organiser for the invitation link.
              </p>
            ) : null}
            {!session.signedIn && (
              <p className="status-text">You can play as a guest — no account needed.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
