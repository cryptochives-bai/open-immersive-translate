import { describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({ default: {} }));

import {
  batchCueSentences,
  CueBudget,
  FAILED_CUE_RETRY_MS,
  MAX_WINDOW_CUES,
  SubtitleEngine,
  WINDOW_INTERVAL_MS,
} from "../../src/content/features/subtitle/engine";
import { userIsWatching } from "../../src/content/features/subtitle";
import type { FeatureContext } from "../../src/content/features/context";

function context(translateText = vi.fn(async (text: string) => `译:${text}`)) {
  return {
    config: { sourceLanguage: "en", targetLanguage: "zh-CN" },
    translateText,
  } as unknown as Pick<FeatureContext, "config" | "translateText">;
}

describe("SubtitleEngine", () => {
  it("joins cues at sentence boundaries and enforces cue and character limits", () => {
    const sentences = batchCueSentences([
      { start: 0, end: 1, text: "Hello" },
      { start: 1, end: 2, text: "world." },
      { start: 2, end: 3, text: "Next!" },
    ]);
    expect(sentences.map((cue) => cue.text)).toEqual(["Hello world.", "Next!"]);

    const many = batchCueSentences(
      Array.from({ length: 51 }, (_, index) => ({
        start: index,
        end: index + 0.5,
        text: "word",
      })),
    );
    expect(many).toHaveLength(2);
    expect(many[0].text.split(" ")).toHaveLength(50);
    expect(
      batchCueSentences([{ start: 0, end: 1, text: "a".repeat(4001) }]),
    ).toHaveLength(2);
  });

  it("pre-translates the whole track and reuses in-flight cache entries", async () => {
    const translateText = vi.fn(async (text: string) => `译:${text}`);
    const engine = new SubtitleEngine(context(translateText), {
      preTranslation: true,
    });
    await engine.load([
      { start: 0, end: 1, text: "Repeat." },
      { start: 2, end: 3, text: "Repeat." },
    ]);
    expect(engine.bilingualCues.map((cue) => cue.translation)).toEqual([
      "译:Repeat.",
      "译:Repeat.",
    ]);
    expect(translateText).toHaveBeenCalledTimes(1);
  });

  it("translates only the rolling window until pre-translation is enabled", async () => {
    const translateText = vi.fn(async (text: string) => `译:${text}`);
    const engine = new SubtitleEngine(context(translateText), {
      preTranslation: false,
      rollingWindowSeconds: 10,
    });
    await engine.load([
      { start: 0, end: 2, text: "Now." },
      { start: 8, end: 10, text: "Soon." },
      { start: 30, end: 32, text: "Later." },
    ]);
    expect(translateText).not.toHaveBeenCalled();
    await engine.updateCurrentTime(1);
    expect(engine.bilingualCues.map((cue) => cue.translation)).toEqual([
      "译:Now.",
      "译:Soon.",
      undefined,
    ]);
    await engine.setPreTranslation(true);
    expect(engine.bilingualCues[2].translation).toBe("译:Later.");
    expect(engine.activeCue(31)?.text).toBe("Later.");
  });

  it("does not resend a failed cue on every timeupdate", async () => {
    let now = 0;
    const translateText = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    const engine = new SubtitleEngine(context(translateText), {
      preTranslation: false,
      now: () => now,
    });
    await engine.load([{ start: 0, end: 2, text: "Now." }]);

    // Past the 1 s window throttle each time, so only the cooldown holds it.
    for (const time of [0.25, 0.5, 0.75, 1]) {
      now += WINDOW_INTERVAL_MS;
      await engine.updateCurrentTime(time);
    }
    expect(translateText).toHaveBeenCalledTimes(1);

    now += FAILED_CUE_RETRY_MS;
    await engine.updateCurrentTime(1.25);
    expect(translateText).toHaveBeenCalledTimes(2);
  });

  it("defaults to translating only the rolling window", async () => {
    const translateText = vi.fn(async (text: string) => `译:${text}`);
    const engine = new SubtitleEngine(context(translateText));
    await engine.load([{ start: 0, end: 2, text: "Now." }]);
    expect(engine.isPreTranslationEnabled).toBe(false);
    expect(translateText).not.toHaveBeenCalled();
  });

  it("caps each rolling-window update and throttles it", async () => {
    let now = 0;
    const translateText = vi.fn(async (text: string) => `译:${text}`);
    const engine = new SubtitleEngine(context(translateText), {
      now: () => now,
      budget: new CueBudget(10_000),
    });
    await engine.load(
      Array.from({ length: 300 }, (_, index) => ({
        start: index * 0.19,
        end: index * 0.19 + 0.19,
        text: `Cue ${index}.`,
      })),
    );

    await engine.updateCurrentTime(0);
    expect(translateText).toHaveBeenCalledTimes(MAX_WINDOW_CUES);
    now += 200;
    await engine.updateCurrentTime(0.2);
    expect(translateText).toHaveBeenCalledTimes(MAX_WINDOW_CUES);
  });

  it("shares one per-minute budget across engines on the page", async () => {
    const budget = new CueBudget(40);
    const translateText = vi.fn(async (text: string) => `译:${text}`);
    const cues = Array.from({ length: 60 }, (_, index) => ({
      start: index,
      end: index + 0.9,
      text: `Line ${index}`,
    }));
    for (const suffix of ["a", "b", "c"]) {
      const engine = new SubtitleEngine(context(translateText), { budget });
      await engine.load(
        cues.map((cue) => ({ ...cue, text: `${cue.text} ${suffix}.` })),
      );
      await engine.updateCurrentTime(0);
    }
    expect(translateText).toHaveBeenCalledTimes(40);
  });

  it("translates only while the media plays on a page the user touched", () => {
    expect(userIsWatching({ paused: true }, true)).toBe(false);
    expect(userIsWatching({ paused: false }, false)).toBe(false);
    expect(userIsWatching({ paused: false }, true)).toBe(true);
  });

  it("does not charge the budget again for cues still in flight", async () => {
    let now = 0;
    const budget = new CueBudget(10_000);
    const take = vi.spyOn(budget, "take");
    const translateText = vi.fn(() => new Promise<string>(() => undefined));
    const engine = new SubtitleEngine(context(translateText), {
      now: () => now,
      budget,
    });
    await engine.load(
      Array.from({ length: 5 }, (_, index) => ({
        start: index,
        end: index + 0.9,
        text: `Slow ${index}.`,
      })),
    );

    void engine.updateCurrentTime(0);
    now += WINDOW_INTERVAL_MS;
    void engine.updateCurrentTime(1);

    expect(take.mock.calls.map(([requested]) => requested)).toEqual([5, 0]);
    expect(translateText).toHaveBeenCalledTimes(5);
  });

  it("pre-translates in capped, budgeted steps", async () => {
    let now = 0;
    const translateText = vi.fn(async (text: string) => `译:${text}`);
    const engine = new SubtitleEngine(context(translateText), {
      preTranslation: true,
      now: () => now,
      budget: new CueBudget(45),
    });
    await engine.load(
      Array.from({ length: 300 }, (_, index) => ({
        start: index,
        end: index + 0.9,
        text: `Track ${index}.`,
      })),
    );
    expect(translateText).toHaveBeenCalledTimes(MAX_WINDOW_CUES);

    now += WINDOW_INTERVAL_MS;
    await engine.updateCurrentTime(0);
    expect(translateText).toHaveBeenCalledTimes(45);
  });
});
