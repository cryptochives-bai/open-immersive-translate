import { beforeEach, describe, expect, it, vi } from "vitest";

const alarms = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(async () => undefined),
  listeners: [] as Array<(alarm: { name: string }) => void>,
}));
const cleanup = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("webextension-polyfill", () => ({
  default: {
    alarms: {
      get: alarms.get,
      create: alarms.create,
      onAlarm: {
        addListener: (listener: (alarm: { name: string }) => void) =>
          alarms.listeners.push(listener),
      },
    },
  },
}));
vi.mock("../../src/background/cache", () => ({
  cleanupTranslationCache: cleanup,
}));

import {
  CACHE_CLEANUP_ALARM,
  registerCacheCleanup,
} from "../../src/background/cache-cleanup";

beforeEach(() => {
  vi.clearAllMocks();
  alarms.listeners.length = 0;
});

describe("translation cache cleanup", () => {
  it("creates the daily alarm only when it does not exist yet", async () => {
    alarms.get.mockResolvedValueOnce(undefined);
    await registerCacheCleanup(async () => 30);
    expect(alarms.create).toHaveBeenCalledWith(CACHE_CLEANUP_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 24 * 60,
    });

    // A woken service worker must not restart the countdown.
    alarms.create.mockClear();
    alarms.get.mockResolvedValueOnce({ name: CACHE_CLEANUP_ALARM });
    await registerCacheCleanup(async () => 30);
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it("purges with the configured retention when the alarm fires", async () => {
    alarms.get.mockResolvedValueOnce({ name: CACHE_CLEANUP_ALARM });
    await registerCacheCleanup(async () => 7);

    alarms.listeners[0]!({ name: "something-else" });
    alarms.listeners[0]!({ name: CACHE_CLEANUP_ALARM });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(7));
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
