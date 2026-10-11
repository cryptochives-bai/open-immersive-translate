import { describe, expect, it, vi } from "vitest";

import {
  badgeForPageState,
  PageBadgeController,
  type BadgeActionApi,
} from "../../src/background/badge";
import type { PageTranslationState } from "../../src/shared/messages";

function state(status: PageTranslationState["status"]): PageTranslationState {
  return { status, total: 12, pending: 3, translated: 8, errors: 1 };
}

function actionMock(): BadgeActionApi {
  return {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
    setTitle: vi.fn(),
  };
}

describe("page action badge", () => {
  it.each([
    ["idle", "", "#64748b"],
    ["translating", "…", "#2563eb"],
    ["done", "✓", "#15803d"],
    ["error", "!", "#b42318"],
  ] as const)("maps %s state to its badge", (status, text, color) => {
    expect(badgeForPageState(state(status))).toEqual({
      text,
      color,
      title: "翻译 8/12，待处理 3，失败 1",
    });
  });

  it("stores a tab state and applies a content-controller message", async () => {
    const action = actionMock();
    const controller = new PageBadgeController(action);
    const current = state("translating");

    await expect(
      controller.handleMessage(
        { type: "pageTranslationState", state: current },
        { tab: { id: 42 } },
      ),
    ).resolves.toEqual({ received: true });

    expect(controller.get(42)).toEqual(current);
    expect(action.setBadgeText).toHaveBeenCalledWith({
      tabId: 42,
      text: "…",
    });
    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      tabId: 42,
      color: "#2563eb",
    });
    expect(action.setTitle).toHaveBeenCalledWith({
      tabId: 42,
      title: "翻译 8/12，待处理 3，失败 1",
    });
  });

  it("clears stored state and badge text on navigation", async () => {
    const action = actionMock();
    const controller = new PageBadgeController(action);
    await controller.update(42, state("done"));

    await controller.clear(42);

    expect(controller.get(42)).toBeUndefined();
    expect(action.setBadgeText).toHaveBeenLastCalledWith({
      tabId: 42,
      text: "",
    });
  });

  it("merges per-frame reports and keys them by the browser-supplied frameId", async () => {
    const action = actionMock();
    const controller = new PageBadgeController(action);
    const done = {
      status: "done",
      total: 4,
      pending: 0,
      translated: 4,
      errors: 0,
    } as const;
    const busy = {
      status: "translating",
      total: 2,
      pending: 2,
      translated: 0,
      errors: 0,
    } as const;

    await controller.handleMessage(
      { type: "pageTranslationState", state: done },
      { tab: { id: 7 }, frameId: 0 },
    );
    await controller.handleMessage(
      { type: "pageTranslationState", state: busy },
      { tab: { id: 7 }, frameId: 3 },
    );
    expect(controller.get(7)).toEqual({
      status: "translating",
      total: 6,
      pending: 2,
      translated: 4,
      errors: 0,
    });

    // A frame can only replace its own entry, never another frame's.
    await controller.handleMessage(
      {
        type: "pageTranslationState",
        state: { ...done, total: 0, translated: 0 },
      },
      { tab: { id: 7 }, frameId: 3 },
    );
    expect(controller.get(7)).toMatchObject({ status: "done", total: 4 });

    await controller.forgetFrame(7, 3);
    expect(controller.get(7)).toEqual(done);
  });

  it("rejects malformed state reports", async () => {
    const controller = new PageBadgeController(actionMock());
    await expect(
      controller.handleMessage(
        { type: "pageTranslationState" },
        { tab: { id: 7 }, frameId: 2 },
      ),
    ).resolves.toBeUndefined();
    expect(controller.get(7)).toBeUndefined();
  });
});
