import fs from "node:fs";
import path from "node:path";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  conversationsPath: string;
  outDir: string;
  sinceHours: number;
  minCount: number;
  maxSamplesPerPattern: number;
  responseWindowMin: number;
};

type MessageRow = {
  convId: string;
  leadRef: string | null;
  leadName: string | null;
  leadPhone: string | null;
  at: string;
  direction: string;
  provider: string;
  body: string;
  signature: string;
};

type FewShotCandidate = {
  id: string;
  kind:
    | "invariant_guard_miss"
    | "manual_edit_delta"
    | "manual_human_exemplar"
    | "positive_feedback"
    | "negative_feedback"
    | "slow_or_missing_response";
  severity: "high" | "medium" | "low";
  reason: string;
  convId: string;
  leadRef: string | null;
  leadName: string | null;
  leadPhone: string | null;
  inboundAt: string;
  inboundText: string;
  observedDraft: string;
  observedProvider: string;
  observedAt: string;
  finalIfEdited: string | null;
  followUpMode: string | null;
  followUpReason: string | null;
  dialogState: string | null;
  classificationBucket: string | null;
  classificationCta: string | null;
  invariantExpectedReason: string | null;
  feedbackRating?: "up" | "down" | null;
  feedbackReason?: string | null;
  feedbackNote?: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }

  const cwd = process.cwd();
  const dataDir = process.env.DATA_DIR || path.resolve(cwd, "data");
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    path.join(dataDir, "conversations.json");
  const outDir =
    args.get("--out-dir") || process.env.LANGUAGE_CORPUS_OUT_DIR || path.resolve(cwd, "reports", "language_corpus");
  const sinceHours = Number(args.get("--since-hours") || process.env.LANGUAGE_CORPUS_SINCE_HOURS || "0");
  const minCount = Number(args.get("--min-count") || process.env.LANGUAGE_CORPUS_MIN_COUNT || "3");
  const maxSamplesPerPattern = Number(
    args.get("--max-samples-per-pattern") || process.env.LANGUAGE_CORPUS_MAX_SAMPLES || "8"
  );
  const responseWindowMin = Number(
    args.get("--response-window-min") || process.env.LANGUAGE_CORPUS_RESPONSE_WINDOW_MIN || "15"
  );

  return {
    conversationsPath,
    outDir,
    sinceHours: Number.isFinite(sinceHours) && sinceHours > 0 ? sinceHours : 0,
    minCount: Number.isFinite(minCount) && minCount > 0 ? minCount : 3,
    maxSamplesPerPattern:
      Number.isFinite(maxSamplesPerPattern) && maxSamplesPerPattern > 0 ? maxSamplesPerPattern : 8,
    responseWindowMin: Number.isFinite(responseWindowMin) && responseWindowMin > 0 ? responseWindowMin : 15
  };
}

function loadConversations(filePath: string): AnyObj[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.conversations) ? raw.conversations : [];
}

function toIso(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function normText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function stripLeadName(leadName: string, text: string): string {
  const name = normText(leadName);
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "ig"), "{name}");
}

function toSignature(rawText: string, leadName = ""): string {
  let t = normText(rawText).toLowerCase();
  if (!t) return "";
  t = stripLeadName(leadName, t);
  t = t.replace(/https?:\/\/\S+/g, "{url}");
  t = t.replace(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/gi, "{day}");
  t = t.replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "{time}");
  t = t.replace(/\$\s?\d[\d,]*/g, "{money}");
  t = t.replace(/\b\d{4}\b/g, "{year}");
  t = t.replace(/\b\d+\b/g, "{num}");
  t = t.replace(/[^a-z0-9{}\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  return words.slice(0, 20).join(" ");
}

function textHasFinanceSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(apr|rate|rates|monthly|payment|payments|per month|down payment|how much down|put down|money down|cash down|term|months?|financing|finance|credit|application|specials?|deals?|incentives?)\b/.test(
    t
  );
}

function textHasAvailabilitySignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(in[-\s]?stock|available|availability|do you have|have any|any .* in[-\s]?stock|still there|still available)\b/.test(
    t
  );
}

function textHasSchedulingSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(t) ||
    /\b(schedule|book|appointment|time works|can i come in)\b/.test(t)
  );
}

function textHasCallbackSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(call me|give me a call|can you call|please call|phone call|ring me)\b/.test(t);
}

function inferIntentHint(inboundText: string): "pricing_payments" | "availability" | "scheduling" | "callback" | "general" {
  if (textHasFinanceSignal(inboundText)) return "pricing_payments";
  if (textHasAvailabilitySignal(inboundText)) return "availability";
  if (textHasSchedulingSignal(inboundText)) return "scheduling";
  if (textHasCallbackSignal(inboundText)) return "callback";
  return "general";
}

function isShortAck(text: string): boolean {
  const t = normText(text).toLowerCase();
  if (!t) return false;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return /^(ok|okay|k|kk|thanks|thank you|thx|ty|sounds good|sounds great|perfect|awesome|cool|great|will do|you bet)[.! ]*$/.test(
    t
  );
}

function findNextOutbound(messages: AnyObj[], fromIndex: number): AnyObj | null {
  for (let i = fromIndex + 1; i < messages.length; i += 1) {
    if (String(messages[i]?.direction) === "out") return messages[i];
  }
  return null;
}

function isTrainingOutboundProvider(provider: unknown): boolean {
  const p = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (!p) return false;
  return p === "draft_ai" || p === "human" || p === "twilio" || p === "sendgrid";
}

function outboundFeedbackDetails(msg: AnyObj): {
  rating: "up" | "down" | null;
  reason: string | null;
  note: string | null;
} {
  const feedbackRating = String(msg?.feedback?.rating ?? "")
    .trim()
    .toLowerCase();
  if (feedbackRating === "up" || feedbackRating === "down") {
    return {
      rating: feedbackRating,
      reason: normText(msg?.feedback?.reason) || null,
      note: normText(msg?.feedback?.note) || null
    };
  }

  const legacyFeedback = String(msg?.feedback ?? "")
    .trim()
    .toLowerCase();
  if (legacyFeedback === "up" || legacyFeedback === "positive") {
    return { rating: "up", reason: null, note: null };
  }
  if (legacyFeedback === "down" || legacyFeedback === "negative") {
    return { rating: "down", reason: null, note: null };
  }

  const thumb = String(msg?.thumb ?? msg?.thumbs ?? "")
    .trim()
    .toLowerCase();
  if (thumb === "up") return { rating: "up", reason: null, note: null };
  if (thumb === "down") return { rating: "down", reason: null, note: null };

  const reactions = Array.isArray(msg?.reactions) ? msg.reactions : [];
  for (const reaction of reactions) {
    const token = String(reaction?.value ?? reaction ?? "")
      .trim()
      .toLowerCase();
    if (!token) continue;
    if (token.includes("down")) return { rating: "down", reason: null, note: null };
    if (token.includes("up")) return { rating: "up", reason: null, note: null };
  }

  return { rating: null, reason: null, note: null };
}

function buildCandidateId(convId: string, inboundAt: string, kind: string): string {
  const at = inboundAt.replace(/[^0-9]/g, "").slice(0, 14);
  return `${kind}__${convId.replace(/[^a-zA-Z0-9+]/g, "")}_${at}`;
}

function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.conversationsPath)) {
    console.error(`conversations.json not found: ${parsed.conversationsPath}`);
    process.exit(1);
  }

  const rows = loadConversations(parsed.conversationsPath);
  const nowMs = Date.now();
  const sinceMs = parsed.sinceHours > 0 ? nowMs - parsed.sinceHours * 60 * 60 * 1000 : null;
  const responseWindowMs = parsed.responseWindowMin * 60 * 1000;

  const messageRows: MessageRow[] = [];
  const patterns = new Map<
    string,
    { count: number; sample: MessageRow[]; direction: string; provider: string }
  >();
  const fewShotCandidates: FewShotCandidate[] = [];

  let totalMessages = 0;
  let inboundMessages = 0;
  let outboundMessages = 0;
  let withNoOutboundInWindow = 0;

  for (const conv of rows) {
    const leadRef = conv?.lead?.leadRef ? String(conv.lead.leadRef) : null;
    const leadName =
      normText(conv?.lead?.name) ||
      normText(`${String(conv?.lead?.firstName ?? "")} ${String(conv?.lead?.lastName ?? "")}`) ||
      null;
    const leadPhone = normText(conv?.lead?.phone) || null;
    const convId = String(conv?.id ?? conv?.leadKey ?? "").trim();
    if (!convId) continue;
    const messages = Array.isArray(conv?.messages) ? [...conv.messages] : [];
    messages.sort((a, b) => Date.parse(String(a?.at ?? "")) - Date.parse(String(b?.at ?? "")));

    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      const atIso = toIso(msg?.at);
      if (!atIso) continue;
      const atMs = Date.parse(atIso);
      if (sinceMs != null && atMs < sinceMs) continue;
      const body = normText(msg?.body);
      if (!body) continue;
      const direction = String(msg?.direction ?? "");
      const provider = String(msg?.provider ?? "");
      totalMessages += 1;
      if (direction === "in") inboundMessages += 1;
      if (direction === "out") outboundMessages += 1;

      const signature = toSignature(body, leadName ?? "");
      const row: MessageRow = {
        convId,
        leadRef,
        leadName,
        leadPhone,
        at: atIso,
        direction,
        provider,
        body,
        signature
      };
      messageRows.push(row);

      const patternKey = `${direction}::${provider}::${signature}`;
      const existing = patterns.get(patternKey) ?? {
        count: 0,
        sample: [],
        direction,
        provider
      };
      existing.count += 1;
      if (existing.sample.length < parsed.maxSamplesPerPattern) existing.sample.push(row);
      patterns.set(patternKey, existing);

      if (direction !== "in") continue;
      const inboundProvider = String(msg?.provider ?? "")
        .trim()
        .toLowerCase();
      const nextOutboundRaw = findNextOutbound(messages, i);
      let nextOutbound = nextOutboundRaw;
      if (nextOutboundRaw && !isTrainingOutboundProvider(nextOutboundRaw?.provider)) {
        nextOutbound = null;
        for (let j = i + 1; j < messages.length; j += 1) {
          const out = messages[j];
          if (String(out?.direction ?? "").toLowerCase() !== "out") continue;
          if (!isTrainingOutboundProvider(out?.provider)) continue;
          nextOutbound = out;
          break;
        }
      }
      if (!nextOutbound) {
        if (inboundProvider !== "voice_transcript") {
          withNoOutboundInWindow += 1;
          fewShotCandidates.push({
            id: buildCandidateId(convId, atIso, "slow_or_missing_response"),
            kind: "slow_or_missing_response",
            severity: "medium",
            reason: "no outbound after inbound",
            convId,
            leadRef,
            leadName,
            leadPhone,
            inboundAt: atIso,
            inboundText: body,
            observedDraft: "",
            observedProvider: "",
            observedAt: "",
            finalIfEdited: null,
            followUpMode: String(conv?.followUp?.mode ?? "") || null,
            followUpReason: String(conv?.followUp?.reason ?? "") || null,
            dialogState: String(conv?.dialogState?.name ?? "") || null,
            classificationBucket: String(conv?.classification?.bucket ?? "") || null,
            classificationCta: String(conv?.classification?.cta ?? "") || null,
            invariantExpectedReason: null,
            feedbackRating: null,
            feedbackReason: null,
            feedbackNote: null
          });
        }
        continue;
      }

      const nextOutAtIso = toIso(nextOutbound?.at);
      const nextOutMs = Date.parse(nextOutAtIso);
      const timedOut =
        Number.isFinite(nextOutMs) && Number.isFinite(atMs) ? nextOutMs - atMs > responseWindowMs : false;
      if (timedOut) withNoOutboundInWindow += 1;

      const observedDraft = normText(nextOutbound?.originalDraftBody || nextOutbound?.body || "");
      const finalIfEdited =
        normText(nextOutbound?.originalDraftBody || "") &&
        normText(nextOutbound?.body || "") &&
        normText(nextOutbound?.originalDraftBody) !== normText(nextOutbound?.body)
          ? normText(nextOutbound?.body)
          : null;

      const invariant = applyDraftStateInvariants({
        inboundText: body,
        draftText: observedDraft,
        followUpMode: String(conv?.followUp?.mode ?? "") || null,
        followUpReason: String(conv?.followUp?.reason ?? "") || null,
        dialogState: String(conv?.dialogState?.name ?? "") || null,
        classificationBucket: String(conv?.classification?.bucket ?? "") || null,
        classificationCta: String(conv?.classification?.cta ?? "") || null,
        turnFinanceIntent: textHasFinanceSignal(body),
        turnAvailabilityIntent: textHasAvailabilitySignal(body),
        turnSchedulingIntent: textHasSchedulingSignal(body),
        financeContextIntent: textHasFinanceSignal(body),
        shortAckIntent: isShortAck(body)
      });

      if (!invariant.allow && observedDraft) {
        fewShotCandidates.push({
          id: buildCandidateId(convId, atIso, "invariant_guard_miss"),
          kind: "invariant_guard_miss",
          severity: "high",
          reason: invariant.reason || "invariant_guard",
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: atIso,
          inboundText: body,
          observedDraft,
          observedProvider: String(nextOutbound?.provider ?? ""),
          observedAt: nextOutAtIso,
          finalIfEdited,
          followUpMode: String(conv?.followUp?.mode ?? "") || null,
          followUpReason: String(conv?.followUp?.reason ?? "") || null,
          dialogState: String(conv?.dialogState?.name ?? "") || null,
          classificationBucket: String(conv?.classification?.bucket ?? "") || null,
          classificationCta: String(conv?.classification?.cta ?? "") || null,
          invariantExpectedReason: invariant.reason || null,
          feedbackRating: null,
          feedbackReason: null,
          feedbackNote: null
        });
      }

      if (finalIfEdited) {
        fewShotCandidates.push({
          id: buildCandidateId(convId, atIso, "manual_edit_delta"),
          kind: "manual_edit_delta",
          severity: "medium",
          reason: "outbound manually edited from generated draft",
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: atIso,
          inboundText: body,
          observedDraft,
          observedProvider: String(nextOutbound?.provider ?? ""),
          observedAt: nextOutAtIso,
          finalIfEdited,
          followUpMode: String(conv?.followUp?.mode ?? "") || null,
          followUpReason: String(conv?.followUp?.reason ?? "") || null,
          dialogState: String(conv?.dialogState?.name ?? "") || null,
          classificationBucket: String(conv?.classification?.bucket ?? "") || null,
          classificationCta: String(conv?.classification?.cta ?? "") || null,
          invariantExpectedReason: null,
          feedbackRating: null,
          feedbackReason: null,
          feedbackNote: null
        });
      }

      const feedback = outboundFeedbackDetails(nextOutbound);
      const nextOutProvider = String(nextOutbound?.provider ?? "").trim().toLowerCase();
      const manualHumanOutbound = nextOutProvider === "human";
      if (manualHumanOutbound && observedDraft && !isShortAck(observedDraft)) {
        fewShotCandidates.push({
          id: buildCandidateId(convId, atIso, "manual_human_exemplar"),
          kind: "manual_human_exemplar",
          severity: "low",
          reason: "manual human outbound after inbound",
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: atIso,
          inboundText: body,
          observedDraft,
          observedProvider: String(nextOutbound?.provider ?? ""),
          observedAt: nextOutAtIso,
          finalIfEdited: null,
          followUpMode: String(conv?.followUp?.mode ?? "") || null,
          followUpReason: String(conv?.followUp?.reason ?? "") || null,
          dialogState: String(conv?.dialogState?.name ?? "") || null,
          classificationBucket: String(conv?.classification?.bucket ?? "") || null,
          classificationCta: String(conv?.classification?.cta ?? "") || null,
          invariantExpectedReason: null,
          feedbackRating: null,
          feedbackReason: null,
          feedbackNote: null
        });
      }

      if (feedback.rating === "up") {
        fewShotCandidates.push({
          id: buildCandidateId(convId, atIso, "positive_feedback"),
          kind: "positive_feedback",
          severity: "medium",
          reason: "outbound received positive feedback/thumbs up",
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: atIso,
          inboundText: body,
          observedDraft,
          observedProvider: String(nextOutbound?.provider ?? ""),
          observedAt: nextOutAtIso,
          finalIfEdited,
          followUpMode: String(conv?.followUp?.mode ?? "") || null,
          followUpReason: String(conv?.followUp?.reason ?? "") || null,
          dialogState: String(conv?.dialogState?.name ?? "") || null,
          classificationBucket: String(conv?.classification?.bucket ?? "") || null,
          classificationCta: String(conv?.classification?.cta ?? "") || null,
          invariantExpectedReason: null,
          feedbackRating: "up",
          feedbackReason: feedback.reason,
          feedbackNote: feedback.note
        });
      }

      if (feedback.rating === "down") {
        fewShotCandidates.push({
          id: buildCandidateId(convId, atIso, "negative_feedback"),
          kind: "negative_feedback",
          severity: "high",
          reason: "outbound received negative feedback/thumbs down",
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: atIso,
          inboundText: body,
          observedDraft,
          observedProvider: String(nextOutbound?.provider ?? ""),
          observedAt: nextOutAtIso,
          finalIfEdited,
          followUpMode: String(conv?.followUp?.mode ?? "") || null,
          followUpReason: String(conv?.followUp?.reason ?? "") || null,
          dialogState: String(conv?.dialogState?.name ?? "") || null,
          classificationBucket: String(conv?.classification?.bucket ?? "") || null,
          classificationCta: String(conv?.classification?.cta ?? "") || null,
          invariantExpectedReason: null,
          feedbackRating: "down",
          feedbackReason: feedback.reason,
          feedbackNote: feedback.note
        });
      }
    }
  }

  const frequentPatterns = [...patterns.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .filter(x => x.count >= parsed.minCount && x.sample.length > 0)
    .sort((a, b) => b.count - a.count)
    .map(x => ({
      direction: x.direction,
      provider: x.provider,
      signature: x.sample[0]?.signature ?? "",
      count: x.count,
      samples: x.sample.map(s => ({
        at: s.at,
        convId: s.convId,
        leadName: s.leadName,
        body: s.body
      }))
    }));

  const dedupedCandidates = new Map<string, FewShotCandidate>();
  for (const c of fewShotCandidates) {
    if (!dedupedCandidates.has(c.id)) dedupedCandidates.set(c.id, c);
  }
  const candidateRows = [...dedupedCandidates.values()].sort(
    (a, b) => Date.parse(a.inboundAt) - Date.parse(b.inboundAt)
  );

  const candidateCountsByKind = candidateRows.reduce(
    (acc, row) => {
      acc[row.kind] = (acc[row.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    source: parsed.conversationsPath,
    sinceHours: parsed.sinceHours || null,
    totals: {
      messages: totalMessages,
      inboundMessages,
      outboundMessages,
      inboundWithoutTimelyOutbound: withNoOutboundInWindow
    },
    patternThreshold: parsed.minCount,
    frequentPatternCount: frequentPatterns.length,
    fewShotCandidateCount: candidateRows.length,
    fewShotCandidateCountsByKind: candidateCountsByKind
  };

  const fewShotSeedRows = candidateRows
    .filter(row => row.kind === "invariant_guard_miss" || row.kind === "manual_edit_delta")
    .map(row => {
      const intentHint = row.invariantExpectedReason?.includes("finance")
        ? "pricing_payments"
        : row.invariantExpectedReason?.includes("availability")
          ? "availability"
          : row.invariantExpectedReason?.includes("schedule")
            ? "scheduling"
            : row.kind === "manual_edit_delta"
              ? "tone_or_context"
              : "general";
      return {
        id: row.id,
        intentHint,
        severity: row.severity,
        reason: row.reason,
        inboundText: row.inboundText,
        modelDraft: row.observedDraft,
        preferredDraft: row.finalIfEdited ?? "",
        convId: row.convId,
        leadRef: row.leadRef,
        observedAt: row.observedAt
      };
    });

  const positiveFewShotSeedRows = candidateRows
    .filter(row => row.kind === "positive_feedback")
    .map(row => ({
      id: row.id,
      category: "what_to_say",
      reason: row.reason,
      inboundText: row.inboundText,
      preferredDraft: row.finalIfEdited ?? row.observedDraft,
      observedDraft: row.observedDraft,
      feedbackReason: row.feedbackReason ?? null,
      feedbackNote: row.feedbackNote ?? null,
      convId: row.convId,
      leadRef: row.leadRef,
      observedAt: row.observedAt
    }));

  const negativeFewShotSeedRows = candidateRows
    .filter(row => row.kind === "negative_feedback")
    .map(row => ({
      id: row.id,
      category: "what_not_to_say",
      reason: row.reason,
      inboundText: row.inboundText,
      rejectedDraft: row.observedDraft,
      feedbackReason: row.feedbackReason ?? null,
      feedbackNote: row.feedbackNote ?? null,
      convId: row.convId,
      leadRef: row.leadRef,
      observedAt: row.observedAt
    }));

  const manualOutboundFewShotSeedRows = candidateRows
    .filter(row => row.kind === "manual_human_exemplar")
    .map(row => ({
      id: row.id,
      intentHint: inferIntentHint(row.inboundText),
      reason: row.reason,
      inboundText: row.inboundText,
      preferredDraft: row.observedDraft,
      convId: row.convId,
      leadRef: row.leadRef,
      observedAt: row.observedAt
    }));

  fs.mkdirSync(parsed.outDir, { recursive: true });
  const summaryPath = path.join(parsed.outDir, "language_corpus_summary.json");
  const corpusPath = path.join(parsed.outDir, "all_message_language_rows.json");
  const patternsPath = path.join(parsed.outDir, "frequent_language_patterns.json");
  const candidatesPath = path.join(parsed.outDir, "few_shot_candidates.json");
  const seedPath = path.join(parsed.outDir, "few_shot_seed_candidates.json");
  const positiveSeedPath = path.join(parsed.outDir, "few_shot_seed_positive_feedback.json");
  const negativeSeedPath = path.join(parsed.outDir, "few_shot_seed_negative_feedback.json");
  const manualOutboundSeedPath = path.join(parsed.outDir, "few_shot_seed_manual_outbound.json");

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(corpusPath, JSON.stringify({ count: messageRows.length, rows: messageRows }, null, 2));
  fs.writeFileSync(patternsPath, JSON.stringify({ count: frequentPatterns.length, rows: frequentPatterns }, null, 2));
  fs.writeFileSync(candidatesPath, JSON.stringify({ count: candidateRows.length, rows: candidateRows }, null, 2));
  fs.writeFileSync(seedPath, JSON.stringify({ count: fewShotSeedRows.length, rows: fewShotSeedRows }, null, 2));
  fs.writeFileSync(
    positiveSeedPath,
    JSON.stringify({ count: positiveFewShotSeedRows.length, rows: positiveFewShotSeedRows }, null, 2)
  );
  fs.writeFileSync(
    negativeSeedPath,
    JSON.stringify({ count: negativeFewShotSeedRows.length, rows: negativeFewShotSeedRows }, null, 2)
  );
  fs.writeFileSync(
    manualOutboundSeedPath,
    JSON.stringify({ count: manualOutboundFewShotSeedRows.length, rows: manualOutboundFewShotSeedRows }, null, 2)
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: parsed.outDir,
        outputs: {
          summaryPath,
          corpusPath,
          patternsPath,
          candidatesPath,
          seedPath,
          positiveSeedPath,
          negativeSeedPath,
          manualOutboundSeedPath
        },
        summary
      },
      null,
      2
    )
  );
}

run();
