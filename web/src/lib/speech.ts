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

export type RunPhase = "idle" | "announcing" | "speaking" | "pausing" | "done" | "failed";

export interface RunStatus {
  phase: RunPhase;
  readingNumber: number | null;
  /** 0-based index of the word currently being handled. */
  wordIndex: number | null;
  totalWords: number;
}

const NUMBER_WORDS = ["one", "two", "three"] as const;

export class SpeechRunner {
  private adapter: SpeechAdapter;
  private runId = 0;
  private invalidators = new Map<number, () => void>();
  private listeners = new Set<(s: RunStatus) => void>();
  private status: RunStatus = { phase: "idle", readingNumber: null, wordIndex: null, totalWords: 0 };

  constructor(adapter: SpeechAdapter, private opts?: { pauseMs?: number }) {
    this.adapter = adapter;
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

  /**
   * Run one reading: announce "Reading N", speak each word with a pause after,
   * then announce completion (starter announcement is explicit per spec).
   * Resolves true on natural completion, false when cancelled.
   * A run token guards against overlapping runs; only the newest run continues.
   */
  async run(
    readingNumber: number,
    words: string[],
    hooks?: {
      isCurrent?: () => boolean;
      onWordComplete?: (index: number) => void | Promise<void>;
      onReadingComplete?: () => void | Promise<void>;
    },
  ): Promise<"done" | "cancelled" | "failed"> {
    const id = ++this.runId;
    // Any utterance (even one already in flight) is raced against invalidation
    // so a cancelled/replaced run can never hang on a pending engine promise.
    const invalidated = new Promise<"invalidated">((resolve) => {
      this.invalidators.set(id, () => resolve("invalidated"));
    });
    this.adapter.cancel();
    const pauseMs = this.opts?.pauseMs ?? 1500;
    const current = (): boolean =>
      id === this.runId && (hooks?.isCurrent ? hooks.isCurrent() : true);
    this.emit({ phase: "announcing", readingNumber, wordIndex: null, totalWords: words.length });
    try {
      if (!(await this.speakOrCancel(`Reading ${NUMBER_WORDS[readingNumber - 1] ?? readingNumber}`, current, invalidated))) {
        if (current()) this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
        return "cancelled";
      }
      for (let i = 0; i < words.length; i++) {
        if (!current()) {
          this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
          return "cancelled";
        }
        this.emit({ phase: "speaking", wordIndex: i });
        const ok = await this.speakOrCancel(words[i], current, invalidated);
        if (!ok) {
          if (current()) this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
          return "cancelled";
        }
        // Acknowledge progress after each completed word.
        if (hooks?.onWordComplete) {
          await hooks.onWordComplete(i);
          if (!current()) {
            this.emit({ phase: "idle", readingNumber: null, wordIndex: null });
            return "cancelled";
          }
        }
        this.emit({ phase: "pausing" });
        await this.pause(pauseMs, current);
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
      this.emit({ phase: "done", wordIndex: null, readingNumber: null });
      return "done";
    } catch {
      // Speech failure: expose a recoverable state, not raw browser errors.
      if (current()) this.emit({ phase: "failed", wordIndex: null });
      return "failed";
    } finally {
      this.invalidators.delete(id);
    }
  }

  cancel(): void {
    this.runId++; // invalidates every in-flight run loop
    for (const resolve of this.invalidators.values()) resolve();
    this.adapter.cancel();
    this.emit({ phase: "idle", wordIndex: null, readingNumber: null });
  }

  get running(): boolean {
    return this.status.phase === "announcing" || this.status.phase === "speaking" || this.status.phase === "pausing";
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
 * Creates an adapter over window.speechSynthesis. Voice selection prefers an
 * available English voice, tolerating async voice-list loading. Includes a
 * watchdog for utterances that never fire end/error events (stalled engines).
 */
export function createBrowserAdapter(): SpeechAdapter & { setStallTimeoutMs?: (ms: number) => void } {
  let englishVoice: SpeechSynthesisVoice | null = null;
  const stallTimeoutMs = 20000;

  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return;
    englishVoice =
      voices.find((v) => /en[-_]/i.test(v.lang) && /female|samantha|serena|karen|nicky/i.test(v.name)) ??
      voices.find((v) => /en-GB/i.test(v.lang)) ??
      voices.find((v) => /en[-_]/i.test(v.lang)) ??
      voices[0] ??
      null;
  };
  // voices load asynchronously on some platforms
  pickVoice();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
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
          if (englishVoice) utter.voice = englishVoice;
          else pickVoice();
          if (englishVoice) utter.voice = englishVoice;
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
  };
}
