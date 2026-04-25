import fs from "node:fs";
import { dataPath } from "./dataDir.js";

type ToneRewriteRule = {
  match?: string;
  replace?: string;
};

type ToneBlockedRule = {
  text?: string;
};

type DeterministicToneRulesFile = {
  auto?: {
    rewriteRules?: ToneRewriteRule[];
    blockedExactDrafts?: ToneBlockedRule[];
  };
  manual?: {
    rewriteRules?: ToneRewriteRule[];
    blockedExactDrafts?: ToneBlockedRule[];
  };
};

type LoadedToneRules = {
  sourcePath: string;
  loadedAtMs: number;
  mtimeMs: number;
  rewrites: Array<{ pattern: RegExp; replace: string }>;
  blockedExact: Set<string>;
};

const DEFAULT_BLOCKED_FALLBACK = "Still happy to help. Text me when you're ready.";

const DETERMINISTIC_TONE_RULES_CACHE_MS = (() => {
  const raw = Number(process.env.DETERMINISTIC_TONE_RULES_CACHE_MS ?? "60000");
  if (!Number.isFinite(raw) || raw <= 0) return 60000;
  return Math.floor(raw);
})();

let deterministicToneRulesCache: LoadedToneRules | null = null;

function normalizeText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeRuleKey(input: unknown): string {
  return normalizeText(input).toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveDeterministicToneRulesPath(): string {
  const configured = normalizeText(process.env.DETERMINISTIC_TONE_RULES_PATH);
  return configured || dataPath("deterministic_tone_rules.json");
}

function normalizeRewriteRules(file: DeterministicToneRulesFile): Array<{ pattern: RegExp; replace: string }> {
  const merged = [
    ...(Array.isArray(file.manual?.rewriteRules) ? file.manual?.rewriteRules : []),
    ...(Array.isArray(file.auto?.rewriteRules) ? file.auto?.rewriteRules : [])
  ];
  const out: Array<{ pattern: RegExp; replace: string }> = [];
  for (const row of merged) {
    const match = normalizeText(row?.match);
    const replace = normalizeText(row?.replace);
    if (!match || !replace) continue;
    if (normalizeRuleKey(match) === normalizeRuleKey(replace)) continue;
    out.push({
      pattern: new RegExp(escapeRegex(match), "gi"),
      replace
    });
  }
  return out;
}

function normalizeBlockedExactRules(file: DeterministicToneRulesFile): Set<string> {
  const merged = [
    ...(Array.isArray(file.manual?.blockedExactDrafts) ? file.manual?.blockedExactDrafts : []),
    ...(Array.isArray(file.auto?.blockedExactDrafts) ? file.auto?.blockedExactDrafts : [])
  ];
  const out = new Set<string>();
  for (const row of merged) {
    const key = normalizeRuleKey(row?.text);
    if (!key) continue;
    out.add(key);
  }
  return out;
}

function loadDeterministicToneRules(): LoadedToneRules | null {
  const sourcePath = resolveDeterministicToneRulesPath();
  const nowMs = Date.now();
  if (
    deterministicToneRulesCache &&
    deterministicToneRulesCache.sourcePath === sourcePath &&
    nowMs - deterministicToneRulesCache.loadedAtMs < DETERMINISTIC_TONE_RULES_CACHE_MS
  ) {
    return deterministicToneRulesCache;
  }

  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(sourcePath).mtimeMs;
  } catch {
    deterministicToneRulesCache = {
      sourcePath,
      loadedAtMs: nowMs,
      mtimeMs: -1,
      rewrites: [],
      blockedExact: new Set<string>()
    };
    return deterministicToneRulesCache;
  }

  if (
    deterministicToneRulesCache &&
    deterministicToneRulesCache.sourcePath === sourcePath &&
    deterministicToneRulesCache.mtimeMs === mtimeMs
  ) {
    deterministicToneRulesCache.loadedAtMs = nowMs;
    return deterministicToneRulesCache;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as DeterministicToneRulesFile;
    deterministicToneRulesCache = {
      sourcePath,
      loadedAtMs: nowMs,
      mtimeMs,
      rewrites: normalizeRewriteRules(parsed),
      blockedExact: normalizeBlockedExactRules(parsed)
    };
  } catch {
    deterministicToneRulesCache = {
      sourcePath,
      loadedAtMs: nowMs,
      mtimeMs,
      rewrites: [],
      blockedExact: new Set<string>()
    };
  }

  return deterministicToneRulesCache;
}

function applyDeterministicToneRules(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  const loaded = loadDeterministicToneRules();
  if (!loaded) return out;

  for (const rule of loaded.rewrites) {
    out = out.replace(rule.pattern, rule.replace);
  }

  if (loaded.blockedExact.has(normalizeRuleKey(out))) {
    return DEFAULT_BLOCKED_FALLBACK;
  }

  return out;
}

function repairDanglingAcknowledgements(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  out = out.replace(
    /\b(thanks\s+for\s+the)\s*(?:[.!?]|$)/gi,
    "thanks for the update."
  );
  out = out.replace(
    /\b(thanks\s+for\s+your)\s*(?:[.!?]|$)/gi,
    "thanks for your message."
  );
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return out;
}

function dedupeIdentityIntro(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;

  const introMatches = Array.from(
    out.matchAll(/\bthis is\s+([^.]{1,80}?)\s+at\s+([^.]{2,120})\.?\s*/gi)
  );
  if (introMatches.length <= 1) return out;

  const first = introMatches[0];
  const firstIndex = first.index ?? -1;
  if (firstIndex < 0) return out;

  let rebuilt = "";
  let cursor = 0;
  let keptFirst = false;
  for (const match of introMatches) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const full = String(match[0] ?? "");
    if (!full) continue;
    rebuilt += out.slice(cursor, start);
    if (!keptFirst) {
      rebuilt += full;
      keptFirst = true;
    }
    cursor = start + full.length;
  }
  rebuilt += out.slice(cursor);
  out = rebuilt.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();

  return out;
}

export function normalizeSalesToneBase(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  out = dedupeIdentityIntro(out);

  const replacements: Array<[RegExp, string]> = [
    [
      /\bTotally understand, and thank you for saying that about the bike\.\b/gi,
      "I hear you, and I appreciate that."
    ],
    [
      /\bTotally understand\.\s*If anything changes, just reach out\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ],
    [
      /\bTotally understand, and I appreciate that\.\s*If anything changes, just reach out\.\b/gi,
      "I hear you, and I appreciate that. If anything changes down the road, just give me a shout."
    ],
    [
      /\bIf anything changes, just reach out\.\b/gi,
      "If anything changes down the road, just give me a shout."
    ],
    [
      /\bIf anything changes, just let me know\.\b/gi,
      "If anything changes down the road, just give me a shout."
    ],
    [
      /\bI(?:’|')m here when you(?:’|')re ready\.\s*Just reach out when the time is right\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ],
    [
      /\bNo problem\s*[—-]\s*I(?:’|')m here when you(?:’|')re ready\.\s*Just reach out when the time is right\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ],
    [
      /\bUnderstood\s*[—-]\s*I(?:’|')m here when you(?:’|')re ready\.\s*Just reach out when the time is right\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ]
  ];

  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

export function applyDeterministicToneOverrides(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  out = applyDeterministicToneRules(out);
  out = repairDanglingAcknowledgements(out);
  return out;
}

export function normalizeSalesTone(text: string): string {
  return applyDeterministicToneOverrides(normalizeSalesToneBase(text));
}

function firstToken(value: string): string {
  const token = String(value ?? "")
    .trim()
    .split(/\s+/)[0];
  return token || "there";
}

export function formatSmsLayout(text: string): string {
  let out = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!out) return out;
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

export function formatEmailLayout(
  text: string,
  opts?: {
    firstName?: string | null;
    fallbackName?: string | null;
  }
): string {
  let out = formatSmsLayout(text);
  if (!out) return out;
  const preferredName = firstToken(opts?.firstName ?? "");
  const fallbackName = firstToken(opts?.fallbackName ?? "there");
  const greetingName = preferredName !== "there" ? preferredName : fallbackName;
  out = out.replace(/^Hi\s+([^—,\n]+)\s*[—-]\s*/i, (_m, name) => `Hi ${String(name).trim()},\n\n`);
  if (!/^(Hi|Hello)\s+[^,\n]+,\s*/i.test(out)) {
    out = `Hi ${greetingName},\n\n${out}`;
  }
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
