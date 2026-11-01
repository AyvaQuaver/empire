import { useEffect, useRef, useState } from "react";
import { createBrowserAdapter, VOICE_SAMPLE_TEXT } from "../lib/speech";
import { Button } from "./ui";

export type VoiceOption = { name: string; lang: string; label: string; uri: string; english: boolean };

/**
 * Voice & accent for the device that will speak. Device-local lists only:
 * no promise about accents that don't exist, remembered voices are validated
 * against what is actually available, samples are never secret words.
 */
export function useSpeakerVoice(supported: boolean) {
  const adapterRef = useRef<ReturnType<typeof createBrowserAdapter> | null>(null);
  if (!adapterRef.current && supported) {
    adapterRef.current = createBrowserAdapter();
  }
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [currentVoice, setCurrentVoice] = useState<{ label: string } | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    // read-only: refreshVoices() notifies listeners; calling it here would loop
    const load = () => {
      setVoices(adapter.listVoices());
      const v = adapter.getVoice();
      setCurrentVoice(v ? { label: v.label } : null);
    };
    const poll = window.setInterval(() => {
      if (adapter.listVoices().length > 0) {
        window.clearInterval(poll);
        return;
      }
      load();
    }, 500);
    const giveUp = window.setTimeout(() => window.clearInterval(poll), 15000);
    const off = adapter.onVoicesChanged(load);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(giveUp);
      off();
    };
  }, [adapterRef]);

  const applyVoice = (uri: string) => {
    const adapter = adapterRef.current;
    if (!adapter || voiceBusy) return;
    const applied = adapter.setVoice(uri);
    const v = applied ?? adapter.getVoice();
    setCurrentVoice(v ? { label: v.label } : null);
  };

  const testVoice = (onError?: (message: string) => void) => {
    const adapter = adapterRef.current;
    if (!adapter || voiceBusy) return;
    setVoiceBusy(true);
    // Never overlap game playback: sampling happens while idle/paused only.
    adapter.cancel();
    adapter
      .speak(VOICE_SAMPLE_TEXT)
      .catch(() => onError?.("The test voice didn't play on this device. Try a different voice."))
      .finally(() => setVoiceBusy(false));
  };

  return { adapterRef, voices, currentVoice, voiceBusy, applyVoice, testVoice };
}

/** Shared presentation used on the ready-to-read screen and the speaker view. */
export function VoicePanel({
  voices,
  currentLabel,
  disabled,
  onApply,
  onTest,
}: {
  voices: VoiceOption[];
  currentLabel: string | null;
  disabled: boolean;
  onApply: (uri: string) => void;
  onTest: () => void;
}) {
  const list = voices.filter((v) => v.english).concat(voices.filter((v) => !v.english));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="panel-heading" style={{ margin: 0 }}>Voice &amp; accent</p>
      {list.length === 0 ? (
        <p className="status-text" role="status">Looking for voices on this device…</p>
      ) : list.length === 1 ? (
        <p className="status-text" role="status">
          Voice: {list[0].label}
          {!list[0].english ? " (no English voice on this device — it will still read the English words)" : ""}
        </p>
      ) : (
        <select
          className="input"
          aria-label="Voice and accent"
          disabled={disabled}
          onChange={(e) => onApply(e.target.value)}
          value={currentLabel ?? list[0]?.label}
        >
          {list.map((v) => (
            <option key={v.uri} value={v.uri}>
              {v.label}
            </option>
          ))}
        </select>
      )}
      <Button className="btn-secondary" onClick={onTest} loading={disabled} disabled={disabled}>
        Test voice
      </Button>
      <p className="status-text" style={{ margin: 0 }}>
        Plays a neutral sample — never a submitted word.
      </p>
    </div>
  );
}
