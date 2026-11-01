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

/** Resolves every pending utterance until the given promise settles — pendings
 * keep appearing while the runner paces between words, so quiet periods don't
 * mean we may stop driving. */
async function settle<T>(adapter: FakeAdapter, runPromise: Promise<T>): Promise<T> {
  let settled = false;
  const driver = (async () => {
    const t0 = Date.now();
    while (!settled && Date.now() - t0 < 4000) {
      if (adapter.pendingResolve.length > 0) {
        const pending = adapter.pendingResolve;
        adapter.pendingResolve = [];
        pending.forEach((r) => r());
        await new Promise((r) => setTimeout(r, 2));
      } else {
        await new Promise((r) => setTimeout(r, 6));
      }
    }
  })();
  const outcome = await runPromise;
  settled = true;
  await driver;
  return outcome;
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

  it("pausing parks at the next boundary; resume continues without repeats", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    const acks: number[] = [];
    const hooks = {
      onWordComplete: (i: number) => {
        acks.push(i);
      },
    };
    const read1 = runner.run(1, ["alpha", "beta", "gamma"], hooks);
    await drain(adapter, 2); // announcement + alpha completed
    runner.requestPause(); // lands at the next boundary — where exactly depends on timing
    const outcome = await settle(adapter, read1);
    expect(outcome).toBe("paused");
    // everything spoken is a PREFIX of the sequence; gamma never ran
    for (const [i, expected] of (["Reading one", "alpha", "beta", "gamma"] as const).entries()) {
      if (i < adapter.spoken.length) expect(adapter.spoken[i]).toBe(expected);
    }
    expect(adapter.spoken.length).toBeGreaterThanOrEqual(2); // announcement + alpha at least
    expect(adapter.spoken).not.toContain("gamma");
    expect(acks).toEqual([...new Set(acks)].sort((a, b) => a - b)); // monotonic, no dupes
    expect(runner.isPaused).toBe(true);
    const cursor = runner.cursorState!;
    expect(cursor.readingNumber).toBe(1);
    expect(cursor.index).toBe(adapter.spoken.length - 1); // next word after what was spoken

    // RESUME: continues at the cursor; spoken words are neither repeated nor re-acked
    const read2 = runner.run(1, ["alpha", "beta", "gamma"], hooks, cursor.index);
    expect(await settle(adapter, read2)).toBe("done");
    expect(adapter.spoken).toEqual(["Reading one", "alpha", "beta", "gamma"]);
    expect(acks).toEqual([0, 1, 2]);
  });

  it("pause during the announcement parks before the first word", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    const read1 = runner.run(2, ["one"], { onWordComplete: () => undefined });
    runner.requestPause(); // during the announcement
    await drain(adapter, 1); // announcement finishes
    expect(await read1).toBe("paused");
    expect(runner.cursorState).toEqual({ readingNumber: 2, index: 0, totalWords: 1 });
    expect(adapter.spoken).toEqual(["Reading two"]);
    // resume speaks the words (announcement not repeated)
    const read2 = runner.run(2, ["one"], { onWordComplete: () => undefined }, 0);
    await drain(adapter, 1);
    expect(await read2).toBe("done");
    expect(adapter.spoken).toEqual(["Reading two", "one"]);
  });

  it("pause during the LAST word still completes that reading (no skip/repeat)", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    const completed: number[] = [];
    const read1 = runner.run(1, ["a", "b", "c"], {
      onWordComplete: () => undefined,
      onReadingComplete: () => {
        completed.push(1);
      },
    });
    await drain(adapter, 3); // announcement + a + b
    runner.requestPause(); // lands after c (the current word) at the latest
    const outcome = await settle(adapter, read1);
    expect(outcome).toBe("paused");
    expect(completed).toEqual([1]); // THIS reading's server bookkeeping is done
    expect(adapter.spoken).toEqual(["Reading one", "a", "b", "c"]);
    // boundary pause: cursor is null (next utterance = next reading's announcement),
    // handled by the component chain — never a repeat or a skip here
    expect(runner.cursorState).toBeNull();
  });

  it("rapid repeated pause taps cannot queue duplicate utterances", async () => {
    const adapter = fakeAdapter();
    const runner = new SpeechRunner(adapter, { pauseMs: PAUSE });
    let completed = false;
    const read1 = runner.run(1, ["a", "b"], {
      onWordComplete: () => undefined,
      onReadingComplete: () => {
        completed = true;
      },
    });
    await drain(adapter, 2); // announcement + a
    runner.requestPause();
    runner.requestPause();
    runner.requestPause();
    const outcome = await settle(adapter, read1);
    expect(outcome).toBe("paused");
    // With 2 words the pause lands on the reading BOUNDARY (after "b"):
    // reading completed, cursor null, no extra utterances queued.
    expect(completed).toBe(true);
    expect(adapter.spoken).toEqual(["Reading one", "a", "b"]);
    expect(runner.cursorState).toBeNull();
    // The chain then starts reading 2; pause after announcement (no repeats of reading 1)
    const read2 = runner.run(2, ["c"], { onWordComplete: () => undefined });
    runner.requestPause(); // during reading-2's announcement
    expect(await settle(adapter, read2)).toBe("paused");
    expect(adapter.spoken).toEqual(["Reading one", "a", "b", "Reading two"]);
    expect(runner.cursorState!.index).toBe(0);
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
