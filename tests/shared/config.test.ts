import { describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({ default: {} }));

import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  migrateConfig,
  serviceConfigSchema,
} from "../../src/shared/config";

describe("configuration migration", () => {
  it("defaults the input trigger to // and upgrades the old single-slash default", () => {
    expect(DEFAULT_CONFIG.input.startingTriggerKey).toBe("//");
    const migrated = migrateConfig({
      version: 3,
      input: { enabled: true, startingTriggerKey: "/" },
    });
    expect(migrated.input.startingTriggerKey).toBe("//");
    expect(
      migrateConfig({ version: 3, input: { startingTriggerKey: ";;" } }).input
        .startingTriggerKey,
    ).toBe(";;");
  });

  it("drops plain-HTTP rule feeds when upgrading and rejects new ones", () => {
    const migrated = migrateConfig({
      version: 3,
      remoteRules: [
        { url: "http://rules.example/r.json", enabled: true },
        { url: "https://rules.example/r.json", enabled: true },
      ],
    });
    expect(migrated.remoteRules).toEqual([
      { url: "https://rules.example/r.json", enabled: true },
    ]);
    expect(() =>
      migrateConfig({
        version: 4,
        remoteRules: [{ url: "http://rules.example/r.json", enabled: true }],
      }),
    ).toThrow();
  });

  it("applies and validates ChatGPT reasoning defaults", () => {
    expect(serviceConfigSchema.parse({ kind: "chatgpt" })).toMatchObject({
      reasoningEffort: "low",
      reasoningEffortAssistant: "medium",
    });
    expect(() =>
      serviceConfigSchema.parse({
        kind: "chatgpt",
        reasoningEffort: "minimal",
      }),
    ).toThrow();
  });

  it("upgrades legacy phase-one UI fields without losing service settings", () => {
    const migrated = migrateConfig({
      ...DEFAULT_CONFIG,
      version: 1,
      services: {
        google: { kind: "google", enabled: true },
        custom: {
          kind: "custom-http",
          enabled: true,
          baseUrl: "https://example.com/translate",
        },
      },
      shortcuts: {
        "toggle-translate": "Alt+Q",
        "toggle-whole-page": "Alt+E",
      },
      subtitle: {
        youtube: false,
        style: {
          mode: "translation",
          fontSize: 28,
          color: "#112233",
          background: "#010203",
          position: "top",
        },
      },
      pdf: { autoOpenOnline: true, translationMode: "translation" },
      globalCss: ".imt-target { color: red; }",
    });

    expect(migrated.version).toBe(CONFIG_VERSION);
    expect(migrated.services.custom).toMatchObject({
      kind: "custom-http",
      enabled: true,
    });
    expect(migrated.services.gemini).toEqual({
      kind: "gemini",
      enabled: false,
    });
    expect(migrated.services.chatgpt).toEqual({
      kind: "chatgpt",
      enabled: false,
      reasoningEffort: "low",
      reasoningEffortAssistant: "medium",
    });
    expect(migrated.shortcuts.toggleTranslatePage).toBe("Alt+Q");
    expect(migrated.subtitle).toMatchObject({
      youtube: false,
      mode: "translation-only",
      fontSize: 28,
      sourceColor: "#112233",
      translationColor: "#112233",
      backgroundColor: "#010203",
      position: "top",
    });
    expect(migrated.pdf).toMatchObject({
      interceptLinks: true,
      mode: "translation",
    });
    expect(migrated.globalCustomCss).toContain("color: red");
  });

  it("fills ChatGPT reasoning defaults when migrating an existing config", () => {
    const migrated = migrateConfig({
      ...DEFAULT_CONFIG,
      version: 2,
      services: {
        ...DEFAULT_CONFIG.services,
        chatgpt: { kind: "chatgpt", enabled: true, model: "gpt-5.5" },
      },
    });

    expect(migrated.services.chatgpt).toMatchObject({
      enabled: true,
      model: "gpt-5.5",
      reasoningEffort: "low",
      reasoningEffortAssistant: "medium",
    });
  });
});
