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

// A modal/auxiliary ("can", "will", "could", ...) must be followed by a bare
// verb, never a bare determiner/quantifier. "I can a couple time options" (the
// verb "send" dropped by a malformed rewrite or a hand edit) is therefore always
// ungrammatical. Used both to reject a rewrite that would introduce the gap and
// to repair one that slipped through to a sent message.
const MODAL_VERB_GAP_RE =
  /\b(i|we|you|they)\s+(can|could|will|would|can't|cannot|won't)\s+(a|an|the|some|any|two|your|my)\b/i;

function hasModalVerbGap(text: string): boolean {
  return MODAL_VERB_GAP_RE.test(String(text ?? ""));
}

export function repairDroppedModalVerb(text: string): string {
  const out = String(text ?? "");
  if (!out || !hasModalVerbGap(out)) return out;
  // Restore the domain-default verb ("send") between the modal and the
  // determiner so the sentence reads grammatically again. A modal is never
  // grammatically followed by a determiner, so this only fires on a real gap.
  return out.replace(
    /\b(i|we|you|they)\s+(can|could|will|would|can't|cannot|won't)\s+(a|an|the|some|any|two|your|my)\b/gi,
    (_m, subject: string, modal: string, det: string) => `${subject} ${modal} send ${det}`
  );
}

export function repairDoubledArticle(text: string): string {
  // Collapse an accidental doubled determiner ("the the X", "a a X", "an an X")
  // produced when a label-prefix path prepends an article to a label that
  // already carries one. Deterministic cleanup of our own composed copy; a
  // doubled article is never grammatical, so this is safe on any outbound text.
  const out = String(text ?? "");
  if (!out) return out;
  return out.replace(/\b(the|a|an)\s+\1\b/gi, "$1");
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
    const candidate = out.replace(rule.pattern, rule.replace);
    if (candidate === out) continue;
    // Verb-loss guard: a promoted/manual rewrite must never turn a grammatical
    // modal phrase into a verb-dropped one ("I can send two ..." ->
    // "I can a couple ..."). Skip any rule whose effect introduces that gap so a
    // malformed delta can't ship a broken sentence to a customer.
    if (hasModalVerbGap(candidate) && !hasModalVerbGap(out)) continue;
    out = candidate;
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

function repairIncompleteSentence(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  const lower = out.toLowerCase();
  const quoteSuffix = /["')\]]+$/.test(out) ? out.match(/["')\]]+$/)?.[0] ?? "" : "";
  const core = quoteSuffix ? out.slice(0, -quoteSuffix.length).trimEnd() : out;
  const coreLower = core.toLowerCase();

  if (/\b(?:we can|i can)$/.test(coreLower)) {
    const suffix = /\b(rain|rained out|weather)\b/.test(lower) ? " set up another time." : " follow up.";
    return `${core}${suffix}${quoteSuffix}`.replace(/\s{2,}/g, " ").trim();
  }

  if (/\b(?:and\s+)?(?:ping|text|call|reach out|get a hold of me|let me know)\s+when$/.test(coreLower)) {
    return `${core.replace(/\b(?:and\s+)?(?:ping|text|call|reach out|get a hold of me|let me know)\s+when$/i, "just text me when you're ready.")}${quoteSuffix}`
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  if (/\b(and|or|to|the|when|if|with|for)$/.test(coreLower)) {
    return `${core.replace(/\s+\b(and|or|to|the|when|if|with|for)$/i, "").trim()}.${quoteSuffix}`
      .replace(/\s+\./g, ".")
      .trim();
  }

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

/**
 * Joe (2026-06-20): the curt "Got it" acknowledgment must never ship in any customer-facing
 * outbound — follow-up cadence, Twilio SMS, or email. On the SMS/draft path the lead-in
 * normalizer (`normalizeGotItLeadIn` in conversationStore) already rewrites it to a contextual
 * opener; this is the UNIVERSAL backstop at the tone sink, so the email path (which bypasses that
 * normalizer) and any future deterministic template are covered in one place.
 *
 * Scoped to the sentence-initial / post-greeting ACK only. The possessive "we've got it in stock"
 * and the affirmation "You got it" carry different meaning and are deliberately preserved — they
 * never present as a capitalized "Got it" token at a boundary, so the matcher leaves them intact.
 */
export function stripGotItAcknowledgement(text: string): string {
  let out = String(text ?? "");
  if (!out.trim()) return out;
  // Whole message is just the bare ack → a warm one-word replacement.
  if (/^\s*got it\s*[.!]*\s*$/i.test(out)) return "Sounds good.";
  // Drop a "Got it" ack that opens the message, a line (email greeting block), or a sentence,
  // then promote and capitalize the clause that followed it. Capital "Got it" only, so the
  // lowercase possessive "we've got it" / affirmation "you got it" are untouched.
  out = out.replace(
    /(^|\n[^\S\n]*|[.!?]\s+)Got it\s*(?:[—–-]\s*|[,.:]\s+|\s+)(\S)/g,
    (_m, boundary, ch) => `${boundary}${ch.toUpperCase()}`
  );
  return out.trim();
}

export function applyDeterministicToneOverrides(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  out = stripGotItAcknowledgement(out);
  out = applyDeterministicToneRules(out);
  out = repairDanglingAcknowledgements(out);
  out = repairIncompleteSentence(out);
  // Final grammar net before the text reaches a customer: restore a verb dropped
  // between a modal and a determiner, and collapse a doubled article. Both run
  // last so they also catch gaps introduced by an upstream edit, not just a
  // tone rewrite.
  out = repairDroppedModalVerb(out);
  out = repairDoubledArticle(out);
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
