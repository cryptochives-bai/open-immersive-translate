import { describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({ default: {} }));

import { mountableFeatures } from "../../src/content/controller";
import { isNeverTranslateSite } from "../../src/content/controller/patterns";
import { init as initAiWriting } from "../../src/content/features/ai-writing";
import { init as initFloatBall } from "../../src/content/features/float-ball";
import { init as initInputTranslation } from "../../src/content/features/input-translate";
import { init as initSearchEnhancement } from "../../src/content/features/search-enhancement";
import { initSubtitles } from "../../src/content/features/subtitle";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import type { Config } from "../../src/shared/types";

const config = (neverTranslateSites: string[]): Config => ({
  ...DEFAULT_CONFIG,
  neverTranslateSites,
});

describe("never-translate sites", () => {
  it("matches the host and its subdomains", () => {
    expect(isNeverTranslateSite(config(["bank.example"]), "bank.example")).toBe(
      true,
    );
    expect(
      isNeverTranslateSite(config(["bank.example"]), "online.bank.example"),
    ).toBe(true);
    expect(isNeverTranslateSite(config(["bank.example"]), "example")).toBe(
      false,
    );
  });

  it("drops only features that send text without a user action", () => {
    const features = mountableFeatures(
      config(["bank.example"]),
      "bank.example",
    );
    expect(features).not.toContain(initSubtitles);
    expect(features).not.toContain(initSearchEnhancement);
    // Explicitly triggered features stay available on never-translate sites.
    expect(features).toEqual(
      expect.arrayContaining([
        initFloatBall,
        initAiWriting,
        initInputTranslation,
      ]),
    );

    expect(mountableFeatures(config([]), "bank.example")).toContain(
      initSubtitles,
    );
  });

  it("does not pre-translate whole subtitle tracks by default", () => {
    expect(DEFAULT_CONFIG.subtitle.preTranslation).toBe(false);
  });
});
