import { describe, it, expect } from "vitest";
import { SpeechRunner, type SpeechAdapter } from "../../web/src/lib/speech.js";

/* The speech state machine is tested with a fake adapter: sequencing waits for
 * completion events, errors propagate to a failed phase, cancellation stops
 * cleanly, and calling run() again (as a re-render could) can't create an
 * overlapping second run — the latest token wins and the old loop stops. */

interface FakeAdapter extends SpeechAdapter {
  spoken: string[];
  failNext: boolean;
  pendingResolve: (() => void)[];
}

function fakeAdapter(): FakeAdapter {
  const fake: FakeAdapter = {
    spoken: [] as string[],
    failNext: false,
    pendingResolve: [],

    speak(text: string): Promise<void> {
      this.spoken.push(text);
      if (this.failNext) {
        this.failNext = false;
        return Promise.reject(new Error("speech-error:interrupted"));
      }
      return new Promise((resolve) => {
        this.pendingResolve.push(resolve);
      });
    },
    cancel(): void {
      // resolve nothing; real engine cancels — the runner must tolerate that.
    },
  };
  return fake;
}

const PAUSE = 30;

/** Resolves utterances as they appear, settling up to `count`; keeps waiting
 * (short, bounded waits) for the next one because word pacing involves pauses. */
async function drain(adapter: FakeAdapter, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    for (;;) {
      if (adapter.pendingResolve.length > 0) break;
      if (Date.now() - t0 > 1000) return; // settled; no further utterance appeared
      await new Promise((r) => setTimeout(r, 5));
    }
    const pending = adapter.pendingResolve;
    adapter.pendingResolve = [];
    pending.forEach((r2) => r2());
    // let the runner observe the completion before the next wait
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("SpeechRunner", () => {
  it("waits for completion events between words and acks each one", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    const acks: number[] = [];
    const runPromise = runner.run(1, ["alpha", "beta"], {
      onWordComplete: (i) => {
        acks.push(i);
      },
    });
    // utterances: announcement + two words, each resolved by hand (completion events)
    await drain(adapter, 3);
    const result = await runPromise;
    expect(result).toBe("done");
    expect(adapter.spoken).toEqual(["Reading one", "alpha", "beta"]);
    expect(acks).toEqual([0, 1]);
  });

  it("propagates speech failure to a failed phase and stops cleanly", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    adapter.failNext = true;
    const result = await runner.run(2, ["one"], {
      onWordComplete: () => undefined,
    });
    expect(result).toBe("failed");
  });

  it("a revoked lease (server rejects the ack) halts queueing of further words", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    // The server rejects everything after the first word: the transfer killed
    // this device's lease. The chain must NOT queue remaining words.
    const runPromise = runner.run(1, ["one", "two", "three"], {
      onWordComplete: (index) => {
        if (index >= 1) {
          const e = new Error("403 Someone else is speaking on this device.");
          throw e;
        }
      },
    });
    // announcement + first word spoken, second word already in flight when the
    // ack is rejected — everything after that ("three") is NOT queued
    await drain(adapter, 3);
    const result = await runPromise;
    expect(result).toBe("failed");
    expect(adapter.spoken).toEqual(["Reading one", "one", "two"]);
  });

  it("cancellation invalidates the running loop before the next utterance", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    const promise = runner.run(1, ["a", "b", "c"], { onWordComplete: () => undefined });
    await new Promise((r) => setTimeout(r, 10));
    runner.cancel(); // invalidates tokens
    expect(adapter.spoken.length).toBeLessThanOrEqual(2);
    // resolve the last dangling utterance; the runner should still end as cancelled
    const pending = adapter.pendingResolve.slice();
    adapter.pendingResolve = [];
    for (const r of pending) r();
    const result = await promise;
    expect(result).toBe("cancelled");
  });

  it("cannot be triggered twice by two renders: the second run wins", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    const first = runner.run(1, ["x"], { isCurrent: () => true });
    const second = runner.run(1, ["y"], { isCurrent: () => true });
    await new Promise((r) => setTimeout(r, 20));
    // Drain whatever is pending; the superseded first run never adds utterances
    // after cancellation, and the second completes normally.
    await new Promise((r) => setTimeout(r, 20));
    const saga = adapter.spoken.filter((w) => w === "x" || w === "y");
    void saga;
    void drain;
    await drain(adapter, 2);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r2).toBe("done");
    expect(r1).toBe("cancelled");
    expect(adapter.spoken).toContain("y");
  });

  it("three readings are announced in order with number words", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    for (let n = 1; n <= 3; n++) {
      const p = runner.run(n, ["w"], { onWordComplete: () => undefined });
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 5));
        const pending = adapter.pendingResolve;
        adapter.pendingResolve = [];
        pending.forEach((r2) => r2());
      }
      expect(await p).toBe("done");
    }
    expect(adapter.spoken.filter((_, i) => i % 2 === 0)).toEqual(["Reading one", "Reading two", "Reading three"]);
  });
});
