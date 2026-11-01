import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Button, Field, Input, ErrorBanner } from "../components/ui";
import { useSession } from "../App";

const SUGGESTED_GENRES = ["Animals", "Films", "Food", "Famous people"];

export interface CreateResponse {
  room: { code: string };
}

export default function CreatePage() {
  const session = useSession();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(session.username ?? "");
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const out = await api.post<CreateResponse>("/api/rooms", {
        displayName: displayName.trim(),
        title: title.trim() || undefined,
        genre: genre.trim(),
      });
      navigate(`/room/${out.room.code}`);
    } catch (err) {
      // Connectivity failures never destroy the form values.
      setError(err instanceof ApiError ? err.message : "Could not create the game. Try again.");
      setLoading(false);
    }
  };

  return (
    <main className="page">
      <div className="page-content">
        <Link to="/" className="wordmark wordmark-lg wordmark-underline" aria-label="Back to home">
          EMPIRE
        </Link>
        <h2 style={{ fontSize: 26 }}>Set up your game</h2>
        <form onSubmit={submit} noValidate>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Field label="Your display name" hint="How other players will see you. 1–24 characters.">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={24}
                autoComplete="nickname"
                invalid={!!error}
              />
            </Field>
            <Field label="Game name (optional)">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={60}
                placeholder={`${displayName.trim() || "Your"}'s game`}
                aria-label="Game name (optional)"
              />
            </Field>
            <Field label="Genre" hint="Choose a suggestion or enter your own — words fit this genre.">
              <Input
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                required
                maxLength={60}
                aria-label="Genre"
                placeholder="e.g. Animals"
              />
            </Field>
            {/* Suggestions, not a fixed list: chips fill the editable field above
                and the selection clears itself when the value is changed. */}
            <div aria-label="Genre suggestions" style={{ marginTop: -8 }}>
              <ul
                style={{
                  listStyle: "none",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  margin: 0,
                  padding: 0,
                }}
              >
                {SUGGESTED_GENRES.map((g) => {
                  const selected = genre.trim().toLowerCase() === g.toLowerCase();
                  return (
                    <li key={g}>
                      <button
                        type="button"
                        className={`chip${selected ? " chip-selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => setGenre(selected ? "" : g)}
                      >
                        {g}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <ErrorBanner error={error} />
            <Button type="submit" className="btn-primary btn-cta" loading={loading}>
              Create game
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
