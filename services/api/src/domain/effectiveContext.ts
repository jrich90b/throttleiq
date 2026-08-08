import {
  getActiveAgentContextText,
  getActiveVoiceContext,
  type Conversation,
  type Message
} from "./conversationStore.js";
import { keepCustomerReceivedOutbounds } from "./agentVoice.js";

type HistoryTurn = { direction: "in" | "out"; body: string };

type ContextSourceKind = "agent_context" | "walkin_comment" | "voice_summary";

type ContextSource = {
  kind: ContextSourceKind;
  text: string;
  updatedAtMs: number;
  priority: number;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "we",
  "with",
  "you",
  "your"
]);

function toMs(iso?: string | null): number {
  if (!iso) return 0;
  const v = new Date(iso).getTime();
  return Number.isFinite(v) ? v : 0;
}

function normalizeText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTokenSet(text: string): Set<string> {
  const normalized = normalizeText(text);
  const out = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (!token || token.length < 3 || STOP_WORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function hasNegation(text: string): boolean {
  return /\b(no|not|never|dont|don't|cant|can't|wont|won't|without|nope)\b/i.test(text);
}

function purchasePolarity(text: string): "positive" | "negative" | null {
  const t = normalizeText(text);
  const positive =
    /\b(ready|moving forward|finalize|left .*deposit|coming in|booked|approved|pull trigger)\b/i.test(t);
  const negative =
    /\b(not ready|not interested|thinking it over|hold off|cant afford|sell my bike first|keep (it|bike))\b/i.test(t);
  if (positive && !negative) return "positive";
  if (negative && !positive) return "negative";
  return null;
}

function relation(a: string, b: string): "duplicate" | "conflict" | "distinct" {
  const an = normalizeText(a);
  const bn = normalizeText(b);
  if (!an || !bn) return "distinct";
  if (an === bn) return "duplicate";
  if (an.includes(bn) || bn.includes(an)) {
    if (Math.min(an.length, bn.length) >= 20) return "duplicate";
  }
  const aTokens = toTokenSet(a);
  const bTokens = toTokenSet(b);
  const sim = jaccard(aTokens, bTokens);
  if (sim >= 0.72) return "duplicate";

  const negConflict = hasNegation(a) !== hasNegation(b) && sim >= 0.45;
  if (negConflict) return "conflict";

  const pA = purchasePolarity(a);
  const pB = purchasePolarity(b);
  if (pA && pB && pA !== pB && sim >= 0.12) return "conflict";

  return "distinct";
}

function preferForDuplicate(a: ContextSource, b: ContextSource): ContextSource {
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs > b.updatedAtMs ? a : b;
  return a.text.length >= b.text.length ? a : b;
}

function preferForConflict(a: ContextSource, b: ContextSource): ContextSource {
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs > b.updatedAtMs ? a : b;
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
  return a.text.length >= b.text.length ? a : b;
}

function formatContextLine(source: ContextSource): string {
  if (source.kind === "agent_context") {
    return `INTERNAL STAFF CONTEXT (never send verbatim to customer): ${source.text}`;
  }
  if (source.kind === "walkin_comment") {
    return `WALK-IN CONTEXT (in-store note, never send verbatim to customer): ${source.text}`;
  }
  return `RECENT CALL SUMMARY (never send verbatim to customer): ${source.text}`;
}

function isVoiceLike(provider?: Message["provider"]): boolean {
  return provider === "voice_call" || provider === "voice_transcript" || provider === "voice_summary";
}

function shouldUseRoleAwareHistoryLabels(conv: Conversation | null | undefined): boolean {
  const followUpMode = String(conv?.followUp?.mode ?? "").trim().toLowerCase();
  const convMode = String(conv?.mode ?? "").trim().toLowerCase();
  return followUpMode === "manual_handoff" || convMode === "human";
}

/**
 * HOW OLD a history turn is, in the words a person would use.
 *
 * MEASURED 2026-08-08, and it is the root cause Joe found by reading one draft. History turns are
 * `{direction, body}` — they carry NO timestamp, so nothing downstream can tell May from this
 * morning. Every message in a thread looks equally current to the composer.
 *
 * Curtis Coshun (+17164005844): on 2026-05-14 we asked "coming in tomorrow or Saturday?" and he
 * answered "first thing Saturday for sure, if not!". He BOUGHT the bike on 05-18. On 07-17 he
 * wrote "absolutely loving it, took short day today at work to go out for a ride" — and the draft
 * came back "confirm Saturday morning and I'll make sure the bike's ready to look over", reading
 * his own three-month-old words back to him about a bike he already owns.
 *
 * On the live store this is not a corner case: of 774 conversations with two or more messages,
 * **441 (57%) have a last-20 window spanning more than 30 days**, 102 span more than 90, and the
 * median window is 40 days wide. 63 of the 71 sold leads carry pre-purchase talk in that window.
 *
 * Stamping is deliberately chosen over TRUNCATION. Cutting old turns would also throw away which
 * bike, the budget, and what we have already told them — the fix would trade phantom specifics for
 * a forgetful agent. Marking the age costs nothing and leaves every fact in place.
 *
 * Only turns meaningfully older than the newest one are stamped, so an ordinary same-day thread is
 * byte-identical to today.
 */
export function formatHistoryTurnAge(turnMs: number, newestMs: number): string | null {
  if (!Number.isFinite(turnMs) || !Number.isFinite(newestMs)) return null;
  const days = Math.floor((newestMs - turnMs) / 86_400_000);
  if (!Number.isFinite(days) || days < HISTORY_AGE_STAMP_MIN_DAYS) return null;
  if (days < 14) return `${days} days ago`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return `${weeks} weeks ago`;
  }
  const months = Math.round(days / 30);
  return `${months} months ago`;
}

/** Below this, a thread is "current" and gets no stamps at all. */
export const HISTORY_AGE_STAMP_MIN_DAYS = 7;

function formatHistoryTurnBody(msg: Message, roleAwareLabels: boolean): string {
  const body = String(msg.body ?? "").trim();
  if (!body) return body;
  if (!roleAwareLabels || msg.direction !== "out") return body;
  const provider = String(msg.provider ?? "").trim().toLowerCase();
  if (provider === "draft_ai") {
    return `AI OUTBOUND: ${body}`;
  }
  if (provider === "twilio" || provider === "sendgrid" || provider === "human") {
    const originalDraft = String((msg as any).originalDraftBody ?? "").trim();
    if (originalDraft && normalizeText(originalDraft) !== normalizeText(body)) {
      return `STAFF OUTBOUND (edited): ${body}`;
    }
    return `STAFF OUTBOUND: ${body}`;
  }
  return body;
}

function alreadyCoveredByHistory(text: string, history: HistoryTurn[]): boolean {
  const t = normalizeText(text);
  if (!t) return true;
  for (const turn of history) {
    const r = relation(text, turn.body);
    if (r === "duplicate") return true;
  }
  return false;
}

function reduceContextSources(sources: ContextSource[]): ContextSource[] {
  const reduced: ContextSource[] = [];
  for (const source of sources) {
    let merged = false;
    for (let i = 0; i < reduced.length; i += 1) {
      const existing = reduced[i];
      const rel = relation(source.text, existing.text);
      if (rel === "distinct") continue;
      reduced[i] = rel === "duplicate"
        ? preferForDuplicate(existing, source)
        : preferForConflict(existing, source);
      merged = true;
      break;
    }
    if (!merged) reduced.push(source);
  }
  return reduced;
}

export function buildEffectiveHistory(
  conv: Conversation | null | undefined,
  limit = 20,
  opts?: { stampAges?: boolean }
): HistoryTurn[] {
  const roleAwareLabels = shouldUseRoleAwareHistoryLabels(conv);
  const kept = (conv?.messages ?? []).filter(
    (m: Message) => !!m?.body && !!m.direction && !isVoiceLike(m.provider)
  );
  const windowed = kept.slice(-Math.max(1, limit));
  // OPT-IN, and only the draft path asks for it. The comprehension parsers read this same history
  // and are tuned against its exact shape, so stamping them all would be a change to 87 parsers
  // dressed up as a context fix.
  const newestMs = opts?.stampAges
    ? Math.max(...windowed.map((m: Message) => toMs((m as any).at)), 0)
    : 0;
  const baseHistory: HistoryTurn[] = windowed.map((m: Message) => {
    const body = formatHistoryTurnBody(m, roleAwareLabels);
    if (!opts?.stampAges) return { direction: m.direction, body };
    const age = formatHistoryTurnAge(toMs((m as any).at), newestMs);
    return { direction: m.direction, body: age ? `[${age}] ${body}` : body };
  });

  if (!conv) return baseHistory;

  const sources: ContextSource[] = [];
  const agentText = getActiveAgentContextText(conv).replace(/\s+/g, " ").trim();
  if (agentText) {
    sources.push({
      kind: "agent_context",
      text: agentText.slice(0, 800),
      updatedAtMs: toMs(conv.agentContext?.updatedAt ?? conv.updatedAt),
      priority: 300
    });
  }

  const walkInText = String(conv.lead?.walkInComment ?? "").replace(/\s+/g, " ").trim();
  if (walkInText) {
    sources.push({
      kind: "walkin_comment",
      text: walkInText.slice(0, 800),
      updatedAtMs: toMs(conv.lead?.walkInCommentCapturedAt ?? conv.updatedAt ?? conv.createdAt),
      priority: 200
    });
  }

  const voiceCtx = getActiveVoiceContext(conv);
  const voiceSummary = String(voiceCtx?.summary ?? "").replace(/\s+/g, " ").trim();
  if (voiceSummary) {
    sources.push({
      kind: "voice_summary",
      text: voiceSummary.slice(0, 800),
      updatedAtMs: toMs(voiceCtx?.updatedAt ?? conv.updatedAt),
      priority: 150
    });
  }

  if (!sources.length) return baseHistory;

  const deduped = reduceContextSources(sources)
    .filter(source => !alreadyCoveredByHistory(source.text, baseHistory))
    .sort((a, b) => {
      if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
      return b.priority - a.priority;
    })
    .slice(0, 2);

  if (!deduped.length) return baseHistory;

  const contextLines: HistoryTurn[] = deduped.map(source => ({
    direction: "out",
    body: formatContextLine(source)
  }));

  return [...contextLines, ...baseHistory];
}

/**
 * `buildEffectiveHistory` restricted to the turns the customer ACTUALLY EXCHANGED with us:
 * every inbound, plus only the outbounds a real provider delivered (`keepCustomerReceivedOutbounds`).
 *
 * WHY THIS EXISTS — the draft-quality judge (`judgeDraftQualityWithLLM`) reviews a candidate draft
 * against "the recent thread". Fed the plain history, an unsent `draft_ai` row reads to it as a
 * message we already sent, so it grades the candidate for CONSISTENCY WITH A MESSAGE THAT NEVER
 * WENT OUT. Lead `+17168614216` (held 2026-07-31T18:36:56Z) is the case: the thread's only
 * outbound was a stale `draft_ai` carrying a DIFFERENT sender name that was never delivered, so
 * the judge held the next draft for "misidentifies sender — previous outgoing was <that name>" —
 * a complaint no re-draft can satisfy, which is exactly why self-heal could not clear it. The
 * customer had received nothing at all, across two ADFs and four days.
 *
 * Same fail direction as the rest of the gate (draftQualityGate.ts): a thinner thread can only
 * make the judge LESS certain, and an unsure verdict resolves to `pass` — a good draft reaches
 * the human reviewer. The reverse (holding on a phantom) silences the lead entirely.
 *
 * Deliberately NOT applied to `buildEffectiveHistory` itself: the ~40 comprehension parsers and
 * the draft generator that share it answer a different question (what has been said/proposed on
 * this thread), and quietly narrowing their context is a separate, much larger change.
 */
export function buildCustomerReceivedHistory(
  conv: Conversation | null | undefined,
  limit = 20
): HistoryTurn[] {
  if (!conv) return buildEffectiveHistory(conv, limit);
  return buildEffectiveHistory(
    { ...conv, messages: keepCustomerReceivedOutbounds(conv.messages ?? []) } as Conversation,
    limit
  );
}
