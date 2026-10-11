import type {
  BilingualSubtitleCue,
  SubtitleCue,
} from "../../../shared/subtitle-types";
import type { FeatureContext } from "../context";

export const MAX_CUES_PER_BATCH = 50;
export const MAX_CHARS_PER_BATCH = 4_000;
export const DEFAULT_ROLLING_WINDOW_SECONDS = 60;
/**
 * The rolling window re-runs on every timeupdate (about 4 Hz). Without a
 * cooldown, a failing service (bad key, offline, HTTP 429) would get every
 * untranslated cue in the window resent several times a second.
 */
export const FAILED_CUE_RETRY_MS = 30_000;

// Any page can add a <track> to a <video>, so the rolling window is the
// page's lever on the user's translation service. Keep it small and slow.
export const MAX_WINDOW_CUES = 30;
export const MAX_WINDOW_CHARS = 3_000;
export const WINDOW_INTERVAL_MS = 1_000;
export const PAGE_CUES_PER_MINUTE = 240;
/** Upper bound for the per-engine translation and failure maps. */
export const MAX_REMEMBERED_CUES = 2_000;

/**
 * A per-page allowance shared by every SubtitleEngine, so spawning more
 * videos or swapping tracks every second does not multiply it.
 */
export class CueBudget {
  private windowStart = -Infinity;
  private used = 0;

  constructor(private readonly perMinute = PAGE_CUES_PER_MINUTE) {}

  take(requested: number, now: number): number {
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.used = 0;
    }
    const granted = Math.max(
      0,
      Math.min(requested, this.perMinute - this.used),
    );
    this.used += granted;
    return granted;
  }
}

const pageCueBudget = new CueBudget();

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED_CUES) {
    map.delete(map.keys().next().value as K);
  }
}

const SENTENCE_END = /[.!?。！？…][\]})"'”’]*$/;

function validCue(cue: SubtitleCue): boolean {
  return (
    Number.isFinite(cue.start) &&
    Number.isFinite(cue.end) &&
    cue.end > cue.start &&
    cue.text.trim().length > 0
  );
}

function splitLongCue(cue: SubtitleCue, maxChars: number): SubtitleCue[] {
  const text = cue.text.trim();
  if (text.length <= maxChars) return [{ ...cue, text }];
  const pieces: SubtitleCue[] = [];
  const count = Math.ceil(text.length / maxChars);
  const duration = cue.end - cue.start;
  for (let start = 0; start < text.length; start += maxChars) {
    const index = pieces.length;
    pieces.push({
      ...cue,
      id: undefined,
      start: cue.start + (duration * index) / count,
      end: cue.start + (duration * (index + 1)) / count,
      text: text.slice(start, start + maxChars),
    });
  }
  return pieces;
}

/** Join short source cues into sentence-level translation batches. */
export function batchCueSentences(
  input: readonly SubtitleCue[],
  maxCues = MAX_CUES_PER_BATCH,
  maxChars = MAX_CHARS_PER_BATCH,
): SubtitleCue[] {
  const cues = input
    .filter(validCue)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .flatMap((cue) => splitLongCue(cue, maxChars));
  const batches: SubtitleCue[] = [];
  let current: SubtitleCue[] = [];
  let chars = 0;

  const flush = (): void => {
    if (!current.length) return;
    batches.push({
      id: current.length === 1 ? current[0].id : undefined,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((cue) => cue.text.trim()).join(" "),
    });
    current = [];
    chars = 0;
  };

  for (const cue of cues) {
    const nextChars = chars + (current.length ? 1 : 0) + cue.text.length;
    if (current.length && (current.length >= maxCues || nextChars > maxChars)) {
      flush();
    }
    current.push(cue);
    chars += (current.length > 1 ? 1 : 0) + cue.text.length;
    if (SENTENCE_END.test(cue.text.trim())) flush();
  }
  flush();
  return batches;
}

export interface SubtitleEngineOptions {
  preTranslation?: boolean;
  rollingWindowSeconds?: number;
  cache?: Map<string, string>;
  now?: () => number;
  budget?: CueBudget;
}

/** Translate and cache a timed cue stream for live rendering. */
export class SubtitleEngine {
  private readonly cache: Map<string, string>;
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly failedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly budget: CueBudget;
  private lastWindowAt = -Infinity;
  private currentTime = 0;
  private readonly listeners = new Set<
    (cues: readonly BilingualSubtitleCue[]) => void
  >();
  private cues: BilingualSubtitleCue[] = [];
  private generation = 0;
  private preTranslation: boolean;
  private readonly rollingWindowSeconds: number;

  constructor(
    private readonly ctx: Pick<FeatureContext, "config" | "translateText">,
    options: SubtitleEngineOptions = {},
  ) {
    this.preTranslation = options.preTranslation ?? false;
    this.rollingWindowSeconds =
      options.rollingWindowSeconds ?? DEFAULT_ROLLING_WINDOW_SECONDS;
    this.cache = options.cache ?? new Map();
    this.now = options.now ?? Date.now;
    this.budget = options.budget ?? pageCueBudget;
  }

  get bilingualCues(): readonly BilingualSubtitleCue[] {
    return this.cues.map((cue) => ({ ...cue }));
  }

  get isPreTranslationEnabled(): boolean {
    return this.preTranslation;
  }

  subscribe(
    listener: (cues: readonly BilingualSubtitleCue[]) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.bilingualCues);
    return () => this.listeners.delete(listener);
  }

  async load(input: readonly SubtitleCue[]): Promise<void> {
    this.generation += 1;
    this.cues = batchCueSentences(input).map((cue, index) => ({
      ...cue,
      id: cue.id ?? `subtitle-${index + 1}`,
    }));
    this.emit();
    if (this.preTranslation) await this.translateUpcoming(true);
  }

  async setPreTranslation(enabled: boolean): Promise<void> {
    this.preTranslation = enabled;
    if (enabled) await this.translateUpcoming(true);
  }

  async updateCurrentTime(currentTime: number): Promise<void> {
    this.currentTime = currentTime;
    await this.translateUpcoming(false);
  }

  /**
   * Translate the next cues from the playback position: the rolling window,
   * or with pre-translation the rest of the track. Either way at most
   * MAX_WINDOW_CUES / MAX_WINDOW_CHARS per call and once a second (an
   * explicit toggle may skip the wait), charged to the shared page budget.
   * Cues already cached, in flight, or cooling down are not charged again.
   */
  private async translateUpcoming(force: boolean): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastWindowAt < WINDOW_INTERVAL_MS) return;
    this.lastWindowAt = now;

    const start = this.currentTime;
    const windowEnd = this.preTranslation
      ? Infinity
      : start + this.rollingWindowSeconds;
    const indices: number[] = [];
    let chars = 0;
    let filled = false;
    for (const [index, cue] of this.cues.entries()) {
      if (cue.end < start || cue.start > windowEnd) continue;
      if (cue.translation !== undefined) continue;
      const key = this.keyFor(cue.text);
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        cue.translation = cached;
        filled = true;
        continue;
      }
      if (this.inFlight.has(key) || this.coolingDown(key, now)) continue;
      if (
        indices.length >= MAX_WINDOW_CUES ||
        chars + cue.text.length > MAX_WINDOW_CHARS
      ) {
        break;
      }
      indices.push(index);
      chars += cue.text.length;
    }
    if (filled) this.emit();
    const granted = this.budget.take(indices.length, now);
    await this.translateIndices(indices.slice(0, granted), this.generation);
  }

  private keyFor(text: string): string {
    const { sourceLanguage, targetLanguage } = this.ctx.config;
    return `${sourceLanguage}\u0000${targetLanguage}\u0000${text}`;
  }

  private coolingDown(key: string, now: number): boolean {
    const failed = this.failedAt.get(key);
    return failed !== undefined && now - failed < FAILED_CUE_RETRY_MS;
  }

  activeCue(currentTime: number): BilingualSubtitleCue | undefined {
    const cue = this.cues.find(
      (item) => item.start <= currentTime && currentTime < item.end,
    );
    return cue ? { ...cue } : undefined;
  }

  private async translateIndices(
    indices: readonly number[],
    generation: number,
  ): Promise<void> {
    let batch: number[] = [];
    let chars = 0;
    const batches: number[][] = [];
    for (const index of indices) {
      const cue = this.cues[index];
      if (!cue || cue.translation !== undefined) continue;
      if (
        batch.length &&
        (batch.length >= MAX_CUES_PER_BATCH ||
          chars + cue.text.length > MAX_CHARS_PER_BATCH)
      ) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(index);
      chars += cue.text.length;
    }
    if (batch.length) batches.push(batch);

    for (const item of batches) {
      await Promise.all(
        item.map(async (index) => {
          const cue = this.cues[index];
          if (!cue) return;
          try {
            const translation = await this.translate(cue.text);
            if (generation === this.generation && this.cues[index] === cue) {
              cue.translation = translation;
            }
          } catch {
            // A failed cue remains untranslated and can be retried on the next window update.
          }
        }),
      );
      if (generation !== this.generation) return;
      this.emit();
    }
  }

  private translate(text: string): Promise<string> {
    const from = this.ctx.config.sourceLanguage;
    const to = this.ctx.config.targetLanguage;
    const key = this.keyFor(text);
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (this.coolingDown(key, this.now())) {
      return Promise.reject(new Error("Subtitle cue is cooling down."));
    }

    const request = this.ctx
      .translateText(text, from, to)
      .then(
        (translation) => {
          this.failedAt.delete(key);
          remember(this.cache, key, translation);
          return translation;
        },
        (error: unknown) => {
          remember(this.failedAt, key, this.now());
          throw error;
        },
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private emit(): void {
    const snapshot = this.bilingualCues;
    for (const listener of this.listeners) listener(snapshot);
  }
}
