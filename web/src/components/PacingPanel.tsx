import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RoomSnapshot } from "../lib/api";
import { Button } from "./ui";

export interface PacingOption {
  ms: number;
  label: string;
}

/** Allowed values (mirror of the server's; the server also validates). */
export const PACING_OPTIONS: PacingOption[] = [
  { ms: 1000, label: "1 second — Recommended" },
  { ms: 1500, label: "1.5 seconds" },
  { ms: 2000, label: "2 seconds" },
  { ms: 3000, label: "3 seconds" },
];

export const PACING_PREF_KEY = "empire.wordpause";
export const DEFAULT_PACING_MS = 1000;

/** Load the speaker's saved preference; timing values are safe to store
 * locally. Falls back to the round/server default when missing or invalid. */
export function savedPacingPref(fallbackMs: number): number {
  try {
    const remembered = Number(window.localStorage.getItem(PACING_PREF_KEY));
    const allowed = PACING_OPTIONS.some((o) => o.ms === remembered);
    if (allowed) return remembered;
    window.localStorage.setItem(PACING_PREF_KEY, String(fallbackMs));
  } catch {
    // inaccessible storage: fall back silently
  }
  return fallbackMs;
}

/** Round-authoritative inter-word pacing: the server value is the truth for
 * the active round (replacement speakers inherit it); changes are saved to the
 * server and mirrored locally so a NEW round starts from the speaker's saved
 * preference with a 1s fallback. */
export function useSpeakerPacing(snap: RoomSnapshot) {
  const serverValue = snap.round.wordPauseMs ?? DEFAULT_PACING_MS;
  const [valueMs, setValueMs] = useState<number>(serverValue);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValueMs(serverValue);
  }, [serverValue, snap.round.id]);

  const setPacing = async (ms: number) => {
    if (saving) return;
    if (!PACING_OPTIONS.some((o) => o.ms === ms)) {
      setError("Unsupported pause between words.");
      return;
    }
    setValueMs(ms);
    try {
      window.localStorage.setItem(PACING_PREF_KEY, String(ms));
    } catch {
      // inaccessible storage: the in-memory selection still applies
    }
    setSaving(true);
    try {
      await api.post(`/api/rounds/${snap.round.id}/word-pause`, { ms });
      setError(null);
    } catch (err) {
      setValueMs(serverValue);
      setError(err instanceof Error ? err.message : "Could not save the pacing change.");
    } finally {
      setSaving(false);
    }
  };

  return { valueMs, setPacing, error, saving, disabled: () => saving };
}

/** Neutral pacing sample: two sample utterances separated by the chosen gap so
 * the user can hear the difference; never a submitted word. */
export async function speakPacingSample(
  speak: (text: string) => Promise<void>,
  delay: (ms: number) => Promise<void>,
  gapMs: number,
): Promise<void> {
  await speak("Pace sample.");
  await delay(gapMs);
  await speak("This is the pause after each word.");
}

/** Shared pacing presentation for the speaker's ready screen and the paused
 * reading panel. Server-authoritative; the select mirrors the allowed set
 * (the server re-validates every change). */
export function PacingPanel({
  valueMs,
  disabled,
  onSelect,
  testPacing,
}: {
  valueMs: number;
  disabled: boolean;
  onSelect: (ms: number) => void;
  testPacing?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="panel-heading" style={{ margin: 0 }}>
        Pause between words
      </p>
      <select
        className="input"
        aria-label="Pause between words"
        disabled={disabled}
        onChange={(e) => onSelect(Number(e.target.value))}
        value={valueMs}
      >
        {PACING_OPTIONS.slice()
          .sort((a, b) => a.ms - b.ms)
          .map((o) => (
            <option key={o.ms} value={o.ms}>
              {o.label}
            </option>
          ))}
      </select>
      <p className="status-text" style={{ margin: 0 }}>
        Time to remember each word before the next one is spoken.
      </p>
      {testPacing && (
        <Button className="btn-ghost" disabled={disabled} onClick={() => testPacing()}>
          Hear this pacing
        </Button>
      )}
    </div>
  );
}
