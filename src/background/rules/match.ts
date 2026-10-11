import { z } from "zod";

import type { Rule } from "../../shared/types";
import { builtinRules } from "./builtin-rules";
import { generalRule } from "./defaults";

const ADDITIONAL_FIELDS = {
  additionalExcludeSelectors: "excludeSelectors",
  additionalStayOriginalSelectors: "stayOriginalSelectors",
  additionalAtomicBlockSelectors: "atomicBlockSelectors",
  additionalExtraInlineSelectors: "extraInlineSelectors",
  additionalExtraBlockSelectors: "extraBlockSelectors",
  additionalShadowRootSelectors: "shadowRootSelectors",
  additionalMutationExcludeSelectors: "mutationExcludeSelectors",
  additionalInjectedCss: "injectedCss",
  additionalGlossaries: "glossaries",
} as const satisfies Partial<Record<keyof Rule, keyof Rule>>;

const stringArray = z.array(z.string());
const glossarySchema = z.object({
  k: z.string(),
  v: z.string(),
  domain: z.string().optional(),
});

// Importing the shared configuration module initializes a browser-only
// polyfill, so the editor-facing validator keeps an equivalent local schema.
const ruleValidationSchema: z.ZodType<Rule> = z.strictObject({
  id: z.string().optional(),
  matches: stringArray.min(1),
  excludeMatches: stringArray.optional(),
  selectorMatches: stringArray.optional(),
  selectors: stringArray.optional(),
  excludeSelectors: stringArray.optional(),
  additionalExcludeSelectors: stringArray.optional(),
  stayOriginalSelectors: stringArray.optional(),
  additionalStayOriginalSelectors: stringArray.optional(),
  atomicBlockSelectors: stringArray.optional(),
  additionalAtomicBlockSelectors: stringArray.optional(),
  extraInlineSelectors: stringArray.optional(),
  additionalExtraInlineSelectors: stringArray.optional(),
  extraBlockSelectors: stringArray.optional(),
  additionalExtraBlockSelectors: stringArray.optional(),
  shadowRootSelectors: stringArray.optional(),
  additionalShadowRootSelectors: stringArray.optional(),
  mutationExcludeSelectors: stringArray.optional(),
  additionalMutationExcludeSelectors: stringArray.optional(),
  injectedCss: stringArray.optional(),
  additionalInjectedCss: stringArray.optional(),
  excludeTags: stringArray.optional(),
  stayOriginalTags: stringArray.optional(),
  inlineTags: stringArray.optional(),
  allBlockTags: stringArray.optional(),
  isTranslateTitle: z.boolean().optional(),
  paragraphMinTextCount: z.number().int().nonnegative().optional(),
  blockMinTextCount: z.number().int().nonnegative().optional(),
  lineBreakMaxTextCount: z.number().int().nonnegative().optional(),
  targetWrapperTag: z.string().optional(),
  wrapperPrefix: z.string().optional(),
  wrapperSuffix: z.string().optional(),
  sameLangCheck: z.boolean().optional(),
  enableRichTranslate: z.boolean().optional(),
  glossaries: z.array(glossarySchema).optional(),
  additionalGlossaries: z.array(glossarySchema).optional(),
  translationMode: z.enum(["dual", "translation"]).optional(),
  theme: z.string().optional(),
  service: z.string().optional(),
  autoTranslate: z.boolean().optional(),
  mainFrameMinTextCount: z.number().int().nonnegative().optional(),
  likePreSelectors: stringArray.optional(),
  isTransformPreTagNewLine: z.boolean().optional(),
  advanceTransformPreTagNewLine: z.boolean().optional(),
});

export interface MatchRuleOptions {
  hasSelector?: (selector: string) => boolean;
  remoteRules?: readonly Rule[];
  /** Global display defaults, merged below every URL-scoped rule. */
  baseOverrides?: Partial<Rule>;
}

export interface RuleValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Match `text` against a pattern whose only metacharacter is `*`, in
 * O(pattern x text) time. A star may consume only characters accepted by
 * `starCanEat`. Compiling globs to regular expressions let a rule with many
 * stars (e.g. from a remote feed) backtrack for seconds on every page load.
 */
function wildcardMatch(
  pattern: string,
  text: string,
  starCanEat: (char: string) => boolean = () => true,
): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0 && starCanEat(text[mark]!)) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

const SCHEME = /^[a-z][a-z\d+.-]*$/;
const authorityStar = (char: string): boolean => char !== ":";

function splitUrl(
  value: string,
): { scheme: string; authority: string; suffix: string } | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return undefined;
  const remainder = value.slice(schemeEnd + 3);
  const suffixStart = remainder.search(/[/?#]/);
  return {
    scheme: value.slice(0, schemeEnd),
    authority: suffixStart < 0 ? remainder : remainder.slice(0, suffixStart),
    suffix: suffixStart < 0 ? "" : remainder.slice(suffixStart),
  };
}

function schemeMatches(pattern: string, scheme: string): boolean {
  if (!SCHEME.test(scheme)) return false;
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === scheme;
  // Each star stands for a whole scheme-shaped run; schemes are short.
  const compiled = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&"))
    .join("[a-z][a-z\\d+.-]*");
  return new RegExp(`^${compiled}$`).test(scheme);
}

function authorityMatches(pattern: string, authority: string): boolean {
  const bracketEnd = pattern.indexOf("]");
  const patternHasPort =
    bracketEnd >= 0
      ? pattern.slice(bracketEnd + 1).startsWith(":")
      : pattern.includes(":");
  const host = patternHasPort ? authority : authority.replace(/:\d+$/, "");
  if (!pattern.startsWith("*.")) {
    return wildcardMatch(pattern, host, authorityStar);
  }
  // "*.example.com" also matches "example.com": zero or more leading labels.
  const rest = pattern.slice(2);
  for (let start = 0; start <= host.length;) {
    if (wildcardMatch(rest, host.slice(start), authorityStar)) return true;
    const dot = host.indexOf(".", start);
    if (dot <= start || /[/:?#]/.test(host.slice(start, dot))) return false;
    start = dot + 1;
  }
  return false;
}

/** Test a URL against a match glob (`<all_urls>`, `scheme://authority/path`). */
export function globMatches(glob: string, url: string): boolean {
  const pattern = glob.toLowerCase();
  const candidate = url.toLowerCase();
  if (pattern === "<all_urls>") {
    return /^(?:(?:https?|ftp):\/\/|file:\/\/\/)/.test(candidate);
  }
  const parts = splitUrl(pattern);
  if (!parts) return wildcardMatch(pattern, candidate);
  const target = splitUrl(candidate);
  return (
    target !== undefined &&
    schemeMatches(parts.scheme, target.scheme) &&
    authorityMatches(parts.authority, target.authority) &&
    wildcardMatch(parts.suffix, target.suffix)
  );
}

function urlMatchesGlob(url: string, glob: string): boolean {
  let candidate = url;
  try {
    candidate = new URL(url).href;
  } catch {
    // Invalid URLs cannot be normalized, but matching the input is harmless.
  }
  return globMatches(glob, candidate);
}

function matchesRule(
  url: string,
  rule: Rule,
  options: MatchRuleOptions,
): boolean {
  if (!rule.matches.some((glob) => urlMatchesGlob(url, glob))) return false;
  if (rule.excludeMatches?.some((glob) => urlMatchesGlob(url, glob))) {
    return false;
  }

  if (!rule.selectorMatches?.length) return true;
  if (!options.hasSelector) return false;
  return rule.selectorMatches.some((selector) =>
    options.hasSelector?.(selector),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (isPlainObject(value)) return { ...value };
  return value;
}

/**
 * Merge rules from lowest to highest priority.
 * `additional*` arrays append to their target field, ordinary arrays replace,
 * and object-valued fields shallow-merge.
 */
export function mergeRules(base: Rule, ...overrides: Partial<Rule>[]): Rule {
  const result: Record<string, unknown> = {};

  for (const rule of [base, ...overrides]) {
    for (const [rawKey, value] of Object.entries(rule)) {
      if (value === undefined || rawKey in ADDITIONAL_FIELDS) continue;

      const existing = result[rawKey];
      if (isPlainObject(existing) && isPlainObject(value)) {
        result[rawKey] = Object.assign({}, existing, value);
      } else {
        result[rawKey] = cloneValue(value);
      }
    }

    for (const [rawKey, value] of Object.entries(rule)) {
      const target =
        ADDITIONAL_FIELDS[rawKey as keyof typeof ADDITIONAL_FIELDS];
      if (!target || !Array.isArray(value)) continue;

      const existing = result[target];
      result[target] = Array.isArray(existing)
        ? [...existing, ...value]
        : [...value];
    }
  }

  return result as unknown as Rule;
}

/** Merge the general, built-in, and user rules that match a URL. */
export function matchRule(
  url: string,
  userRules: Rule[] = [],
  options: MatchRuleOptions = {},
): Rule {
  const matchingBuiltins = builtinRules.filter((rule) =>
    matchesRule(url, rule, options),
  );
  const matchingRemoteRules = (options.remoteRules ?? []).filter((rule) =>
    matchesRule(url, rule, options),
  );
  const matchingUserRules = userRules.filter((rule) =>
    matchesRule(url, rule, options),
  );

  return mergeRules(
    generalRule,
    options.baseOverrides ?? {},
    ...matchingBuiltins,
    ...matchingRemoteRules,
    ...matchingUserRules,
  );
}

/** Match rules in a content-script document, including selector-gated rules. */
export function matchRuleInPage(
  url: string,
  rules: Rule[],
  document: Document,
): Rule {
  return matchRule(url, rules, {
    hasSelector(selector) {
      try {
        return document.querySelector(selector) !== null;
      } catch {
        return false;
      }
    },
  });
}

/** Validate a parsed value or JSON string for the user rule editor. */
export function validateRule(json: unknown): RuleValidationResult {
  let candidate = json;
  if (typeof json === "string") {
    try {
      candidate = JSON.parse(json) as unknown;
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : "Invalid JSON"],
      };
    }
  }

  const result = ruleValidationSchema.safeParse(candidate);
  if (result.success) return { ok: true, errors: [] };

  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "rule";
      return `${path}: ${issue.message}`;
    }),
  };
}
