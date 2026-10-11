import browser from "webextension-polyfill";

import type { Rule } from "../../shared/types";
import { validateRule } from "./match";

export const REMOTE_RULES_ALARM = "imt:remote-rules";
export const REMOTE_RULES_STORAGE_KEY = "remoteRulesCache";
export const REMOTE_RULE_REFRESH_MINUTES = 24 * 60;

const CONFIG_STORAGE_KEY = "config";
const CACHE_VERSION = 1;
const MAX_RESPONSE_CHARS = 1_000_000;

export interface RemoteRuleSubscription {
  url: string;
  enabled: boolean;
}

interface RemoteRuleCacheEntry {
  fetchedAt: number;
  rules: Rule[];
}

interface RemoteRuleCache {
  version: number;
  entries: Record<string, RemoteRuleCacheEntry>;
}

export interface RemoteRulesDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** HTTPS only: a plain-HTTP feed lets anyone on the network rewrite the rules. */
function validRemoteUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Rule fields a third-party feed may not set. `service` and `autoTranslate`
 * would let a feed send every matching page to a configured (paid) service
 * without a click; injected CSS can exfiltrate attribute values via url().
 * Users can still set these in their own rules.
 */
const REMOTE_RULE_BLOCKED_FIELDS = [
  "service",
  "autoTranslate",
  "injectedCss",
  "additionalInjectedCss",
  // These replace the default exclusion lists (which keep editors and
  // scripts out of translation); feeds may only extend them via additional*.
  "excludeSelectors",
  "excludeTags",
  // Pre-like elements are emitted before the exclusion checks, so these
  // could pull textareas and contenteditable editors into translation.
  "likePreSelectors",
  "isTransformPreTagNewLine",
  "advanceTransformPreTagNewLine",
] as const;

/** Every glossary entry is sent with every AI translation request. */
const MAX_REMOTE_GLOSSARY_ENTRIES = 200;
const MAX_REMOTE_GLOSSARY_CHARS = 20_000;
const MAX_REMOTE_GLOB_LENGTH = 512;

function capGlossary(entries: unknown): unknown[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const kept: unknown[] = [];
  let chars = 0;
  for (const entry of entries.slice(0, MAX_REMOTE_GLOSSARY_ENTRIES)) {
    chars += JSON.stringify(entry).length;
    if (chars > MAX_REMOTE_GLOSSARY_CHARS) break;
    kept.push(entry);
  }
  return kept;
}

export function sanitizeRemoteRule(rule: Rule): Rule {
  const copy: Record<string, unknown> = { ...rule };
  for (const field of REMOTE_RULE_BLOCKED_FIELDS) delete copy[field];
  for (const field of ["glossaries", "additionalGlossaries"] as const) {
    const capped = capGlossary(copy[field]);
    if (capped) copy[field] = capped;
  }
  for (const field of ["matches", "excludeMatches"] as const) {
    const globs = copy[field];
    if (Array.isArray(globs)) {
      copy[field] = globs.filter(
        (glob) =>
          typeof glob === "string" && glob.length <= MAX_REMOTE_GLOB_LENGTH,
      );
    }
  }
  return copy as unknown as Rule;
}

/** Read the optional frozen-schema extension without trusting stored data. */
export function parseRemoteRuleSubscriptions(
  config: unknown,
): RemoteRuleSubscription[] {
  if (!isRecord(config) || !Array.isArray(config.remoteRules)) return [];

  const seen = new Set<string>();
  return config.remoteRules.flatMap((value) => {
    if (
      !isRecord(value) ||
      !validRemoteUrl(value.url) ||
      typeof value.enabled !== "boolean" ||
      seen.has(value.url)
    ) {
      return [];
    }
    seen.add(value.url);
    return [{ url: value.url, enabled: value.enabled }];
  });
}

function parseCache(value: unknown): RemoteRuleCache {
  if (
    !isRecord(value) ||
    value.version !== CACHE_VERSION ||
    !isRecord(value.entries)
  ) {
    return { version: CACHE_VERSION, entries: {} };
  }

  const entries: Record<string, RemoteRuleCacheEntry> = {};
  for (const [url, entry] of Object.entries(value.entries)) {
    if (
      !validRemoteUrl(url) ||
      !isRecord(entry) ||
      typeof entry.fetchedAt !== "number" ||
      !Array.isArray(entry.rules) ||
      !entry.rules.every((rule) => validateRule(rule).ok)
    ) {
      continue;
    }
    entries[url] = {
      fetchedAt: entry.fetchedAt,
      // Feeds cached before this filter existed are sanitized on read too.
      rules: (entry.rules as Rule[]).map(sanitizeRemoteRule),
    };
  }
  return { version: CACHE_VERSION, entries };
}

/** Accept a plain rule array or a versioned feed object containing `rules`. */
export function parseRemoteRulePayload(value: unknown): Rule[] {
  const rules = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.rules)
      ? value.rules
      : undefined;
  if (!rules)
    throw new TypeError("Remote rule feed must contain a rules array.");

  const invalid = rules.find((rule) => !validateRule(rule).ok);
  if (invalid !== undefined) {
    throw new TypeError("Remote rule feed contains an invalid rule.");
  }
  return (rules as Rule[]).map(sanitizeRemoteRule);
}

async function fetchRemoteRules(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Rule[]> {
  const response = await fetchImpl(url, {
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Remote rule request failed with HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new Error("Remote rule response exceeds 1 MB.");
  }
  return parseRemoteRulePayload(JSON.parse(text) as unknown);
}

async function loadState(): Promise<{
  subscriptions: RemoteRuleSubscription[];
  cache: RemoteRuleCache;
}> {
  const stored = await browser.storage.local.get([
    CONFIG_STORAGE_KEY,
    REMOTE_RULES_STORAGE_KEY,
  ]);
  return {
    subscriptions: parseRemoteRuleSubscriptions(stored[CONFIG_STORAGE_KEY]),
    cache: parseCache(stored[REMOTE_RULES_STORAGE_KEY]),
  };
}

/** Refresh stale enabled feeds atomically per URL and return cached rules in config order. */
async function runRefreshRemoteRules(
  force = false,
  dependencies: RemoteRulesDependencies = {},
): Promise<Rule[]> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now?.() ?? Date.now();
  const { subscriptions, cache } = await loadState();
  const enabled = subscriptions.filter((subscription) => subscription.enabled);
  const configuredUrls = new Set(subscriptions.map(({ url }) => url));
  let changed = false;

  for (const cachedUrl of Object.keys(cache.entries)) {
    if (!configuredUrls.has(cachedUrl)) {
      delete cache.entries[cachedUrl];
      changed = true;
    }
  }

  await Promise.all(
    enabled.map(async ({ url }) => {
      const cached = cache.entries[url];
      const isFresh =
        cached !== undefined &&
        now - cached.fetchedAt < REMOTE_RULE_REFRESH_MINUTES * 60_000;
      if (!force && isFresh) return;

      try {
        cache.entries[url] = {
          fetchedAt: now,
          rules: await fetchRemoteRules(url, fetchImpl),
        };
        changed = true;
      } catch (error) {
        console.warn(`[imt] Could not refresh remote rules from ${url}`, error);
      }
    }),
  );

  if (changed) {
    await browser.storage.local.set({ [REMOTE_RULES_STORAGE_KEY]: cache });
  }
  return enabled.flatMap(({ url }) => cache.entries[url]?.rules ?? []);
}

let refreshInFlight: Promise<Rule[]> | undefined;

/** Coalesce concurrent rule requests into one storage read and network refresh. */
export function refreshRemoteRules(
  force = false,
  dependencies: RemoteRulesDependencies = {},
): Promise<Rule[]> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = runRefreshRemoteRules(force, dependencies).finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

/** Load remote rules, refreshing only feeds older than 24 hours. */
export function getRemoteRules(
  dependencies: RemoteRulesDependencies = {},
): Promise<Rule[]> {
  return refreshRemoteRules(false, dependencies);
}

/** Register the alarm and lifecycle hooks used by the background worker. */
export function registerRemoteRules(
  dependencies: RemoteRulesDependencies = {},
): () => void {
  const refresh = (force = false): void => {
    void refreshRemoteRules(force, dependencies).catch((error: unknown) => {
      console.warn("[imt] Remote rule refresh failed", error);
    });
  };
  const onAlarm = (alarm: browser.Alarms.Alarm): void => {
    if (alarm.name === REMOTE_RULES_ALARM) refresh(true);
  };
  const onInstalled = (): void => refresh();
  const onStartup = (): void => refresh();
  const onStorageChange = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    const change = changes[CONFIG_STORAGE_KEY];
    if (areaName !== "local" || !change) return;
    const previous = parseRemoteRuleSubscriptions(change.oldValue);
    const next = parseRemoteRuleSubscriptions(change.newValue);
    if (JSON.stringify(previous) !== JSON.stringify(next)) refresh(true);
  };

  browser.alarms.onAlarm.addListener(onAlarm);
  browser.runtime.onInstalled.addListener(onInstalled);
  browser.runtime.onStartup.addListener(onStartup);
  browser.storage.onChanged.addListener(onStorageChange);
  void browser.alarms.create(REMOTE_RULES_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: REMOTE_RULE_REFRESH_MINUTES,
  });
  refresh();

  return () => {
    browser.alarms.onAlarm.removeListener(onAlarm);
    browser.runtime.onInstalled.removeListener(onInstalled);
    browser.runtime.onStartup.removeListener(onStartup);
    browser.storage.onChanged.removeListener(onStorageChange);
  };
}
