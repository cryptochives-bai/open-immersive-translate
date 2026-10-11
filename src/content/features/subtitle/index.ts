import browser from "webextension-polyfill";

import {
  DEFAULT_SUBTITLE_CONFIG,
  type SubtitleConfig,
  type SubtitleCue,
} from "../../../shared/subtitle-types";
import { featureBus, SUBTITLE_PRETRANSLATION_EVENT } from "../bus";
import type { FeatureContext } from "../context";
import {
  matchingSubtitleAdapters,
  SubtitleCaptureHub,
  type SubtitleCueTrack,
} from "./adapters";
import { installCaptureBridge } from "./capture-bridge";
import { SubtitleEngine } from "./engine";
import { subtitleText } from "./i18n";
import { SubtitleRenderer } from "./renderer";
import { isUserEvent } from "../trusted";

export const TOGGLE_SUBTITLE_PRETRANSLATION_MESSAGE =
  "toggleVideoSubtitlePreTranslation";

interface SubtitleSession {
  engine: SubtitleEngine;
  renderer: SubtitleRenderer;
  fingerprint: string;
  dispose(): void;
}

function resolveConfig(ctx: FeatureContext): SubtitleConfig {
  const raw = ctx.config.subtitle as FeatureContext["config"]["subtitle"] &
    Partial<SubtitleConfig>;
  return { ...DEFAULT_SUBTITLE_CONFIG, ...raw };
}

// Set once this content script sees a real (trusted) pointer or key press on
// the page. navigator.userActivation is not used: browser-initiated
// navigations can already count as activation, and pages cannot forge
// isTrusted.
let pageInteracted = false;
let watchingInteraction = false;

function watchForUserInteraction(): void {
  if (watchingInteraction) return;
  watchingInteraction = true;
  const mark = (event: Event): void => {
    if (isUserEvent(event)) pageInteracted = true;
  };
  for (const type of ["pointerdown", "keydown"]) {
    document.addEventListener(type, mark, { capture: true, passive: true });
  }
}

/**
 * Translate only while the media plays on a page the user has interacted
 * with. Otherwise any page could add a muted, autoplaying <video> with a
 * caption track and spend the user's translation service with no
 * interaction at all.
 */
export function userIsWatching(
  media: Pick<HTMLMediaElement, "paused">,
  interacted = pageInteracted,
): boolean {
  return !media.paused && interacted;
}

function cueFingerprint(cues: readonly SubtitleCue[]): string {
  return cues
    .map((cue) => `${cue.start}|${cue.end}|${cue.text}`)
    .join("\u0000");
}

function persistConfig(config: SubtitleConfig): void {
  void browser.runtime
    .sendMessage({ type: "setConfig", patch: { subtitle: config } })
    .catch(() => undefined);
}

/** Initialize network and TextTrack subtitle adapters for the current page. */
export function initSubtitles(ctx: FeatureContext): () => void {
  let config = resolveConfig(ctx);
  const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtubekids\.com$/.test(
    window.location.hostname,
  );
  if (!config.enabled || (isYouTube && !config.youtube)) {
    return () => undefined;
  }

  watchForUserInteraction();
  const adapters = matchingSubtitleAdapters(window.location.href);
  const captureHub = new SubtitleCaptureHub();
  const sessions = new Map<HTMLMediaElement, SubtitleSession>();
  const unsubscribers: Array<() => void> = [];

  const acceptTrack = (track: SubtitleCueTrack): void => {
    const media =
      track.media ??
      document.querySelector<HTMLMediaElement>("video, audio") ??
      undefined;
    if (!media || !track.cues.length) return;
    const fingerprint = cueFingerprint(track.cues);
    const existing = sessions.get(media);
    if (existing?.fingerprint === fingerprint) return;
    existing?.dispose();

    // Pre-translation waits for the same gate as the rolling window below.
    const engine = new SubtitleEngine(ctx, { preTranslation: false });
    let preTranslationApplied = false;
    const renderer = new SubtitleRenderer(media, config, {
      experimental: track.experimental,
      experimentalLabel: subtitleText("experimental"),
      onStyleChange: (style) => {
        config = style;
        for (const session of sessions.values()) {
          if (session.renderer !== renderer)
            session.renderer.updateStyle(style);
        }
        persistConfig(config);
      },
    });
    const unsubscribe = engine.subscribe((cues) => renderer.setCues(cues));
    const updateRollingWindow = (): void => {
      if (!userIsWatching(media)) return;
      if (config.preTranslation && !preTranslationApplied) {
        preTranslationApplied = true;
        void engine.setPreTranslation(true).catch(() => undefined);
        return;
      }
      void engine.updateCurrentTime(media.currentTime).catch(() => undefined);
    };
    media.addEventListener("timeupdate", updateRollingWindow);
    media.addEventListener("seeking", updateRollingWindow);
    media.addEventListener("play", updateRollingWindow);

    const session: SubtitleSession = {
      engine,
      renderer,
      fingerprint,
      dispose: () => {
        unsubscribe();
        media.removeEventListener("timeupdate", updateRollingWindow);
        media.removeEventListener("seeking", updateRollingWindow);
        media.removeEventListener("play", updateRollingWindow);
        renderer.dispose();
      },
    };
    sessions.set(media, session);
    void engine
      .load(track.cues)
      .then(updateRollingWindow)
      .catch(() => undefined);
  };

  for (const adapter of adapters) {
    const source = adapter.hook({ document, captures: captureHub });
    unsubscribers.push(source.subscribe(acceptTrack));
  }
  const capturePatterns = adapters.flatMap(
    (adapter) => adapter.capturePatterns,
  );
  const disposeBridge = installCaptureBridge(capturePatterns, (capture) =>
    captureHub.emit(capture),
  );

  const onMessage = (message: unknown): undefined => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== TOGGLE_SUBTITLE_PRETRANSLATION_MESSAGE
    ) {
      return undefined;
    }
    config = { ...config, preTranslation: !config.preTranslation };
    persistConfig(config);
    for (const session of sessions.values()) {
      void session.engine
        .setPreTranslation(config.preTranslation)
        .catch(() => undefined);
    }
    return undefined;
  };
  const onControllerToggle = (): void => {
    config = { ...config, preTranslation: !config.preTranslation };
    persistConfig(config);
    for (const session of sessions.values()) {
      void session.engine
        .setPreTranslation(config.preTranslation)
        .catch(() => undefined);
    }
  };
  browser.runtime.onMessage.addListener(onMessage);
  featureBus.addEventListener(
    SUBTITLE_PRETRANSLATION_EVENT,
    onControllerToggle,
  );

  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    featureBus.removeEventListener(
      SUBTITLE_PRETRANSLATION_EVENT,
      onControllerToggle,
    );
    disposeBridge();
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  };
}

export const init = initSubtitles;
