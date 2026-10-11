import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ stored: {} as Record<string, unknown> }));
const listeners = vi.hoisted(() => ({
  alarms: new Set<(alarm: { name: string }) => void>(),
  installed: new Set<() => void>(),
  startup: new Set<() => void>(),
  storage: new Set<
    (changes: Record<string, unknown>, areaName: string) => void
  >(),
}));
const browserMock = vi.hoisted(() => ({
  alarms: {
    create: vi.fn().mockResolvedValue(undefined),
    onAlarm: {
      addListener: vi.fn((listener: (alarm: { name: string }) => void) =>
        listeners.alarms.add(listener),
      ),
      removeListener: vi.fn((listener: (alarm: { name: string }) => void) =>
        listeners.alarms.delete(listener),
      ),
    },
  },
  runtime: {
    onInstalled: {
      addListener: vi.fn((listener: () => void) =>
        listeners.installed.add(listener),
      ),
      removeListener: vi.fn((listener: () => void) =>
        listeners.installed.delete(listener),
      ),
    },
    onStartup: {
      addListener: vi.fn((listener: () => void) =>
        listeners.startup.add(listener),
      ),
      removeListener: vi.fn((listener: () => void) =>
        listeners.startup.delete(listener),
      ),
    },
  },
  storage: {
    local: {
      get: vi.fn(async () => ({ ...state.stored })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(state.stored, value);
      }),
    },
    onChanged: {
      addListener: vi.fn(
        (
          listener: (
            changes: Record<string, unknown>,
            areaName: string,
          ) => void,
        ) => listeners.storage.add(listener),
      ),
      removeListener: vi.fn(
        (
          listener: (
            changes: Record<string, unknown>,
            areaName: string,
          ) => void,
        ) => listeners.storage.delete(listener),
      ),
    },
  },
}));

vi.mock("webextension-polyfill", () => ({ default: browserMock }));

import {
  parseRemoteRulePayload,
  parseRemoteRuleSubscriptions,
  refreshRemoteRules,
  registerRemoteRules,
  REMOTE_RULE_REFRESH_MINUTES,
  REMOTE_RULES_ALARM,
  REMOTE_RULES_STORAGE_KEY,
} from "../../src/background/rules/remote-rules";

const remoteUrl = "https://rules.example.com/rules.json";
const remoteRule = {
  id: "remote-example",
  matches: ["*://example.com/*"],
  selectors: ["article"],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

beforeEach(() => {
  state.stored = {
    config: { remoteRules: [{ url: remoteUrl, enabled: true }] },
  };
  listeners.alarms.clear();
  listeners.installed.clear();
  listeners.startup.clear();
  listeners.storage.clear();
  vi.clearAllMocks();
});

describe("remote rules", () => {
  it("refuses plain-HTTP feeds and strips fields a feed may not control", async () => {
    expect(
      parseRemoteRuleSubscriptions({
        remoteRules: [
          { url: "http://rules.example.com/r.json", enabled: true },
        ],
      }),
    ).toEqual([]);

    const hostile = {
      ...remoteRule,
      matches: ["*://*/*"],
      service: "openai-compatible",
      autoTranslate: true,
      injectedCss: [
        "input[value^='a'] { background: url(https://x.example/a) }",
      ],
      additionalInjectedCss: ["body { background: url(https://x.example/) }"],
      selectors: ["article"],
    };
    const [parsed] = parseRemoteRulePayload([hostile]);
    expect(parsed).not.toHaveProperty("service");
    expect(parsed).not.toHaveProperty("autoTranslate");
    expect(parsed).not.toHaveProperty("injectedCss");
    expect(parsed).not.toHaveProperty("additionalInjectedCss");
    expect(parsed).toMatchObject({ selectors: ["article"] });

    const [bounded] = parseRemoteRulePayload([
      {
        ...remoteRule,
        matches: [...remoteRule.matches, `https://*/${"*".repeat(600)}`],
        excludeSelectors: [],
        excludeTags: [],
        likePreSelectors: ["textarea", "[contenteditable]"],
        isTransformPreTagNewLine: true,
        additionalExcludeSelectors: [".ad"],
        glossaries: Array.from({ length: 1_000 }, (_, index) => ({
          k: `term${index}`,
          v: "x".repeat(200),
        })),
      },
    ]);
    expect(bounded).not.toHaveProperty("excludeSelectors");
    expect(bounded).not.toHaveProperty("excludeTags");
    expect(bounded).not.toHaveProperty("likePreSelectors");
    expect(bounded).not.toHaveProperty("isTransformPreTagNewLine");
    expect(bounded).toMatchObject({ additionalExcludeSelectors: [".ad"] });
    expect(bounded!.matches).toEqual(remoteRule.matches);
    expect(bounded!.glossaries!.length).toBeLessThan(200);
    expect(JSON.stringify(bounded!.glossaries).length).toBeLessThanOrEqual(
      20_200,
    );

    // A feed cached before the filter existed is sanitized when read back.
    state.stored[REMOTE_RULES_STORAGE_KEY] = {
      version: 1,
      entries: { [remoteUrl]: { fetchedAt: Date.now(), rules: [hostile] } },
    };
    const fetchMock = vi.fn(async () => response([]));
    const [cached] = await refreshRemoteRules(false, { fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cached).not.toHaveProperty("autoTranslate");
    expect(cached).not.toHaveProperty("service");
  });

  it("parses only unique HTTPS subscriptions and valid rule feeds", () => {
    expect(
      parseRemoteRuleSubscriptions({
        remoteRules: [
          { url: remoteUrl, enabled: true },
          { url: remoteUrl, enabled: false },
          { url: "file:///tmp/rules.json", enabled: true },
          { url: "https://rules.example.com/disabled.json", enabled: false },
        ],
      }),
    ).toEqual([
      { url: remoteUrl, enabled: true },
      { url: "https://rules.example.com/disabled.json", enabled: false },
    ]);
    expect(parseRemoteRulePayload({ rules: [remoteRule] })).toEqual([
      remoteRule,
    ]);
    expect(() => parseRemoteRulePayload([{ matches: [] }])).toThrow(
      "invalid rule",
    );
  });

  it("fetches once per 24 hours and caches the validated rules", async () => {
    const fetchMock = vi.fn(async () => response([remoteRule]));
    const now = 1_800_000_000_000;

    await expect(
      refreshRemoteRules(false, { fetch: fetchMock, now: () => now }),
    ).resolves.toEqual([remoteRule]);
    await expect(
      refreshRemoteRules(false, {
        fetch: fetchMock,
        now: () => now + REMOTE_RULE_REFRESH_MINUTES * 30_000,
      }),
    ).resolves.toEqual([remoteRule]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.stored[REMOTE_RULES_STORAGE_KEY]).toMatchObject({
      version: 1,
      entries: {
        [remoteUrl]: { fetchedAt: now, rules: [remoteRule] },
      },
    });
  });

  it("keeps the last valid cache when a refresh fails", async () => {
    const now = 1_800_000_000_000;
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await refreshRemoteRules(false, {
      fetch: vi.fn(async () => response([remoteRule])),
      now: () => now,
    });

    await expect(
      refreshRemoteRules(true, {
        fetch: vi.fn(async () => response([{ matches: [] }])),
        now: () => now + 1,
      }),
    ).resolves.toEqual([remoteRule]);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("does not fetch or return disabled subscriptions", async () => {
    state.stored.config = {
      remoteRules: [{ url: remoteUrl, enabled: false }],
    };
    const fetchMock = vi.fn();

    await expect(
      refreshRemoteRules(true, { fetch: fetchMock }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers a daily alarm and removes every listener", () => {
    const dispose = registerRemoteRules({ fetch: vi.fn() });

    expect(browserMock.alarms.create).toHaveBeenCalledWith(REMOTE_RULES_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: REMOTE_RULE_REFRESH_MINUTES,
    });
    expect(listeners.alarms.size).toBe(1);
    expect(listeners.installed.size).toBe(1);
    expect(listeners.startup.size).toBe(1);
    expect(listeners.storage.size).toBe(1);

    dispose();
    expect(listeners.alarms.size).toBe(0);
    expect(listeners.installed.size).toBe(0);
    expect(listeners.startup.size).toBe(0);
    expect(listeners.storage.size).toBe(0);
  });
});
