import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VOICE_SAMPLE_TEXT, createBrowserAdapter } from "../../web/src/lib/speech";

/* Browser-adapter voice behaviour with a fake speechSynthesis:
 * asynchronous voice population, English-first ordering, remembered voices
 * validated against the CURRENT device, and device-local persistence. */

type FakeVoice = { name: string; lang: string; localService: boolean; default: boolean };

function makeEnvironment() {
  let voices: FakeVoice[] = [];
  const voiceListeners = new Set<() => void>();
  const spoken: string[] = [];
  const storage = new Map<string, string>();

  const fakeSynth = {
    getVoices: () => voices,
    addEventListener: (_: string, fn: () => void) => voiceListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => {
      void _;
      voiceListeners.delete(fn);
    },
    cancel: () => undefined,
    speak: (utter: { text: string; onend: (() => void) | null }) => {
      spoken.push(utter.text);
      const end = utter.onend ?? (() => undefined);
      setTimeout(end, 0);
    },
  };

  const fakeWindow = { speechSynthesis: fakeSynth, localStorage: null as unknown };
  const fakeStorage = Object.freeze({
    getItem: (k: string) => (storage.has(k) ? (storage.get(k) as string) : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  fakeWindow.localStorage = fakeStorage;

  return {
    spoken,
    storage,
    populate(next: FakeVoice[]) {
      voices = next;
      for (const fn of [...voiceListeners]) fn();
    },
    install(g: typeof globalThis) {
      (g as { window?: unknown }).window = fakeWindow as unknown as typeof window;
      (g as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = class {
        text: string;
        voice: unknown = null;
        lang: string = "";
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      };
      Object.defineProperty(g, "localStorage", {
        configurable: true,
        value: fakeStorage,
      });
    },
  };
}

const V = (name: string, lang: string): FakeVoice => ({ name, lang, localService: true, default: false });

describe("browser voice adapter", () => {
  let env: ReturnType<typeof makeEnvironment>;
  let adapter: ReturnType<typeof createBrowserAdapter>;
  let prevWindow: unknown;
  let prevUtter: unknown;
  let prevStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    env = makeEnvironment();
    prevWindow = (globalThis as { window?: unknown }).window;
    prevUtter = (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    env.install(globalThis);
    adapter = createBrowserAdapter();
  });

  afterEach(() => {
    if (prevStorage) Object.defineProperty(globalThis, "localStorage", prevStorage);
    (globalThis as { window?: unknown }).window = prevWindow;
    (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = prevUtter;
  });

  it("waits through the asynchronous voice population and lists English voices first", () => {
    expect(adapter.listVoices()).toEqual([]); // nothing yet on this device
    env.populate([V("Chloé", "fr-FR"), V("Samantha", "en-US"), V("Daniel", "en-GB")]);
    const listed = adapter.listVoices();
    expect(listed.length).toBe(3);
    // all English voices are grouped ahead of other languages
    expect(listed.filter((v) => v.english).map((v) => v.name).sort()).toEqual(["Daniel", "Samantha"]);
    expect(listed.at(-1)?.english).toBe(false);
  });

  it("picks a usable fallback without promising unavailable accents", () => {
    env.populate([V("Chloé", "fr-FR"), V("Ting-Ting", "zh-CN")]);
    expect(adapter.getVoice()?.english).toBe(false);
    // a device with an English voice prefers it over other languages
    env.populate([V("Chloé", "fr-FR"), V("Samantha", "en-US")]);
    expect(adapter.getVoice()?.english).toBe(true);
  });

  it("validates a remembered voice against the current device and falls back", () => {
    env.populate([V("Daniel", "en-GB"), V("Samantha", "en-US")]);
    adapter.setVoice("Daniel:en-GB");
    expect(env.storage.get("empire.voice")).toBe("Daniel:en-GB");
    // later, this device no longer has that voice at all
    env.populate([V("Samantha", "en-US")]);
    expect(adapter.listVoices().some((v) => v.name === "Daniel")).toBe(false);
    expect(adapter.getVoice()?.name).toBe("Samantha");
    expect(env.storage.has("empire.voice")).toBe(false);
  });

  it("keeps a remembered voice when it still exists on this device", () => {
    env.populate([V("Daniel", "en-GB"), V("Samantha", "en-US")]);
    adapter.setVoice("Daniel:en-GB");
    env.populate([V("Newone", "en-IE"), V("Daniel", "en-GB"), V("Samantha", "en-US")]);
    expect(adapter.getVoice()?.name).toBe("Daniel");
  });

  it("setVoice accepts uri or name, persists, and rejects unknown voices safely", () => {
    env.populate([V("Daniel", "en-GB"), V("Samantha", "en-US")]);
    expect(adapter.setVoice("Samson:en-US")?.name).toBeUndefined(); // no such uri
    expect(adapter.setVoice("Samantha")?.uri).toBe("Samantha:en-US"); // exact device name works
    expect(env.storage.get("empire.voice")).toBe("Samantha:en-US");
    // display-label text is not a voice id (the UI passes the option value)
    const before = adapter.getVoice();
    expect(adapter.setVoice("Samantha — English (US)")).toBe(null);
    expect(adapter.getVoice()).toEqual(before);
    expect(adapter.setVoice("Klingon:xx-KL")).toBe(null);
  });

  it("test samples are neutral and never derived from submissions", () => {
    void env;
    expect(VOICE_SAMPLE_TEXT).not.toMatch(/otter|meerkat|pangolin|quokka/i);
  });
});
