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

/**
 * Drop a SECOND self-introduction naming the agent we already introduced.
 *
 * `dedupeIdentityIntro` only recognizes the old `this is {agent} at {dealer}` form, so it can't see
 * the softened opener (`it's {agent} over at {dealer}`, live since 2026-06-15) or the LLM tacking on
 * a bare `I'm {agent}`. Jason Marshall (+17165230421, 2026-07-29) shipped as:
 *   "Hey Jason, it's Alexandra over at American H-D. Gotcha — I'll have our sales team check the
 *    build timeline… I'm Alexandra, nice to meet you, I'll confirm details and text you back…"
 * and Joe hand-stripped the second intro before sending.
 *
 * Deliberately surgical: this removes ONLY the redundant intro fragment (plus an immediately
 * trailing pleasantry), never through to the end of the sentence — the Jason draft carried real
 * content ("I'll confirm details and text you back") right after it. It also anchors on the SAME
 * name used in the first intro, so an unrelated "it's Scott you'll be meeting" is untouched.
 * A deterministic output guard at the universal tone sink, per the de-corp enforcement pattern.
 */
/** Words that follow "it's/I'm" constantly but are never the agent's name. */
const NOT_A_NAME = new Set([
  "a", "an", "the", "my", "our", "your", "his", "her", "their", "no", "not", "just", "still",
  "great", "good", "happy", "here", "there", "going", "about", "all", "also", "always", "usually",
  "best", "worth", "possible", "tough", "hard", "easy", "close", "open", "free", "ready", "fine",
  "i", "we", "you", "he", "she", "they", "it", "that", "this", "one", "up", "on", "in", "at"
]);

function dropRepeatSelfIntro(text: string): string {
  const out = String(text ?? "").trim();
  if (!out) return out;
  // First intro, any supported form → capture who we said we were. The name must be genuinely
  // capitalized in the SOURCE (a case-insensitive [A-Z] would happily match "it's a great bike").
  let first: RegExpExecArray | null = null;
  let agent = "";
  const finder = /\b(?:this is|it'?s|i'?m|i am)\s+([\w'-]+)\b/gi;
  for (let m = finder.exec(out); m; m = finder.exec(out)) {
    const candidate = String(m[1] ?? "");
    if (!/^[A-Z][\w'-]*$/.test(candidate)) continue; // real capitalization, not the /i flag's
    if (NOT_A_NAME.has(candidate.toLowerCase())) continue;
    first = m;
    agent = candidate;
    break;
  }
  if (!first || !agent || (first.index ?? -1) < 0) return out;
  const after = (first.index ?? 0) + String(first[0]).length;
  const head = out.slice(0, after);
  const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repeat = new RegExp(
    `\\b(?:this is|it'?s|i'?m|i am)\\s+${escaped}\\b(?:\\s+(?:over\\s+)?at\\s+[^.,!?]{2,60})?` +
      `(?:\\s*,?\\s*(?:nice|good|great)\\s+to\\s+(?:meet|e-?meet)\\s+you)?\\s*[,.!]?\\s*`,
    "gi"
  );
  const tail = out.slice(after).replace(repeat, " ");
  let joined = `${head} ${tail}`
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  // Re-capitalize a clause left dangling by the removal ("… timeline. i'll confirm …").
  joined = joined.replace(/([.!?]\s+)([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`);
  return joined;
}

export function normalizeSalesToneBase(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;
  out = dedupeIdentityIntro(out);
  out = dropRepeatSelfIntro(out);

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

/**
 * Does this body already open with its OWN greeting?
 *
 * `formatEmailLayout` prepends "Hi <name>," when the composer didn't write a greeting, so this test
 * has to recognise every greeting the composer actually writes — not just the "Hi" the prepend
 * happens to use. It knew only `Hi <name>,` and `Hello <name>,`, and missed two shapes that the
 * composer produces constantly. Both reached customers as a doubled greeting:
 *   - `Hey <name>,` — the agent's own voice on every ADF first touch. Michael Hooker
 *     (+17165481952, 2026-08-07) received *"Hi Michael,\n\nHey Michael, it's Alexandra over at
 *     American Harley-Davidson."*
 *   - `Hi, this is <rep>…` — a greeting with no name at all (+17168610158).
 * Ten more were sitting in the unsent-draft queue when this was found.
 *
 * DETECTS "Hey" without rewriting it: the composer chose that word, and this function's job is
 * layout, not voice. Fail direction is unchanged — an unrecognised opening still gets a greeting
 * prepended, which is exactly today's behaviour.
 */
const EMAIL_BODY_OPENS_WITH_GREETING = /^(hi|hey|hello|hiya)\b\s*(?:,|[^,\n]{1,60},)/i;

/**
 * ADDRESSING SOMEONE BY NAME IS ALSO A GREETING, even with no greeting word in front of it.
 *
 * Measured 2026-08-07, and it is the fix above tripping over itself: the colour-correction copy
 * that shipped with it opens *"Michael — one correction on my last note…"*. No hi/hey/hello, so
 * the test above failed and the layout stacked another greeting on top —
 * *"Hi Michael,\n\nMichael — one correction…"* went out to +17165481952 at 13:04Z, nine minutes
 * after the deploy that was supposed to have ended doubled greetings.
 *
 * Deliberately narrow: only the EXACT name we were about to greet with counts, and only when it
 * is followed by a comma or a dash. Any other opening still gets a greeting prepended, which is
 * today's behaviour — an email that reads slightly abrupt is a far smaller failure than one that
 * says the customer's name twice in two lines.
 */
function emailBodyOpensByAddressing(body: string, name: string): boolean {
  const addressed = String(name ?? "").trim();
  if (!addressed || addressed.toLowerCase() === "there") return false;
  const escaped = addressed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*(?:,|[—-])\\s`, "i").test(body);
}

/**
 * A line that is a salutation and NOTHING else: "Hi Lucas," / "Hey Pedro," / "Hello," / "Hi there,".
 *
 * Deliberately requires the line to END right after the (optional) name and terminator. That is what
 * separates a content-free opener from a greeting that carries the message —
 * *"Hi, this is Brooke at American Harley-Davidson!"* is a greeting but NOT bare, because dropping
 * it would delete a sentence.
 */
const BARE_SALUTATION_LINE = /^(hi|hey|hello|hiya)(?:\s+[^\n,]{1,40})?\s*[,!.—-]?$/i;

/**
 * Drop a BARE leading salutation when the body's next line greets the customer all over again.
 *
 * The 2026-08-07 fix (see `EMAIL_BODY_OPENS_WITH_GREETING` above) stopped this function CREATING a
 * doubled greeting: hand it a bare body and it prepends exactly one. It never stopped this function
 * PASSING ONE THROUGH. Given a body that already arrives doubled it sees the greeting on line 1,
 * correctly declines to prepend, and never looks at line 2.
 *
 * That gap re-opened the class 11 days later. The Claude draft reviewer is told to "keep its
 * greeting" when it rewrites an email; on 2026-08-18T21:03:48Z it rewrote a template that already
 * greeted and stored *"Hi Lucas,\n\nHi, this is Brooke at American Harley-Davidson!…"* for
 * +17168610158 — a `mode: "human"` thread the draft-sanity backstop is barred from reading, so
 * nothing downstream would have caught it either.
 *
 * Removing the BARE line is the only safe repair: it is the one of the two that carries no
 * information, so this can never drop a fact, a name the body still uses, or a line of copy. Fail
 * direction is unchanged — any shape not recognised as *both* bare and re-greeted is left exactly
 * as it is today, and an email that reads slightly abrupt is a far smaller failure than one that
 * greets the customer twice in two lines.
 */
function dropDuplicateLeadingSalutation(body: string, greetingName: string): string {
  const lines = body.split("\n");
  const firstIdx = lines.findIndex(l => l.trim());
  if (firstIdx < 0) return body;
  if (!BARE_SALUTATION_LINE.test(lines[firstIdx].trim())) return body;
  const restIdx = lines.findIndex((l, i) => i > firstIdx && l.trim());
  if (restIdx < 0) return body;
  const rest = lines.slice(restIdx).join("\n");
  if (!EMAIL_BODY_OPENS_WITH_GREETING.test(rest) && !emailBodyOpensByAddressing(rest, greetingName)) {
    return body;
  }
  return rest;
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
  // Collapse an already-doubled opening BEFORE deciding whether to prepend, so the prepend test
  // below reads the greeting that actually carries the message.
  out = dropDuplicateLeadingSalutation(out, greetingName);
  if (
    !EMAIL_BODY_OPENS_WITH_GREETING.test(out) &&
    !emailBodyOpensByAddressing(out, greetingName)
  ) {
    out = `Hi ${greetingName},\n\n${out}`;
  }
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
