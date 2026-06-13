import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  conversationsPath: string;
  outDir: string;
  sinceHours: number;
};

type VoiceRow = {
  convId: string;
  leadRef: string | null;
  leadName: string | null;
  leadPhone: string | null;
  transcriptAt: string;
  transcriptText: string;
  transcriptProviderMessageId: string | null;
  summaryAt: string | null;
  summaryText: string | null;
  nextOutboundAt: string | null;
  nextOutboundProvider: string | null;
  nextOutboundText: string | null;
  followUpMode: string | null;
  dialogState: string | null;
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
    args.get("--out-dir") ||
    process.env.VOICE_FEEDBACK_OUT_DIR ||
    process.env.LANGUAGE_CORPUS_OUT_DIR ||
    path.resolve(cwd, "reports", "language_corpus");
  const sinceHoursRaw = Number(args.get("--since-hours") || process.env.VOICE_FEEDBACK_SINCE_HOURS || "24");

  return {
    conversationsPath,
    outDir,
    sinceHours: Number.isFinite(sinceHoursRaw) && sinceHoursRaw >= 0 ? sinceHoursRaw : 24
  };
}

function loadConversations(filePath: string): AnyObj[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.conversations) ? raw.conversations : [];
}

function normText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function toMs(input: unknown): number {
  const iso = toIso(input);
  if (!iso) return NaN;
  return Date.parse(iso);
}

function leadName(lead: AnyObj | undefined): string | null {
  const full = normText(lead?.name);
  if (full) return full;
  const joined = normText(`${String(lead?.firstName ?? "")} ${String(lead?.lastName ?? "")}`);
  return joined || null;
}

function isCustomerFacingOutboundProvider(provider: unknown): boolean {
  const p = String(provider ?? "")
    .trim()
    .toLowerCase();
  return p === "draft_ai" || p === "human" || p === "twilio" || p === "sendgrid";
}

export type VoiceMsg = {
  provider?: unknown;
  at?: unknown;
  body?: unknown;
  providerMessageId?: unknown;
};

/**
 * Find the voice_summary that belongs to the transcript at `transcriptIndex`
 * within a time-sorted message array.
 *
 * Primary path (the real prod path): when the transcript has a
 * providerMessageId (call SID), match the summary that shares that exact SID,
 * regardless of time order. The runtime writes the summary BEFORE the
 * transcript (index.ts ~60665 appends "voice_summary", then pushes
 * "voice_transcript" later in the same handler), so the summary sits earlier in
 * the sorted array; the old forward-only search missed it and withVoiceSummary
 * collapsed to 0 even though the summaries existed. This scans the whole
 * conversation but stays strictly id-keyed, so multi-call conversations never
 * cross-link call A's transcript to call B's summary.
 *
 * Fallback (defensive; no SID on the transcript): keep the legacy forward-only
 * behavior, but only link a summary that is itself id-less — never steal an
 * earlier, identified call's summary.
 */
export function findSummaryForTranscript(
  messages: VoiceMsg[],
  transcriptIndex: number
): { summaryAt: string; summaryText: string } | null {
  const transcript = messages[transcriptIndex];
  const transcriptProviderMessageId = normText(transcript?.providerMessageId) || null;

  const usableSummary = (cand: VoiceMsg): { at: string; text: string } | null => {
    const candProvider = String(cand?.provider ?? "").trim().toLowerCase();
    if (candProvider !== "voice_summary") return null;
    const at = toIso(cand?.at);
    if (!at) return null;
    const text = normText(cand?.body);
    if (!text) return null;
    return { at, text };
  };

  if (transcriptProviderMessageId) {
    // Id-keyed, order-independent: require an exact SID match anywhere in the conv.
    for (let j = 0; j < messages.length; j += 1) {
      if (j === transcriptIndex) continue;
      const usable = usableSummary(messages[j]);
      if (!usable) continue;
      const candMsgId = normText(messages[j]?.providerMessageId);
      if (candMsgId && candMsgId === transcriptProviderMessageId) {
        return { summaryAt: usable.at, summaryText: usable.text };
      }
    }
    return null;
  }

  // No SID on the transcript: forward-only fallback, id-less summaries only.
  for (let j = transcriptIndex + 1; j < messages.length; j += 1) {
    const usable = usableSummary(messages[j]);
    if (!usable) continue;
    if (normText(messages[j]?.providerMessageId)) continue;
    return { summaryAt: usable.at, summaryText: usable.text };
  }
  return null;
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

  const outRows: VoiceRow[] = [];
  for (const conv of rows) {
    const convId = String(conv?.id ?? conv?.leadKey ?? "").trim();
    if (!convId) continue;
    const lead = (conv?.lead ?? {}) as AnyObj;
    const leadRef = lead?.leadRef ? String(lead.leadRef) : null;
    const leadPhone = normText(lead?.phone) || null;
    const resolvedLeadName = leadName(lead);
    const followUpMode = normText(conv?.followUp?.mode) || null;
    const dialogState = normText(conv?.dialogState?.name) || null;
    const messages = Array.isArray(conv?.messages) ? [...conv.messages] : [];
    messages.sort((a, b) => toMs(a?.at) - toMs(b?.at));

    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      const provider = String(msg?.provider ?? "").trim().toLowerCase();
      if (provider !== "voice_transcript") continue;
      const transcriptAt = toIso(msg?.at);
      if (!transcriptAt) continue;
      const transcriptAtMs = Date.parse(transcriptAt);
      if (sinceMs != null && transcriptAtMs < sinceMs) continue;
      const transcriptText = normText(msg?.body);
      if (!transcriptText) continue;
      const transcriptProviderMessageId = normText(msg?.providerMessageId) || null;

      const summaryMatch = findSummaryForTranscript(messages, i);
      const summaryAt: string | null = summaryMatch?.summaryAt ?? null;
      const summaryText: string | null = summaryMatch?.summaryText ?? null;

      let nextOutboundAt: string | null = null;
      let nextOutboundProvider: string | null = null;
      let nextOutboundText: string | null = null;
      for (let j = i + 1; j < messages.length; j += 1) {
        const cand = messages[j];
        if (String(cand?.direction ?? "").trim().toLowerCase() !== "out") continue;
        const candProvider = String(cand?.provider ?? "").trim().toLowerCase();
        if (!isCustomerFacingOutboundProvider(candProvider)) continue;
        const candAt = toIso(cand?.at);
        const candText = normText(cand?.body);
        if (!candAt || !candText) continue;
        nextOutboundAt = candAt;
        nextOutboundProvider = candProvider;
        nextOutboundText = candText;
        break;
      }

      outRows.push({
        convId,
        leadRef,
        leadName: resolvedLeadName,
        leadPhone,
        transcriptAt,
        transcriptText,
        transcriptProviderMessageId,
        summaryAt,
        summaryText,
        nextOutboundAt,
        nextOutboundProvider,
        nextOutboundText,
        followUpMode,
        dialogState
      });
    }
  }

  outRows.sort((a, b) => Date.parse(a.transcriptAt) - Date.parse(b.transcriptAt));
  const providerMap = new Map<string, number>();
  for (const row of outRows) {
    const key = String(row.nextOutboundProvider ?? "none").trim() || "none";
    providerMap.set(key, (providerMap.get(key) ?? 0) + 1);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: parsed.conversationsPath,
    sinceHours: parsed.sinceHours || null,
    totalVoiceTranscripts: outRows.length,
    withVoiceSummary: outRows.filter(r => !!r.summaryText).length,
    withCustomerFacingOutbound: outRows.filter(r => !!r.nextOutboundText).length,
    outboundProviderStats: [...providerMap.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count)
  };

  fs.mkdirSync(parsed.outDir, { recursive: true });
  const rowsPath = path.join(parsed.outDir, "voice_feedback_rows.json");
  const summaryPath = path.join(parsed.outDir, "voice_feedback_summary.json");
  fs.writeFileSync(rowsPath, JSON.stringify({ count: outRows.length, rows: outRows }, null, 2));
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: parsed.outDir,
        outputs: { rowsPath, summaryPath },
        summary
      },
      null,
      2
    )
  );
}

run();
