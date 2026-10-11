import { afterEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("webextension-polyfill", () => ({ default: browserMock }));

import type { FeatureContext } from "../../src/content/features/context";
import { init as initFloatBall } from "../../src/content/features/float-ball";
import { privateShadowRoot } from "../../src/content/features/private-shadow";
import { init as initSelection } from "../../src/content/features/selection-translate";
import { isUserEvent } from "../../src/content/features/trusted";
import { SubtitleRenderer } from "../../src/content/features/subtitle/renderer";
import { DEFAULT_SUBTITLE_CONFIG } from "../../src/shared/subtitle-types";

function context(overrides: Record<string, unknown> = {}): FeatureContext {
  return {
    config: {
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      floatBall: { enabled: true, position: "right" },
      selection: { enabled: true, triggerMode: "direct" },
      neverTranslateSites: [],
      ...overrides,
    } as unknown as FeatureContext["config"],
    rule: { matches: ["<all_urls>"] },
    translateText: vi.fn().mockResolvedValue("translated"),
    translateParagraph: vi.fn(),
    toggleTranslate: vi.fn(),
    isTranslated: vi.fn(() => false),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement
    .querySelectorAll("[data-imt]")
    .forEach((element) => element.remove());
  vi.restoreAllMocks();
});

describe("page scripts cannot drive extension UI", () => {
  it("keeps extension shadow roots closed to the page", () => {
    const dispose = initFloatBall(context());
    const host = document.querySelector('[data-imt="float-ball"]')!;
    expect(host.shadowRoot).toBeNull();
    expect(privateShadowRoot(host)).not.toBeNull();
    dispose();

    const video = document.createElement("video");
    document.body.append(video);
    const renderer = new SubtitleRenderer(video, DEFAULT_SUBTITLE_CONFIG);
    expect(renderer.host.shadowRoot).toBeNull();
    renderer.dispose();
  });

  it("ignores forged clicks on the float ball", () => {
    vi.mocked(isUserEvent).mockImplementation(() => false);
    const ctx = context();
    const dispose = initFloatBall(ctx);
    const host = document.querySelector('[data-imt="float-ball"]')!;
    privateShadowRoot(host)!.querySelector<HTMLButtonElement>(".ball")!.click();
    expect(ctx.toggleTranslate).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores a forged mouseup over page-selected text", async () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "attacker supplied prompt";
    document.body.append(paragraph);
    vi.spyOn(window, "getSelection").mockReturnValue({
      anchorNode: paragraph.firstChild,
      focusNode: paragraph.firstChild,
      rangeCount: 1,
      getRangeAt: () =>
        ({
          getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 10,
            bottom: 10,
            width: 10,
            height: 10,
          }),
        }) as unknown as Range,
      toString: () => "attacker supplied prompt",
    } as unknown as Selection);
    vi.mocked(isUserEvent).mockImplementation(() => false);
    const ctx = context();
    const dispose = initSelection(ctx);

    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await Promise.resolve();

    expect(document.querySelector('[data-imt="selection"]')).toBeNull();
    expect(ctx.translateText).not.toHaveBeenCalled();
    dispose();
  });

  it("no longer listens for page-dispatchable document events", async () => {
    const ctx = context();
    const dispose = initSelection(ctx);

    const event = new CustomEvent("imt:translate-selection", {
      cancelable: true,
      detail: { text: "attacker supplied prompt" },
    });
    expect(document.dispatchEvent(event)).toBe(true);
    await Promise.resolve();

    expect(document.querySelector('[data-imt="selection"]')).toBeNull();
    expect(ctx.translateText).not.toHaveBeenCalled();
    dispose();
  });
});
