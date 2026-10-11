import { afterEach, vi } from "vitest";

import { isUserEvent } from "../../src/content/features/trusted";

// jsdom never marks dispatched events as trusted, so unit tests treat them as
// real user input. Tests for the gate itself flip this to false.
vi.mock("../../src/content/features/trusted", () => ({
  isUserEvent: vi.fn(() => true),
}));

// jsdom does no layout (every rect is 0x0), so the clickjacking guard would
// reject every click. Its real logic is tested in clickjack-guard.test.ts and
// in real Chromium by the e2e suite.
vi.mock("../../src/content/features/clickjack-guard", () => ({
  controlLooksUntampered: vi.fn(() => true),
  trackOcclusion: vi.fn(() => ({
    isVisible: () => true,
    disconnect: () => undefined,
  })),
}));

afterEach(() => {
  vi.mocked(isUserEvent).mockImplementation(() => true);
});
