import { useRef, useState } from "react";
import type { RoomSnapshot } from "../../lib/api";
import { api } from "../../lib/api";
import { speechSupport, createBrowserAdapter } from "../../lib/speech";
import { Avatar, Button, ErrorBanner, Field, Input, Panel, ReadyBadge } from "../../components/ui";
import { Page } from "../../App";

type Act = (fn: () => Promise<unknown>) => () => Promise<void>;

// Word entry: "Pick your secret identity." One private field; after submit the
// plaintext is cleared from component state. Others only show readiness.
export function WordEntryView({ snap, error, act }: { snap: RoomSnapshot; error: string | null; act: Act }) {
  const isReady = snap.round.state === "ready_to_read";
  const catchable = act;
  const [word, setWord] = useState("");
  const [savedWord, setSavedWord] = useState(snap.myWord); // still owns their own word
  const [changing, setChanging] = useState(snap.myWord === null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [speakingTest, setSpeakingTest] = useState(false);
  const wordRef = useRef<HTMLInputElement>(null);
  void wordRef;

  // Late joiners wait for the next round.
  if (!snap.me.inRoster) {
    return (
      <Page>
        <h1 style={{ fontSize: 30 }}>{snap.room.title}</h1>
        <p className="error-text" role="alert">
          <span aria-hidden="true">⏳</span> This round has started. Ask the organiser to invite you for the next round.
        </p>
        <Panel heading="Players in this room">
          {snap.players.map((p) => (
            <div className="player-row" key={p.playerId}>
              <Avatar name={p.displayName} playerId={p.playerId} />
              <span className="player-name">{p.displayName}</span>
              {p.isOrganiser && <span className="badge">Organiser</span>}
            </div>
          ))}
        </Panel>
      </Page>
    );
  }

  const submitWord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFieldError(null);
    setSaveError(null);
    try {
      await api.put(`/api/rooms/${snap.room.code}/my-word`, { word });
      // Clear the submitted plaintext from state as soon as it isn't needed.
      setSavedWord(word.trim());
      setWord("");
      setChanging(false);
    } catch (err) {
      // Map stable server codes to neutral copy. Duplicates never name an owner.
      if (err instanceof Error && err.message.match(/taken/i)) setFieldError("That word is already taken. Try another.");
      else if (err instanceof Error) setFieldError(err.message);
      else setFieldError("Could not save. Try again.");
      setSaveError(null);
    } finally {
      setSaving(false);
    }
  };

  const support = speechSupport();
  const testSound = async () => {
    setSpeakingTest(true);
    try {
      const adapter = createBrowserAdapter();
      await adapter.speak("This is how the words will sound.");
    } catch {
      setFieldError("Sound test didn't work. Try Start readings anyway, or check device volume.");
    } finally {
      setSpeakingTest(false);
    }
  };

  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>Pick your secret identity</h1>
      <div className="panel" style={{ textAlign: "center" }}>
        <p className="panel-heading" style={{ marginBottom: 4 }}>
          Genre
        </p>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24 }}>{snap.room.genre}</div>
      </div>

      {changing && snap.canSubmitWord ? (
        <form onSubmit={submitWord}>
          <Field label="Your secret word" hint="1–40 characters. Keep it to yourself!">
            <Input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              required
              maxLength={40}
              autoComplete="off"
              aria-label="Your secret word"
            />
          </Field>
          {fieldError && (
            <p className="error-text" role="alert">
              <span aria-hidden="true">⚠</span> {fieldError}
            </p>
          )}
          <ErrorBanner error={saveError} />
          <Button type="submit" className="btn-primary btn-cta" loading={saving}>
            {savedWord ? "Save new word" : "Submit word"}
          </Button>
          {savedWord && (
            <Button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setChanging(false);
                setWord("");
              }}
            >
              Back
            </Button>
          )}
        </form>
      ) : (
        <div className="panel" style={{ textAlign: "center" }}>
          <p style={{ margin: 0 }}>
            <strong role="status">Your word is saved</strong> 🔒
          </p>
          {snap.canSubmitWord && (
            <Button className="btn-ghost" onClick={() => setChanging(true)}>
              Change my word
            </Button>
          )}
        </div>
      )}

      <Panel heading={`Readiness — ${snap.readiness ? `${snap.readiness.ready} of ${snap.readiness.total} ready` : ""}`}>
        {snap.players.map((p) => (
          <div className="player-row" key={p.playerId}>
            <Avatar name={p.displayName} playerId={p.playerId} />
            <span className="player-name">
              {p.displayName} {p.isOrganiser && <span className="badge">Organiser</span>}
            </span>
            <ReadyBadge ready={p.ready} />
          </div>
        ))}
      </Panel>

      {isReady && snap.me.isOrganiser && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p role="status" style={{ margin: 0, textAlign: "center", fontWeight: 700 }}>
            Everyone is ready!
          </p>
          {!support.supported && (
            <p className="error-text" role="alert">
              <span aria-hidden="true">⚠</span> This device can't speak out loud. Have someone use a phone or computer
              that can — their device reads all three readings aloud so everyone plays together. No words are ever
              displayed on screen.
            </p>
          )}
          {support.supported && (
            <Button className="btn-secondary btn-cta" onClick={catchable(testSound)} loading={speakingTest}>
              Test sound
            </Button>
          )}
          <p className="status-text" style={{ margin: 0, textAlign: "center" }}>
            Turn up your volume and keep this screen open.
          </p>
          <Button className="btn-primary btn-cta" onClick={catchable(() => apiStart(snap.room.code))} disabled={!support.supported}>
            Start readings
          </Button>
        </div>
      )}
      {isReady && !snap.me.isOrganiser && (
        <p className="status-text" role="status" style={{ textAlign: "center" }}>
          Waiting for the organiser to start…
        </p>
      )}
      {snap.round.state === "collecting_words" && snap.room.state === "open" && !isReady && !snap.me.isOrganiser && (
        <p className="status-text" role="status" style={{ textAlign: "center" }}>
          Waiting for everyone to submit a word…
        </p>
      )}
      {!snap.me.isOrganiser && (
        <Button className="btn-ghost" onClick={catchable(() => apiLeave(snap.room.code))}>
          Leave game
        </Button>
      )}
      <ErrorBanner error={error} />
    </Page>
  );
}

const apiStart = (code: string) =>
  api.post(`/api/rooms/${code}/reading/start`).then(() => {
    // Marks the single-tap journey: ReadingView may auto-run the three saved
    // readings on THIS device only, and only for a fresh reading position.
    try {
      sessionStorage.setItem("empire-just-started", "1");
    } catch {
      // private-browsing quota issues: auto-run simply won't engage
    }
    return undefined;
  });
const apiLeave = (code: string) => api.post(`/api/rooms/${code}/leave`);
