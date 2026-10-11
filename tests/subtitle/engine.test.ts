import { describe, expect, it, vi } from "vitest";

import {
  batchCueSentences,
  FAILED_CUE_RETRY_MS,
  SubtitleEngine,
} from "../../src/content/features/subtitle/engine";
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

    for (const time of [0.25, 0.5, 0.75, 1]) {
      now += 250;
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
});
