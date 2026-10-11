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

import { installDirectHoverTranslation } from "../../src/content/controller/hover-directly";
import { openAiWritingModal } from "../../src/content/features/ai-writing";
import type { FeatureContext } from "../../src/content/features/context";
import { init as initHover } from "../../src/content/features/hover-translate";
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

  it("ignores forged hover input in modifier and direct hover modes", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(isUserEvent).mockImplementation(() => false);
      document.body.innerHTML = "<p><span id='word'>attacker prompt</span></p>";
      const word = document.getElementById("word")!;
      const ctx = context({ hover: { enabled: true, holdKey: "Alt" } });
      const disposeHover = initHover({
        ...ctx,
        rule: { matches: ["<all_urls>"], allBlockTags: ["P"] },
      });
      const direct = vi.fn().mockResolvedValue(undefined);
      const disposeDirect = installDirectHoverTranslation(direct, ["p"]);

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
      );
      word.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, altKey: true }),
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(ctx.translateParagraph).not.toHaveBeenCalled();
      expect(direct).not.toHaveBeenCalled();
      disposeHover();
      disposeDirect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a forged run click in the AI writing panel", async () => {
    const input = document.createElement("textarea");
    input.value = "secret draft";
    document.body.append(input);
    input.focus();
    const assistant = { complete: vi.fn().mockResolvedValue("unused") };
    openAiWritingModal(context(), assistant);
    vi.mocked(isUserEvent).mockImplementation(() => false);

    const host = document.querySelector('[data-imt="ai-writing"]')!;
    privateShadowRoot(host)!
      .querySelector<HTMLButtonElement>('[data-command="run"]')!
      .click();
    await Promise.resolve();

    expect(assistant.complete).not.toHaveBeenCalled();
  });
});

describe("sensitive fields", () => {
  it("AI writing does not read a focused password field", () => {
    const input = document.createElement("input");
    input.type = "password";
    input.value = "hunter2";
    document.body.append(input);
    input.focus();
    const assistant = { complete: vi.fn().mockResolvedValue("unused") };
    openAiWritingModal(context(), assistant);

    const host = document.querySelector('[data-imt="ai-writing"]')!;
    const source =
      privateShadowRoot(host)!.querySelector<HTMLTextAreaElement>("textarea");
    expect(source?.value ?? "").not.toContain("hunter2");
  });

  it("does not offer selection translation while focus stays in a field", async () => {
    const field = document.createElement("input");
    field.value = "123456";
    const paragraph = document.createElement("p");
    paragraph.textContent = "outside";
    document.body.append(field, paragraph);
    field.focus();
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
      toString: () => "123456",
    } as unknown as Selection);
    const ctx = context();
    const dispose = initSelection(ctx);

    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await Promise.resolve();

    expect(document.querySelector('[data-imt="selection"]')).toBeNull();
    dispose();
  });
});

describe("isUserEvent", () => {
  it("is false for script-dispatched events and true only when the browser says so", async () => {
    const actual = await vi.importActual<{
      isUserEvent: (event: Event) => boolean;
    }>("../../src/content/features/trusted");
    expect(actual.isUserEvent(new MouseEvent("click"))).toBe(false);
    expect(actual.isUserEvent({ isTrusted: true } as Event)).toBe(true);
  });
});
