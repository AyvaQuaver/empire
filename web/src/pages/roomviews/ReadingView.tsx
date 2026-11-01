import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomSnapshot } from "../../lib/api";
import { api } from "../../lib/api";
import { SpeechRunner, createBrowserAdapter, speechSupport, type RunStatus } from "../../lib/speech";
import { Button, ErrorBanner, Panel, Avatar } from "../../components/ui";
import { Page } from "../../App";

type Act = (fn: () => Promise<unknown>) => () => Promise<void>;

/* Reading: "Listen closely."
 * - Exactly one speaker device holds a server-issued lease and receives the
 *   shuffled word-only array. Every other device shows listening status only.
 * - The runner is a UI-independent state machine; re-renders can't re-enqueue
 *   speech. Word position is acked server-side so refresh resumes at the
 *   current reading's start (a reading can be explicitly restarted).
 */

const EMPTY_STATUS: RunStatus = { phase: "idle", readingNumber: null, wordIndex: null, totalWords: 0 };

export function ReadingView({ snap, error, act }: { snap: RoomSnapshot; error: string | null; act: Act }) {
  const support = useMemo(speechSupport, []);
  const [leaseToken, setLeaseToken] = useState<string | null>(null);
  const leaseRef = useRef<string | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [status, setStatus] = useState<RunStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restartWarn, setRestartWarn] = useState(false);
  const runnerRef = useRef<SpeechRunner | null>(null);

  if (!runnerRef.current && support.supported) {
    runnerRef.current = new SpeechRunner(createBrowserAdapter());
  }

  useEffect(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    const off = runner.subscribe(setStatus);
    return () => {
      off();
      // Clean up speech + handlers on navigation; the lease expires server-side.
      runner.cancel();
    };
  }, []);

  const currentReading = snap.reading?.readingNumber ?? 1;
  const readingStarted = (snap.reading?.position ?? 0) > 0;
  const mine = snap.reading?.mine ?? false;
  const held = snap.reading?.held ?? false;

  // One tap total: the organiser's "Start readings" (WordEntryView) sets a
  // sessionStorage flag before navigation; on arrival here, the speaker device
  // auto-loads the saved list and runs all three readings + starter. Only a
  // fresh position (nobody started yet) auto-runs; recovery/claims never do.
  const autoStartRef = useRef<string | null>(
    typeof sessionStorage !== "undefined" ? sessionStorage.getItem("empire-just-started") : null,
  );
  const beTheSpeakerRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const runReadingsRef = useRef<((r: number, w: string[]) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!autoStartRef.current) {
      return;
    }
    if (words && snap.reading?.mine && snap.reading.position === 0) {
      // words loaded on this device with a fresh position: run the whole chain
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("empire-just-started");
      autoStartRef.current = null;
      void runReadingsRef.current?.(snap.reading.readingNumber ?? 1, words);
      return;
    }
    if (!words) {
      // ensure this device has its lease + the saved word list loaded
      void beTheSpeakerRef.current();
    }
    // deliberately narrow dependency watch: fires when words/lease state settles
  }, [snap.reading?.mine, snap.reading?.position, words, support.supported]);

  const wrap = act;

  const fetchWords = async (token: string, readingNumber: number): Promise<string[]> => {
    const out = await api.get<{ readingNumber: number; words: string[] }>(
      `/api/rounds/${snap.round.id}/reading/words?reading=${readingNumber}`,
      { "x-empire-lease": token },
    );
    return out.words;
  };

  const beTheSpeaker = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await api.post<{ leaseToken: string }>(`/api/rounds/${snap.round.id}/lease`, { action: "acquire" });
      setLeaseToken(out.leaseToken);
      leaseRef.current = out.leaseToken;
      const loaded = await fetchWords(out.leaseToken, snap.reading?.readingNumber ?? 1);
      setWords(loaded);
      // NOTE: this is recovery/claim — audio is NOT started automatically.
      // For the organiser's brand-new "Start readings" journey, the
      // just-started flag (set by WordEntryView) triggers the auto-run below.
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not become the speaker.");
    } finally {
      setBusy(false);
    }
  };

  const ackFor = (readingNumber: number) => async (index: number) => {
    await api.post(`/api/rounds/${snap.round.id}/reading/ack`, {
      leaseToken: leaseRef.current,
      readingNumber,
      position: index + 1,
    });
  };

  const completeFor = (readingNumber: number) => async () => {
    await api.post(`/api/rounds/${snap.round.id}/reading/complete`, {
      leaseToken: leaseRef.current,
      readingNumber,
    });
  };

  /* The normal flow is ONE tap: the reader announces "Reading N", speaks every
   * word of the saved order, then continues straight into the next saved
   * reading (fetching its word-only list with the leased header) until all
   * three are done and the round moves to play. Stopping or failure ends the
   * chain — recovery (restart the current reading, move devices) is manual,
   * and nothing regenerates the shuffles or the starter. */
  const runReadings = async (startReadingNumber: number, firstWords: string[]) => {
    const runner = runnerRef.current;
    if (!runner || !leaseRef.current) {
      setBusy(false);
      return;
    }
    setActionError(null);
    try {
      let readingNumber = startReadingNumber;
      let list = firstWords;
      for (;;) {
        const result = await runner.run(readingNumber, list, {
          isCurrent: () => true,
          onWordComplete: ackFor(readingNumber),
          onReadingComplete: completeFor(readingNumber),
        });
        // "cancelled" (paused) or "failed": stop the chain. Recovery is manual
        // and never regenerates the shuffled orders or the starter.
        if (result !== "done" || readingNumber >= 3) break;
        const next = readingNumber + 1;
        list = await fetchWords(leaseRef.current, next);
        readingNumber = next;
      }
    } catch (err) {
      // Replay/cancellation safety: a lost or revoked lease (403 after a
      // transfer, expiry, takeover) must also silence THIS device locally —
      // best-effort. The in-flight utterance stops via adapter.cancel(); words
      // beyond the current one are never queued because the chain halts here.
      // A device that stays offline can't learn the lease was revoked — the
      // server can't remotely silence it; that's why acceptance asks people to
      // stop playback on the previous phone.
      runnerRef.current?.cancel();
      setActionError(
        err instanceof Error
          ? err.message.includes("403") || err.message.includes("speaker")
            ? "This device stopped being the speaker — the saved readings continue on another device or after restart."
            : err.message
          : "The words couldn't be announced.",
      );
    } finally {
      await wrap(async () => undefined)().catch(() => undefined); // refresh state
      setBusy(false);
    }
  };

  // Organiser-approved speaker transfer: authorization from the organiser is
  // accepted here on the player's own device. Acceptance loads the saved word
  // list but does NOT auto-start audio — the explicit Start readings tap is
  // required (recovery is never automatic).
  const acceptApprovedTransfer = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await api.post<{ leaseToken: string }>(`/api/rounds/${snap.round.id}/speaker/accept`);
      setLeaseToken(out.leaseToken);
      leaseRef.current = out.leaseToken;
      const loaded = await fetchWords(out.leaseToken, snap.reading?.readingNumber ?? 1);
      setWords(loaded);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not accept the speaker role.");
    } finally {
      setBusy(false);
    }
  };

  // Pick the next speaker: the organiser records an authorization for that
  // participant; the participant taps a button on their own device to accept.
  const authorizeSpeaker = (playerId: string) =>
    void wrap(async () => {
      await api.post(`/api/rooms/${snap.room.code}/speaker/authorize`, { playerId });
    })();

  const doRestart = () =>
    void wrap(async () => {
      const out = await api.post<{ words: string[]; leaseToken: string }>(
        `/api/rooms/${snap.room.code}/reading/restart`,
        { readingNumber: currentReading, leaseToken },
      );
      if (out.leaseToken) {
        setLeaseToken(out.leaseToken);
        leaseRef.current = out.leaseToken;
      }
      setWords(out.words);
    })();
  beTheSpeakerRef.current = beTheSpeaker;
  runReadingsRef.current = runReadings;

  const paused = runnerRef.current?.running === false && status.phase !== "done" && readingStarted && words !== null && !busy;
  void paused;

  if (!support.supported) {
    return (
      <Page>
        <h1 style={{ fontSize: 28 }}>Listen closely</h1>
        <p className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> This browser can't speak out loud. Wait for the organiser — or another
          player with a working browser — to take the speaker role; that device announces every word out loud. No words
          will be shown here or on any screen.
        </p>
        <ListeningPanel snap={snap} currentReading={currentReading} />
      </Page>
    );
  }

  const phase = status.phase;

  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>Listen closely</h1>
      <p className="reading-progress">Reading {currentReading} of 3</p>

      {words === null && !mine && !snap.me.isOrganiser && (
        <ListeningPanel snap={snap} currentReading={currentReading} />
      )}
      {words === null && !mine && !snap.me.isOrganiser && snap.me.inRoster && (
        <Panel heading="Speaker">
          {snap.reading?.transferPendingForMe ? (
            <>
              <p className="status-text" role="status">
                The organiser picked this device as the next speaker.
              </p>
              <p className="status-text">
                Stop playback on the previous phone before continuing. The saved readings continue in the same order
                here — nothing is regenerated.
              </p>
              <Button className="btn-primary btn-cta" loading={busy} onClick={() => void acceptApprovedTransfer()}>
                Accept speaker role
              </Button>
            </>
          ) : held ? (
            <>
              <p className="status-text">
                Speaking now: {snap.reading?.speaker?.displayName ?? "another device"}.
              </p>
              <p className="status-text" style={{ textAlign: "center" }}>
                Reading {currentReading} of 3
              </p>
              <p className="status-text">
                If their device stops working, the organiser can pick you; when their lease expires you can also claim
                the speaker role here.
              </p>
            </>
          ) : (
            <>
              <p className="status-text">
                Anyone can be the speaker — one device only reads the words out loud. If the organiser's device is
                offline, you can claim the speaker role with the button below.
              </p>
              <Button className="btn-secondary btn-cta" loading={busy} onClick={() => void beTheSpeaker()}>
                Claim speaker role
              </Button>
            </>
          )}
        </Panel>
      )}

      {words === null && snap.me.isOrganiser && !mine && (
        <Panel heading="Speaker">
          {held ? (
            <>
              <p className="status-text">
                Speaking now: {snap.reading?.speaker?.displayName ?? "another device"}.
              </p>
              <p className="status-text">
                To move the reading, authorize a participant below. They tap “Accept speaker role” on their own device;
                acceptance stops the old device's lease. Everyone should stop playback on the previous phone before
                continuing — the server can't remotely silence a device that stays offline.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {snap.players
                  .filter((p) => p.inRoster && !p.isOrganiser)
                  .map((p) => (
                    <Button
                      key={p.playerId}
                      className="btn-secondary btn-small"
                      onClick={() => authorizeSpeaker(p.playerId)}
                    >
                      Authorize {p.displayName}
                    </Button>
                  ))}
              </div>
              {snap.reading?.transferPendingForMe && (
                <p className="status-text" role="status">
                  This device is also authorized — use the “Accept speaker role” panel.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="status-text">No device is speaking right now.</p>
              <Button className="btn-primary btn-cta" loading={busy} onClick={() => void beTheSpeaker()}>
                Speak on this device
              </Button>
            </>
          )}
        </Panel>
      )}
      {words === null && snap.me.isOrganiser && mine && (
        <Panel heading="Speaker">
          <p className="status-text">
            This device is the speaker: it will read all three saved readings aloud, then announce the starter.
          </p>
          <Button className="btn-primary btn-cta" loading={busy} onClick={() => void beTheSpeaker()}>
            {snap.reading?.position ?? 0 > 0 ? "Restart readings (saved order)" : "Load and start readings"}
          </Button>
          <p className="status-text">
            To move elsewhere: authorize another participant below — they accept on their device.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {snap.players
              .filter((p) => p.inRoster && !p.isOrganiser)
              .map((p) => (
                <Button key={p.playerId} className="btn-secondary btn-small" onClick={() => authorizeSpeaker(p.playerId)}>
                  Authorize {p.displayName}
                </Button>
              ))}
          </div>
        </Panel>
      )}

      {words !== null && (
        <Panel heading="Your device is the speaker">
          <div className="audio-indicator">
            <span className={`disc ${phase === "speaking" || phase === "announcing" ? "speaking" : ""}`} />
            {phase === "speaking"
              ? "Speaking…"
              : phase === "pausing"
                ? "Pausing between words…"
                : phase === "announcing"
                  ? "Announcing…"
                  : phase === "failed"
                    ? "Paused."
                    : "Ready."}
          </div>
          <ReadingProgressLine
            readingNumber={currentReading}
            position={status.wordIndex !== null ? status.wordIndex : (snap.reading?.position ?? 0)}
            total={words.length}
          />
          {(phase === "idle" || phase === "done") && (
            <Button
              className="btn-primary btn-cta"
              loading={busy}
              onClick={() => void runReadings(currentReading, words as string[])}
            >
              {phase === "idle" && readingStarted ? "Restart readings" : "Start readings"}
              {phase === "done" ? " (next one)" : ""}
            </Button>
          )}
          {(phase === "speaking" || phase === "pausing" || phase === "announcing") && (
            <Button
              className="btn-secondary btn-cta"
              onClick={() => {
                runnerRef.current?.cancel();
              }}
            >
              Pause (this repeats the reading)
            </Button>
          )}
          {phase === "failed" && (
            <>
              <ErrorBanner error="Speaking stopped unexpectedly. The saved order is safe — restart to repeat it, or move to another speaker device." />
              <Button
                className="btn-primary btn-cta"
                onClick={() => {
                  setRestartWarn(true);
                }}
              >
                Restart this reading (same saved order)
              </Button>
            </>
          )}
          <p className="status-text">
            If this device can't speak, tap "Test sound" first; then take the speaker role on another device — that
            stops the audio here and the readings continue there in the same saved order. No words are ever shown or
            shared on any screen.
          </p>
        </Panel>
      )}

      <ErrorBanner error={error ?? actionError} />

      {restartWarn && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Restart reading">
          <div className="modal">
            <h2 style={{ fontSize: 22 }}>Repeat reading {currentReading}?</h2>
            <p>
              This repeats reading {currentReading} in the same saved order, from the beginning, for everyone in the
              room.
            </p>
            <Button
              className="btn-primary"
              loading={busy}
              onClick={() => {
                setRestartWarn(false);
                doRestart();
              }}
            >
              Restart reading {currentReading}
            </Button>
            <Button className="btn-ghost" onClick={() => setRestartWarn(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {/* keep an invisible roster so polling reconciliation has stable layout */}
      <Panel heading="Players">
        {snap.players.map((p) => (
          <div className="player-row" key={p.playerId}>
            <Avatar name={p.displayName} playerId={p.playerId} />
            <span className="player-name">
              {p.displayName} {p.isOrganiser && <span className="badge">Organiser</span>}
            </span>
          </div>
        ))}
      </Panel>
    </Page>
  );
}

function ListeningPanel({ snap, currentReading }: { snap: RoomSnapshot; currentReading: number }) {
  return (
    <Panel heading="Listening status">
      <div className="audio-indicator">
        <span className="disc" aria-hidden="true" />
        {snap.reading?.held ? "A speaker device is announcing the words." : "Waiting for someone to speak."}
      </div>
      <p className="status-text" role="status" style={{ textAlign: "center" }}>
        Reading {currentReading} of 3
        {snap.reading && snap.reading.position > 0
          ? ` · through word ${snap.reading.position}`
          : snap.reading
            ? " · not started"
            : ""}
      </p>
      <p className="status-text" style={{ textAlign: "center" }}>
        Phones down — you don't need this screen while the words play.
      </p>
    </Panel>
  );
}

function ReadingProgressLine({ readingNumber, position, total }: { readingNumber: number; position: number; total: number }) {
  return (
    <p className="status-text" role="status" style={{ textAlign: "center" }}>
      {total > 0 && position > 0 ? `Word ${Math.min(position, total)} of ${total}` : "Words not started yet."}
      <br />
      Reading {readingNumber} of 3
    </p>
  );
}
