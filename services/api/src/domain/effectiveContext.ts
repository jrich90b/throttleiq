import {
  getActiveAgentContextText,
  getActiveVoiceContext,
  type Conversation,
  type Message
} from "./conversationStore.js";

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

export function buildEffectiveHistory(conv: Conversation | null | undefined, limit = 20): HistoryTurn[] {
  const roleAwareLabels = shouldUseRoleAwareHistoryLabels(conv);
  const baseHistory: HistoryTurn[] = (conv?.messages ?? [])
    .filter(
      (m: Message) =>
        !!m?.body &&
        !!m.direction &&
        !isVoiceLike(m.provider)
    )
    .slice(-Math.max(1, limit))
    .map((m: Message) => ({
      direction: m.direction,
      body: formatHistoryTurnBody(m, roleAwareLabels)
    }));

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
