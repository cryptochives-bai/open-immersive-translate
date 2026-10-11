import { describe, expect, it } from "vitest";

import * as frameSync from "../../src/content/controller/frame-sync";

describe("iframe controller gating", () => {
  it("requires the configured amount of frame text", () => {
    document.body.textContent = "short";
    expect(frameSync.frameHasEnoughText(document, 10)).toBe(false);
    document.body.textContent = "enough frame text";
    expect(frameSync.frameHasEnoughText(document, 10)).toBe(true);
  });

  it("no longer relays commands or state through window.postMessage", () => {
    expect(Object.keys(frameSync)).toEqual(["frameHasEnoughText"]);
  });
});
