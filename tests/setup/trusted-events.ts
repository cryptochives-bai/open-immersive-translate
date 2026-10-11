import { afterEach, vi } from "vitest";

import { isUserEvent } from "../../src/content/features/trusted";

// jsdom never marks dispatched events as trusted, so unit tests treat them as
// real user input. Tests for the gate itself flip this to false.
vi.mock("../../src/content/features/trusted", () => ({
  isUserEvent: vi.fn(() => true),
}));

afterEach(() => {
  vi.mocked(isUserEvent).mockImplementation(() => true);
});
