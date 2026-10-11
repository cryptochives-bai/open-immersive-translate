import browser from "webextension-polyfill";

import { cleanupTranslationCache } from "./cache";

export const CACHE_CLEANUP_ALARM = "translationCache.cleanup";

/**
 * Enforce the cache retention period once a day.
 *
 * The service worker re-runs top-level code every time it wakes, and
 * alarms.create with an existing name replaces the alarm and restarts its
 * countdown. Creating it unconditionally would keep pushing the first run
 * back, so it is only created when missing.
 */
export async function registerCacheCleanup(
  maxAgeDays: () => Promise<number>,
): Promise<void> {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CACHE_CLEANUP_ALARM) return;
    void maxAgeDays()
      .then(cleanupTranslationCache)
      .catch(() => undefined);
  });
  if (await browser.alarms.get(CACHE_CLEANUP_ALARM)) return;
  await browser.alarms.create(CACHE_CLEANUP_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 24 * 60,
  });
}
