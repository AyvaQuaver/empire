/*
 * The reading speech machine. Deliberately UI-independent so it can be unit
 * tested with a fake adapter (vitest) and checked against real speechSynthesis
 * in a browser. It is a state machine: component re-renders cannot enqueue
 * duplicate utterances because enqueueing happens only through explicit
 * start/restart calls, and each start invalidates previous runs.
 */

export interface SpeechAdapter {
  /** Speak a phrase; resolves when the utterance is done, rejects on error. */
  speak(text: string, opts?: { slow?: boolean }): Promise<void>;
  /** Stop/cancel any utterance immediately. */
  cancel(): void;
}

// (RunPhase / RunStatus types are defined below, next to the state machine.)

export type RunPhase =
  | "idle"
  | "announcing"
  | "speaking"
  | "pausing"
  | "pause-requested" // stop before the next utterance
  | "paused" // parked at an exact cursor
  | "recovering" // failed/expired lease; restart from the reading's start
  | "done"
  | "failed";

/** Where playback would continue: index refers to the next unspoken word of
 * `readingNumber`; `-1` means the reading's announcement hasn't been spoken. */
export interface RunCursor {
  readingNumber: number;
  index: number; // -1 = announcement pending
  totalWords: number;
}

export interface RunStatus {
  phase: RunPhase;
  readingNumber: number | null;
  /** During playback: index of the word currently handled; while paused: the NEXT word to speak. */
  wordIndex: number | null;
  totalWords: number;
}

export type RunHooks = {
  isCurrent?: () => boolean;
  onWordComplete?: (index: number) => void | Promise<void>;
  onReadingComplete?: () => void | Promise<void>;
};

export type RunOutcome = "done" | "cancelled" | "failed" | "paused";

const NUMBER_WORDS = ["one", "two", "three"] as const;

export class SpeechRunner {
  private adapter: SpeechAdapter;
  private runId = 0;
  private invalidators = new Map<number, () => void>();
  private listeners = new Set<(s: RunStatus) => void>();
  private status: RunStatus = { phase: "idle", readingNumber: null, wordIndex: null, totalWords: 0 };
  // pause bookkeeping
  private pauseFlag = false;
  private cursor: RunCursor | null = null;
  private activeHooks: RunHooks | null = null;

  private pauseMs: number;

  constructor(adapter: SpeechAdapter, private opts?: { pauseMs?: number }) {
    this.adapter = adapter;
    // 1s speaker default; the server-authoritative round value seeds the UI.
    this.pauseMs = opts?.pauseMs ?? 1000;
  }

  /** Update the inter-word gap live: a change while paused applies at the next
   * gap (no restart, no cursor movement). Values are clamped defensively; the
   * server validates the allowed set for round persistence. */
  setPauseMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.pauseMs = Math.round(ms);
  }

  get currentPauseMs(): number {
    return this.pauseMs;
  }

  subscribe(fn: (s: RunStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(patch: Partial<RunStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  /** Pause at the next utterance boundary; the in-flight utterance finishes. */
  requestPause(): void {
    if (this.running) {
      this.pauseFlag = true;
      this.emit({ phase: "pause-requested" });
    }
  }

  get isPaused(): boolean {
    return this.status.phase === "paused";
  }

  get cursorState(): RunCursor | null {
    return this.cursor;
  }

  /**
   * Run one reading: announce "Reading N", speak each word with a pause after,
   * then call onReadingComplete and resolve. With `resumeIndex >= -1`, the run
   * resumes at an exact cursor instead of the announcement; already-spoken
   * words are neither repeated nor re-acked.
   * Resolves: "done" | "cancelled" | "failed" | "paused".
   */
  async run(
    readingNumber: number,
    words: string[],
    hooks?: RunHooks,
    resumeIndex: number | null = null,
  ): Promise<RunOutcome> {
    const id = ++this.runId;
    const invalidated = new Promise<"invalidated">((resolve) => {
      this.invalidators.set(id, () => resolve("invalidated"));
    });
    this.adapter.cancel();
    this.pauseFlag = false;
    this.activeHooks = hooks ?? null;
    // The inter-word gap reads the LIVE value: setPauseMs between utterances
    // (a paused change) applies at the next gap without restarting the run.
    const current = (): boolean =>
      id === this.runId && (hooks?.isCurrent ? hooks.isCurrent() : true);
    const first = resumeIndex === null || resumeIndex < -1 ? -1 : resumeIndex;
    try {
      // If the cursor is at -1 (or a fresh run), speak the announcement first.
      if (first === -1) {
        this.cursor = { readingNumber, index: -1, totalWords: words.length };
        this.emit({ phase: "announcing", readingNumber, wordIndex: null, totalWords: words.length });
        const said = await this.speakOrCancel(`Reading ${NUMBER_WORDS[readingNumber - 1] ?? readingNumber}`, current, invalidated);
        if (!said) {
          if (current()) this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
          return "cancelled";
        }
        if (this.maybePause()) {
          this.cursor = { readingNumber, index: 0, totalWords: words.length };
          this.emit({ phase: "paused", readingNumber, wordIndex: 0, totalWords: words.length });
          return "paused";
        }
      }
      for (let i = first === -1 ? 0 : first; i < words.length; i++) {
        if (!current()) {
          this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
          return "cancelled";
        }
        // A pause requested DURING the inter-word delay must land BEFORE the
        // next word: park at the exact next word (never speak it), with the
        // same bookkeeping as a boundary pause.
        if (this.maybePause()) {
          this.cursor = { readingNumber, index: i, totalWords: words.length };
          this.emit({ phase: "paused", readingNumber, wordIndex: i, totalWords: words.length });
          return "paused";
        }
        this.cursor = { readingNumber, index: i, totalWords: words.length };
        this.emit({ phase: "speaking", wordIndex: i });
        const ok = await this.speakOrCancel(words[i], current, invalidated);
        if (!ok) {
          if (current()) this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
          return "cancelled";
        }
        if (hooks?.onWordComplete) {
          await hooks.onWordComplete(i);
          if (!current()) {
            this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
            return "cancelled";
          }
        }
        // Pause may be requested during the LAST word: still complete THIS
        // reading's server-side bookkeeping (below) before pausing, so the
        // next cursor is the next reading's announcement — never a repeat
        // or a skip.
        if (this.pauseFlag) {
          this.pauseFlag = false;
          if (i === words.length - 1) {
            if (hooks?.onReadingComplete) {
              await hooks.onReadingComplete();
              if (!current()) {
                this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
                return "cancelled";
              }
            }
            this.cursor = null; // next utterance belongs to the NEXT reading
            this.emit({ phase: "paused", readingNumber: null, wordIndex: null });
            return "paused";
          }
          this.cursor = { readingNumber, index: i + 1, totalWords: words.length };
          this.emit({ phase: "paused", readingNumber, wordIndex: i + 1, totalWords: words.length });
          return "paused";
        }
        this.emit({ phase: "pausing" });
        await this.pause(this.pauseMs, current);
      }
      if (!current()) {
        this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
        return "cancelled";
      }
      if (hooks?.onReadingComplete) {
        await hooks.onReadingComplete();
        if (!current()) {
          this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
          return "cancelled";
        }
      }
      this.cursor = null;
      this.emit({ phase: "done", wordIndex: null, readingNumber: null });
      return "done";
    } catch {
      // Speech failure: expose a recoverable state, not raw browser errors.
      this.cursor = null;
      if (current()) this.emit({ phase: "failed", wordIndex: null });
      return "failed";
    } finally {
      this.invalidators.delete(id);
      if (this.status.phase !== "paused") this.activeHooks = null;
    }
  }

  private maybePause(): boolean {
    if (!this.pauseFlag) return false;
    this.pauseFlag = false;
    return true;
  }

  cancel(): void {
    this.runId++; // invalidates every in-flight run loop
    this.pauseFlag = false;
    this.cursor = null;
    this.activeHooks = null;
    for (const resolve of this.invalidators.values()) resolve();
    this.adapter.cancel();
    this.emit({ phase: "idle", wordIndex: null, readingNumber: null });
  }

  get running(): boolean {
    return this.status.phase === "announcing" || this.status.phase === "speaking" || this.status.phase === "pausing" || this.status.phase === "pause-requested";
  }

  private async speakOrCancel(
    text: string,
    current: () => boolean,
    invalidated: Promise<"invalidated">,
  ): Promise<boolean> {
    if (!current()) return false;
    const spoken = this.adapter.speak(text).then(
      () => true,
      (err) => {
        throw err;
      },
    );
    const outcome = await Promise.race([spoken, invalidated]);
    if (outcome === "invalidated") return false;
    return current();
  }

  private pause(ms: number, current: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const id = this.runId;
      const t = setTimeout(() => {
        clearInterval(check);
        resolve();
      }, ms);
      const check = setInterval(() => {
        if (id !== this.runId || !current()) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }
}

// ---- Browser speechSynthesis adapter ---------------------------------

export interface BrowserVoiceSupport {
  supported: boolean;
  reason?: string;
}

export function speechSupport(): BrowserVoiceSupport {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return { supported: false, reason: "no-synthesis" };
  }
  if (!("SpeechSynthesisUtterance" in window)) {
    return { supported: false, reason: "no-utterance" };
  }
  return { supported: true };
}

/**
 * Creates an adapter over window.speechSynthesis with selectable voices:
 *  - `listVoices()` surfaces device voices (async population tolerated) with a
 *    display name + language label; English voices are listed first.
 *  - `getVoice()` / `setVoice(nameOrUri)` pick the utterance voice; a
 *    remembered preference is validated against the CURRENT device list and
 *    falls back automatically when it no longer exists (voices don't transfer
 *    between devices).
 *  - utterances never fire for a voice the device lacks.
 * Includes a watchdog for stalled engines.
 */
export interface VoiceOption {
  name: string;
  lang: string;
  label: string; // human-readable "Name — Lang (region)"
  uri: string; // stable per-device identity: `name:lang`
  english: boolean;
}

/** Neutral sample for Test voice — never derived from secret submissions. */
export const VOICE_SAMPLE_TEXT = "This is how the readings will sound.";

export function createBrowserAdapter(): SpeechAdapter & {
  listVoices: () => VoiceOption[];
  getVoice: () => VoiceOption | null;
  setVoice: (nameOrUri: string) => VoiceOption | null;
  refreshVoices: () => void;
  onVoicesChanged: (fn: () => void) => () => void;
} {
  let selected: VoiceOption | null = null;
  const listeners = new Set<() => void>();
  const stallTimeoutMs = 20000;

  const labelFor = (v: SpeechSynthesisVoice): string => {
    // e.g. "en-GB" → "English (GB)"
    const shortLang = v.lang.replace(/[-_].*$/, "").toLowerCase();
    const langNames: Record<string, string> = {
      en: "English",
      fr: "French",
      de: "German",
      es: "Spanish",
      nl: "Dutch",
      it: "Italian",
      da: "Danish",
      sv: "Swedish",
      nb: "Norwegian",
      pt: "Portuguese"
    };
    const langName = langNames[shortLang] ?? v.lang;
    const region = v.lang.replace(/^[^-_]+[-_]*/, "");
    const regionPart = region ? ` (${region})` : "";
    return `${v.name} — ${langName}${regionPart}`;
  };

  const allVoices = (): VoiceOption[] =>
    (window.speechSynthesis.getVoices() ?? []).map((v) => ({
      name: v.name,
      lang: v.lang,
      label: labelFor(v),
      uri: `${v.name}:${v.lang}`,
      english: /en[-_.]/i.test(v.lang) || /^en$/i.test(v.lang),
    }));

  const pickVoice = () => {
    const voices = allVoices();
    if (voices.length === 0) return;
    // A remembered preference wins if it still exists on THIS device.
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem("empire.voice");
    } catch {
      realized = true; // inaccessible storage: fall back silently
    }
    void realized;
    if (remembered) {
      const match = voices.find((v) => v.uri === remembered);
      if (match) {
        selected = match;
        return;
      }
      // remembered voice is not on this device: clear and fall back
      try {
        window.localStorage.removeItem("empire.voice");
      } catch {
        // ignore
      }
    }
    const english = voices.filter((v) => v.english);
    const pool = english.length > 0 ? english : voices;
    const byUsefulness = (v: VoiceOption) =>
      (/female|samantha|serena|karen|nicky/i.test(v.name) ? 0 : 1) +
      (v.lang.startsWith("en-GB") ? 0 : 2);
    const sorted = [...pool].sort((a, b) => byUsefulness(a) - byUsefulness(b));
    selected = sorted[0] ?? null;
  };

  let realized = false;
  // voices load asynchronously on some platforms
  pickVoice();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.addEventListener?.("voiceschanged", () => {
        pickVoice();
        for (const fn of listeners) fn();
      });
    } catch {
      // older engines: keep the first usable voice
    }
  }

  return {
    speak(text: string): Promise<void> {
      return new Promise((resolve, reject) => {
        try {
          const synth = window.speechSynthesis;
          const utter = new SpeechSynthesisUtterance(text);
          if (selected) {
            utter.voice = window.speechSynthesis
              .getVoices()
              .find((v) => `${v.name}:${v.lang}` === selected?.uri) ?? null;
            if (utter.voice) utter.lang = utter.voice.lang;
          }
          let settled = false;
          const finish = (err?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            if (err) reject(err);
            else resolve();
          };
          utter.onend = () => finish();
          utter.onerror = (e) => finish(new Error(`speech-error:${(e as SpeechSynthesisErrorEvent).error ?? "unknown"}`));
          const watchdog = setTimeout(() => finish(new Error("speech-error:stalled")), stallTimeoutMs);
          synth.speak(utter);
        } catch (err) {
          reject(err);
        }
      });
    },
    cancel(): void {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    },
    listVoices: () => {
      // English voices first, then everything else
      const voices = allVoices();
      return [...voices.filter((v) => v.english), ...voices.filter((v) => !v.english)];
    },
    getVoice: () => {
      if (!selected) pickVoice();
      return selected;
    },
    setVoice: (nameOrUri: string) => {
      const voices = allVoices();
      const match =
        voices.find((v) => v.uri === nameOrUri) ??
        voices.find((v) => v.name === nameOrUri) ??
        voices.find((v) => v.name.toLowerCase() === nameOrUri.toLowerCase());
      if (!match) {
        // requested voice isn't on this device: keep/recompute the fallback
        pickVoice();
        return null;
      }
      selected = match;
      try {
        window.localStorage.setItem("empire.voice", match.uri);
      } catch {
        // inaccessible storage: the in-memory selection still applies
      }
      return match;
    },
    refreshVoices: () => {
      pickVoice();
      for (const fn of listeners) fn();
    },
    onVoicesChanged: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
