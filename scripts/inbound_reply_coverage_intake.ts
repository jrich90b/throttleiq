import fs from "node:fs";
import path from "node:path";
import {
  evaluateTurnToneQuality,
  isAdfInboundText,
  normalizeText,
  type ToneIssueCode
} from "./lib/toneQuality.ts";

type Provider = "twilio" | "sendgrid_adf";
type CoverageStatus =
  | "safe"
  | "review"
  | "expected_no_response"
  | "unexpected_no_response"
  | "error"
  | "skipped";
type IntentOwnership =
  | "parser_owned"
  | "deterministic_safety_guard"
  | "deterministic_containment"
  | "legacy_or_gap";
type FixClassification = "global" | "dealer_specific" | "mixed";

type Message = {
  id?: string;
  direction?: "in" | "out";
  at?: string;
  body?: string;
  provider?: string;
  from?: string;
  to?: string;
  originalDraftBody?: string;
};

type Conversation = {
  id?: string;
  leadKey?: string;
  mode?: string;
  conversationMode?: string;
  messages?: Message[];
  lead?: any;
  latestLead?: any;
  followUp?: any;
  dialogState?: any;
  classification?: any;
  appointment?: any;
};

type ParsedArgs = {
  conversationsPath: string;
  outDir: string;
  sinceHours: number;
  responseWindowMin: number;
  shadowSinceDays: number;
  shadowLimit: number;
  envFile?: string;
  maxMarkdownRows: number;
};

type CoverageRow = {
  id: string;
  convId: string;
  leadRef: string | null;
  leadName: string | null;
  leadPhone: string | null;
  inboundAt: string;
  inboundProvider: string;
  inboundMessageId: string | null;
  inboundIndex: number;
  inboundText: string;
  outboundAt: string | null;
  outboundProvider: string | null;
  outboundMessageId: string | null;
  outboundText: string | null;
  generatedDraftBeforeEdit: string | null;
  responseLatencySec: number | null;
  status: CoverageStatus;
  risk: "none" | "low" | "medium" | "high";
  skipReason: string | null;
  coverageReason: string;
  issueCodes: string[];
  issueDetails: Array<{ code: string; detail: string }>;
  intent: string | null;
  mode: string | null;
  conversationMode: string | null;
  followUpMode: string | null;
  followUpReason: string | null;
  dialogState: string | null;
  classificationBucket: string | null;
  classificationCta: string | null;
  expectedOwnership: IntentOwnership | null;
  fixClassification: FixClassification | null;
  containmentOnly: boolean;
  replayRequired: boolean;
  replayReason: string | null;
  shadowReplay?: {
    provider: Provider;
    caseNumber: number | null;
    sinceDays: number;
    limit: number;
    command: string | null;
  };
};

type ReplayQueueRow = Pick<
  CoverageRow,
  | "id"
  | "convId"
  | "leadRef"
  | "leadName"
  | "leadPhone"
  | "inboundAt"
  | "inboundProvider"
  | "inboundText"
  | "outboundText"
  | "status"
  | "risk"
  | "issueCodes"
  | "expectedOwnership"
  | "fixClassification"
  | "containmentOnly"
  | "replayReason"
  | "shadowReplay"
>;

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
    process.env.CONVERSATIONS_PATH ||
    path.join(dataDir, "conversations.json");
  const outDir =
    args.get("--out-dir") ||
    process.env.INBOUND_REPLY_COVERAGE_OUT_DIR ||
    path.resolve(cwd, "reports", "inbound_reply_coverage");
  const sinceHoursRaw = Number(args.get("--since-hours") || process.env.INBOUND_REPLY_COVERAGE_SINCE_HOURS || "24");
  const responseWindowMinRaw = Number(
    args.get("--response-window-min") || process.env.INBOUND_REPLY_COVERAGE_RESPONSE_WINDOW_MIN || "30"
  );
  const shadowSinceDaysRaw = Number(args.get("--shadow-since-days") || "");
  const sinceHours = Number.isFinite(sinceHoursRaw) && sinceHoursRaw >= 0 ? sinceHoursRaw : 24;
  const shadowSinceDays =
    Number.isFinite(shadowSinceDaysRaw) && shadowSinceDaysRaw > 0
      ? Math.ceil(shadowSinceDaysRaw)
      : Math.max(1, Math.ceil(Math.max(1, sinceHours) / 24));
  const shadowLimitRaw = Number(args.get("--shadow-limit") || process.env.INBOUND_REPLY_COVERAGE_SHADOW_LIMIT || "500");
  const maxMarkdownRowsRaw = Number(args.get("--max-markdown-rows") || "80");

  return {
    conversationsPath: path.resolve(conversationsPath),
    outDir: path.resolve(outDir),
    sinceHours,
    responseWindowMin:
      Number.isFinite(responseWindowMinRaw) && responseWindowMinRaw > 0 ? responseWindowMinRaw : 30,
    shadowSinceDays,
    shadowLimit: Number.isFinite(shadowLimitRaw) && shadowLimitRaw > 0 ? Math.floor(shadowLimitRaw) : 500,
    envFile: args.get("--env-file") ? path.resolve(args.get("--env-file")!) : undefined,
    maxMarkdownRows: Number.isFinite(maxMarkdownRowsRaw) && maxMarkdownRowsRaw > 0 ? Math.floor(maxMarkdownRowsRaw) : 80
  };
}

function readStore(filePath: string): Conversation[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return raw as Conversation[];
  if (Array.isArray(raw?.conversations)) return raw.conversations as Conversation[];
  return [];
}

function toMs(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function leadName(conv: Conversation): string | null {
  const lead = conv.latestLead ?? conv.lead ?? {};
  const full = normalizeText(lead.name);
  if (full) return full;
  const joined = normalizeText([lead.firstName, lead.lastName].filter(Boolean).join(" "));
  return joined || null;
}

function leadRef(conv: Conversation): string | null {
  return normalizeText(conv.lead?.leadRef ?? conv.latestLead?.leadRef) || null;
}

function leadPhone(conv: Conversation): string | null {
  return normalizeText(conv.lead?.phone ?? conv.latestLead?.phone ?? conv.leadKey) || null;
}

function getDialogState(conv: Conversation): string | null {
  const raw = typeof conv.dialogState === "string" ? conv.dialogState : conv.dialogState?.name;
  return normalizeText(raw) || null;
}

function normalizeProvider(raw: unknown): Provider | null {
  const provider = normalizeText(raw).toLowerCase();
  if (provider === "twilio") return "twilio";
  if (provider === "sendgrid_adf") return "sendgrid_adf";
  return null;
}

function isEmojiOnlyText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

function isReactionToOutboundText(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return /to\s+["“][\s\S]+["”]/i.test(t) && /^[\p{Emoji}\p{Extended_Pictographic}\s\W]*to\s+["“]/u.test(t);
}

function isShortAckNoAction(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  if (isEmojiOnlyText(t)) return true;
  if (t.length > 80) return false;
  if (/[?]/.test(t)) return false;
  return /^(ok|okay|k|kk|got it|sounds good|sounds great|thanks|thank you|thx|ty|perfect|awesome|cool|great|will do|yep|yup|sure|no problem)[.!?\s]*$/i.test(
    t
  );
}

function hasActionableCue(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  return /\b(available|in stock|price|pricing|cost|payment|payments|apr|finance|financing|monthly|down payment|come in|stop by|schedule|appointment|cancel|reschedule|call me|callback|text me|email me|tomorrow|today|next week|all set|no need|watch|trade|title|paperwork|key|seat|drop(?:ping)? off|pick(?:ing)? up|when)\b/.test(
    t
  );
}

function isCloseoutUpdateNoReplyNeeded(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  if (/\?/.test(t)) return false;
  if (
    /\b(no need|already called|already spoke|spoke with them|handled it|all set|sorted|taken care of|sorry it took so long)\b/.test(
      t
    )
  ) {
    return !/\b(appointment|schedule|cancel|reschedule|price|payment|finance|trade|watch|call me)\b/.test(t);
  }
  return false;
}

function skipReasonFor(conv: Conversation, inbound: Message, inboundText: string): string | null {
  const provider = normalizeText(inbound.provider).toLowerCase();
  const leadEmail = normalizeText(conv.lead?.email ?? conv.latestLead?.email).toLowerCase();
  if (provider === "voice_transcript") return "provider_voice_transcript";
  if (leadEmail.endsWith("@example.com") || leadEmail.includes("example.com")) return "test_lead_example_email";
  if (isReactionToOutboundText(inboundText)) return "reaction_to_outbound";
  return null;
}

function expectedNoResponseReason(conv: Conversation, inboundText: string): string | null {
  const t = normalizeText(inboundText).toLowerCase();
  if (!t) return null;
  if (isShortAckNoAction(t)) return "short_ack_no_action";
  if (isCloseoutUpdateNoReplyNeeded(t)) return "closeout_update_no_reply";
  const followUpMode = normalizeText(conv.followUp?.mode).toLowerCase();
  const convMode = normalizeText(conv.mode).toLowerCase();
  if ((followUpMode === "manual_handoff" || followUpMode === "paused_indefinite") && !hasActionableCue(t)) {
    return "manual_handoff_non_actionable";
  }
  if (convMode === "human" && !hasActionableCue(t)) return "human_mode_non_actionable";
  return null;
}

function isConcreteStatusOrOutcomeUpdate(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return (
    /\b(all set|no need|cancel|decline|not interested|sold|bought|purchased|picked up|dropped off|dropping off|stopping by|stopped in|spoke with|talked with|ready before|ready by|good with that|after work|key|keyring|backseat|seat|appointment|finance|approved|declined|trade|watch|found one|got one|symptom|fixed|resolved|running fine|service is done)\b/.test(
      t
    ) ||
    /\b(i'?ll|i will|i am|i'm|we'?ll|we will)\b[\s\S]{0,80}\b(stop|come|drop|pick|get|call|text|send|bring)\b/.test(t)
  );
}

function findNearestOutbound(messages: Message[], inboundIndex: number, maxOutMs: number): Message | null {
  for (let i = inboundIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i]!;
    const atMs = toMs(msg.at);
    if (Number.isFinite(atMs) && atMs > maxOutMs) break;
    if (msg.direction !== "out") continue;
    const outText = normalizeText(msg.body);
    if (!outText) continue;
    return msg;
  }
  return null;
}

function ownershipForIssue(issue: ToneIssueCode | "missing_response" | "none"): IntentOwnership | null {
  switch (issue) {
    case "intent_mismatch":
    case "question_not_answered_first":
    case "appointment_status_answer_mismatch":
    case "adf_direct_ask_unanswered":
    case "post_sale_logistics_schedule_mismatch":
      return "parser_owned";
    case "known_fact_conflict":
    case "overcommitted_availability_watch":
    case "redundant_current_bike_stock_count":
      return "deterministic_safety_guard";
    case "generic_model_reask":
    case "generic_day_reask":
    case "pushy_cta_on_ack":
    case "template_bloat":
    case "role_inconsistency":
      return "deterministic_containment";
    case "missing_response":
      return "legacy_or_gap";
    case "none":
      return null;
    default:
      return "legacy_or_gap";
  }
}

function fixClassificationFor(row: {
  inboundText: string;
  issueCodes: string[];
  inboundProvider: string;
  classificationBucket?: string | null;
}): FixClassification | null {
  if (!row.issueCodes.length) return null;
  const inbound = normalizeText(row.inboundText).toLowerCase();
  if (row.issueCodes.includes("missing_response")) return "mixed";
  if (row.issueCodes.includes("adf_direct_ask_unanswered")) return "mixed";
  if (row.issueCodes.includes("appointment_status_answer_mismatch")) return "mixed";
  if (row.issueCodes.includes("post_sale_logistics_schedule_mismatch")) return "mixed";
  if (row.issueCodes.includes("known_fact_conflict")) return "global";
  if (/\b(hours?|pricing policy|dealer|department|service|parts|apparel|staff|manager|availability)\b/.test(inbound)) {
    return "mixed";
  }
  return "global";
}

function combineOwnership(issueCodes: string[]): {
  ownership: IntentOwnership | null;
  containmentOnly: boolean;
} {
  if (!issueCodes.length) return { ownership: null, containmentOnly: false };
  const ownerships = issueCodes
    .map(code => ownershipForIssue(code as ToneIssueCode | "missing_response"))
    .filter((value): value is IntentOwnership => !!value);
  if (ownerships.includes("parser_owned")) return { ownership: "parser_owned", containmentOnly: false };
  if (ownerships.includes("deterministic_safety_guard")) {
    return { ownership: "deterministic_safety_guard", containmentOnly: false };
  }
  if (ownerships.includes("deterministic_containment")) {
    return { ownership: "deterministic_containment", containmentOnly: true };
  }
  return { ownership: ownerships[0] ?? "legacy_or_gap", containmentOnly: ownerships[0] === "legacy_or_gap" };
}

function riskFor(status: CoverageStatus, issueCodes: string[], inboundText: string): CoverageRow["risk"] {
  if (status === "unexpected_no_response" || status === "error") return "high";
  if (
    issueCodes.some(code =>
      [
        "missing_response",
        "adf_direct_ask_unanswered",
        "appointment_status_answer_mismatch",
        "post_sale_logistics_schedule_mismatch",
        "known_fact_conflict"
      ].includes(code)
    )
  ) {
    return "high";
  }
  if (issueCodes.includes("intent_mismatch") || issueCodes.includes("question_not_answered_first")) return "medium";
  if (isConcreteStatusOrOutcomeUpdate(inboundText) && status === "review") return "medium";
  if (status === "review") return "low";
  return "none";
}

function isValidShadowInboundBody(body: string): boolean {
  const text = normalizeText(body);
  if (text.length < 3) return false;
  if (/^(yes|no|ok|okay|thanks?|thank you|👍|👎)$/i.test(text)) return false;
  return true;
}

function normalizePhone(raw?: string | null): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return text;
}

function shadowCandidateKey(provider: Provider, convId: string, message: Message, messageIndex: number): string {
  return `${provider}::${convId}::${message.id ?? messageIndex}::${messageIndex}`;
}

function buildShadowCaseMap(
  conversations: Conversation[],
  args: ParsedArgs
): Map<string, { provider: Provider; caseNumber: number }> {
  const cutoffMs = Date.now() - args.shadowSinceDays * 24 * 60 * 60 * 1000;
  const byProvider = new Map<Provider, Array<{ key: string; atMs: number }>>();
  for (const conv of conversations) {
    const convId = normalizeText(conv.id ?? conv.leadKey);
    if (!convId) continue;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.direction !== "in") continue;
      const provider = normalizeProvider(message.provider);
      if (!provider) continue;
      const body = normalizeText(message.body);
      if (!isValidShadowInboundBody(body)) continue;
      const atMs = toMs(message.at);
      if (Number.isFinite(atMs) && atMs < cutoffMs) continue;
      if (provider === "twilio") {
        const from = normalizePhone(message.from) || normalizePhone(conv.lead?.phone) || normalizePhone(conv.leadKey);
        if (!from) continue;
      }
      const list = byProvider.get(provider) ?? [];
      list.push({ key: shadowCandidateKey(provider, convId, message, index), atMs });
      byProvider.set(provider, list);
    }
  }

  const out = new Map<string, { provider: Provider; caseNumber: number }>();
  for (const [provider, rows] of byProvider.entries()) {
    rows
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, args.shadowLimit)
      .forEach((row, index) => out.set(row.key, { provider, caseNumber: index + 1 }));
  }
  return out;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildReplayCommand(args: ParsedArgs, provider: Provider, caseNumber: number, rowId: string): string {
  const dataDir = path.dirname(args.conversationsPath);
  const replayOutDir = path.join(args.outDir, "shadow_replay", rowId.replace(/[^a-z0-9_.:-]+/gi, "_"));
  const parts = [
    "npm run inbound_shadow:replay --",
    "--data-dir",
    shellQuote(dataDir),
    args.envFile ? `--env-file ${shellQuote(args.envFile)}` : "--env-file <api.env>",
    "--provider",
    provider === "sendgrid_adf" ? "adf" : provider,
    "--since-days",
    String(args.shadowSinceDays),
    "--limit",
    String(args.shadowLimit),
    "--case-numbers",
    String(caseNumber),
    "--mode-matrix",
    "--out-dir",
    shellQuote(replayOutDir)
  ];
  return parts.join(" ");
}

function truncate(text: string | null | undefined, max = 170): string {
  const clean = normalizeText(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function mdEscape(text: string | null | undefined): string {
  return truncate(text).replace(/\|/g, "\\|");
}

function statusCounts(rows: CoverageRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
}

function riskCounts(rows: CoverageRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.risk] = (acc[row.risk] ?? 0) + 1;
    return acc;
  }, {});
}

function issueCounts(rows: CoverageRow[]): Array<{ issue: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const issue of row.issueCodes) counts.set(issue, (counts.get(issue) ?? 0) + 1);
  }
  return [...counts.entries()].map(([issue, count]) => ({ issue, count })).sort((a, b) => b.count - a.count);
}

function buildMarkdown(report: any, maxRows: number): string {
  const lines: string[] = [];
  lines.push("# Inbound Reply Coverage Intake");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source: \`${report.source.conversationsPath}\``);
  lines.push(`Since hours: ${report.source.sinceHours}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total inbound rows: ${report.summary.total}`);
  lines.push(`- Status counts: ${JSON.stringify(report.summary.statusCounts)}`);
  lines.push(`- Risk counts: ${JSON.stringify(report.summary.riskCounts)}`);
  lines.push(`- Replay queue: ${report.summary.replayQueueCount}`);
  lines.push(`- Skipped rows: ${report.summary.statusCounts.skipped ?? 0}`);
  lines.push("");
  if (report.summary.issueCounts.length) {
    lines.push("Issue counts:");
    for (const row of report.summary.issueCounts.slice(0, 12)) {
      lines.push(`- ${row.issue}: ${row.count}`);
    }
    lines.push("");
  }

  lines.push("## Replay Queue");
  lines.push("");
  if (!report.replayQueue.length) {
    lines.push("No rows currently require three-mode replay.");
  } else {
    lines.push("| Risk | Status | Provider | Customer | Inbound | Draft / Send | Ownership | Replay |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const row of report.replayQueue) {
      const replay = row.shadowReplay?.caseNumber
        ? `${row.shadowReplay.provider} #${row.shadowReplay.caseNumber}`
        : "not mapped";
      lines.push(
        `| ${row.risk} | ${row.status} | ${row.inboundProvider} | ${mdEscape(row.leadName ?? row.leadPhone ?? row.convId)} | ${mdEscape(row.inboundText)} | ${mdEscape(row.outboundText)} | ${row.expectedOwnership ?? "-"} | ${replay} |`
      );
    }
  }
  lines.push("");

  lines.push("## Coverage Rows");
  lines.push("");
  lines.push("| Status | Risk | Provider | Customer | Inbound | Draft / Send | Reason | Issues |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of report.rows.slice(0, maxRows)) {
    lines.push(
      `| ${row.status} | ${row.risk} | ${row.inboundProvider} | ${mdEscape(row.leadName ?? row.leadPhone ?? row.convId)} | ${mdEscape(row.inboundText)} | ${mdEscape(row.outboundText)} | ${mdEscape(row.coverageReason)} | ${mdEscape(row.issueCodes.join(","))} |`
    );
  }
  if (report.rows.length > maxRows) {
    lines.push(`| ... | ... | ... | ... | ${report.rows.length - maxRows} additional rows omitted from markdown | ... | ... | ... |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.conversationsPath)) {
    console.error(`Conversations file not found: ${args.conversationsPath}`);
    process.exit(1);
  }

  const conversations = readStore(args.conversationsPath);
  const windowStartMs =
    args.sinceHours > 0 ? Date.now() - args.sinceHours * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  const shadowMap = buildShadowCaseMap(conversations, args);
  const rows: CoverageRow[] = [];

  for (const conv of conversations) {
    const convId = normalizeText(conv.id ?? conv.leadKey);
    if (!convId) continue;
    const messages = Array.isArray(conv.messages) ? [...conv.messages] : [];
    messages.sort((a, b) => toMs(a.at) - toMs(b.at));
    for (let index = 0; index < messages.length; index += 1) {
      const inbound = messages[index]!;
      if (inbound.direction !== "in") continue;
      const inboundAtMs = toMs(inbound.at);
      if (!Number.isFinite(inboundAtMs) || inboundAtMs < windowStartMs) continue;
      const inboundText = normalizeText(inbound.body);
      if (!inboundText) continue;

      const base = {
        id: `${convId}_${inbound.id ?? index}`.replace(/[^a-zA-Z0-9_.:-]+/g, "_"),
        convId,
        leadRef: leadRef(conv),
        leadName: leadName(conv),
        leadPhone: leadPhone(conv),
        inboundAt: String(inbound.at ?? ""),
        inboundProvider: normalizeText(inbound.provider) || "unknown",
        inboundMessageId: inbound.id ?? null,
        inboundIndex: index,
        inboundText,
        mode: normalizeText(conv.mode) || null,
        conversationMode: normalizeText(conv.conversationMode) || null,
        followUpMode: normalizeText(conv.followUp?.mode) || null,
        followUpReason: normalizeText(conv.followUp?.reason) || null,
        dialogState: getDialogState(conv),
        classificationBucket: normalizeText(conv.classification?.bucket) || null,
        classificationCta: normalizeText(conv.classification?.cta) || null
      };

      const skipReason = skipReasonFor(conv, inbound, inboundText);
      if (skipReason) {
        rows.push({
          ...base,
          outboundAt: null,
          outboundProvider: null,
          outboundMessageId: null,
          outboundText: null,
          generatedDraftBeforeEdit: null,
          responseLatencySec: null,
          status: "skipped",
          risk: "none",
          skipReason,
          coverageReason: skipReason,
          issueCodes: [],
          issueDetails: [],
          intent: null,
          expectedOwnership: null,
          fixClassification: null,
          containmentOnly: false,
          replayRequired: false,
          replayReason: null
        });
        continue;
      }

      const maxOutMs = inboundAtMs + args.responseWindowMin * 60 * 1000;
      const outbound = findNearestOutbound(messages, index, maxOutMs);
      const expectedNoResponse = expectedNoResponseReason(conv, inboundText);
      if (!outbound) {
        const status: CoverageStatus = expectedNoResponse ? "expected_no_response" : "unexpected_no_response";
        const issueCodes = expectedNoResponse ? [] : ["missing_response"];
        const ownership = combineOwnership(issueCodes);
        const risk = riskFor(status, issueCodes, inboundText);
        const replayRequired =
          status === "unexpected_no_response" ||
          (normalizeText(conv.mode).toLowerCase() === "human" && isConcreteStatusOrOutcomeUpdate(inboundText));
        const provider = normalizeProvider(inbound.provider);
        let shadowReplay: CoverageRow["shadowReplay"] | undefined;
        if (replayRequired && provider) {
          const shadowKey = shadowCandidateKey(provider, convId, inbound, index);
          const mapped = shadowMap.get(shadowKey);
          shadowReplay = {
            provider,
            caseNumber: mapped?.caseNumber ?? null,
            sinceDays: args.shadowSinceDays,
            limit: args.shadowLimit,
            command: mapped?.caseNumber ? buildReplayCommand(args, provider, mapped.caseNumber, base.id) : null
          };
        }
        rows.push({
          ...base,
          outboundAt: null,
          outboundProvider: null,
          outboundMessageId: null,
          outboundText: null,
          generatedDraftBeforeEdit: null,
          responseLatencySec: null,
          status,
          risk,
          skipReason: null,
          coverageReason: expectedNoResponse ?? "missing_response",
          issueCodes,
          issueDetails: issueCodes.map(code => ({ code, detail: "no outbound reply in configured response window" })),
          intent: "general",
          expectedOwnership: ownership.ownership,
          fixClassification: fixClassificationFor({ ...base, issueCodes, inboundText }),
          containmentOnly: ownership.containmentOnly,
          replayRequired,
          replayReason: replayRequired ? "missing_or_human_mode_concrete_update" : null,
          shadowReplay
        });
        continue;
      }

      const outboundText = normalizeText(outbound.body);
      const generatedDraftBeforeEdit =
        normalizeText(outbound.originalDraftBody) && normalizeText(outbound.originalDraftBody) !== outboundText
          ? normalizeText(outbound.originalDraftBody)
          : null;
      const tone = evaluateTurnToneQuality({ inboundText, outboundText });
      const issueCodes = tone.issues.map(issue => issue.code);
      const status: CoverageStatus = tone.pass ? "safe" : "review";
      const ownership = combineOwnership(issueCodes);
      const risk = riskFor(status, issueCodes, inboundText);
      const responseLatencySec = Math.max(0, Math.round((toMs(outbound.at) - inboundAtMs) / 1000));
      const replayRequired =
        status === "review" &&
        (risk === "high" ||
          risk === "medium" ||
          isAdfInboundText(inboundText) ||
          normalizeProvider(inbound.provider) != null ||
          generatedDraftBeforeEdit != null);

      const provider = normalizeProvider(inbound.provider);
      let shadowReplay: CoverageRow["shadowReplay"] | undefined;
      if (replayRequired && provider) {
        const shadowKey = shadowCandidateKey(provider, convId, inbound, index);
        const mapped = shadowMap.get(shadowKey);
        shadowReplay = {
          provider,
          caseNumber: mapped?.caseNumber ?? null,
          sinceDays: args.shadowSinceDays,
          limit: args.shadowLimit,
          command: mapped?.caseNumber ? buildReplayCommand(args, provider, mapped.caseNumber, base.id) : null
        };
      }

      rows.push({
        ...base,
        outboundAt: String(outbound.at ?? ""),
        outboundProvider: normalizeText(outbound.provider) || null,
        outboundMessageId: outbound.id ?? null,
        outboundText,
        generatedDraftBeforeEdit,
        responseLatencySec,
        status,
        risk,
        skipReason: null,
        coverageReason: tone.pass ? "tone_quality_pass" : "tone_quality_issues",
        issueCodes,
        issueDetails: tone.issues.map(issue => ({ code: issue.code, detail: issue.detail })),
        intent: tone.intent,
        expectedOwnership: ownership.ownership,
        fixClassification: fixClassificationFor({ ...base, issueCodes, inboundText }),
        containmentOnly: ownership.containmentOnly,
        replayRequired,
        replayReason: replayRequired ? "review_or_high_risk_generated_response" : null,
        shadowReplay
      });
    }
  }

  rows.sort((a, b) => toMs(b.inboundAt) - toMs(a.inboundAt));
  const replayQueue: ReplayQueueRow[] = rows
    .filter(row => row.replayRequired)
    .sort((a, b) => {
      const riskRank = { high: 0, medium: 1, low: 2, none: 3 };
      return riskRank[a.risk] - riskRank[b.risk] || toMs(b.inboundAt) - toMs(a.inboundAt);
    })
    .map(row => ({
      id: row.id,
      convId: row.convId,
      leadRef: row.leadRef,
      leadName: row.leadName,
      leadPhone: row.leadPhone,
      inboundAt: row.inboundAt,
      inboundProvider: row.inboundProvider,
      inboundText: row.inboundText,
      outboundText: row.outboundText,
      status: row.status,
      risk: row.risk,
      issueCodes: row.issueCodes,
      expectedOwnership: row.expectedOwnership,
      fixClassification: row.fixClassification,
      containmentOnly: row.containmentOnly,
      replayReason: row.replayReason,
      shadowReplay: row.shadowReplay
    }));

  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    source: {
      conversationsPath: args.conversationsPath,
      dataDir: path.dirname(args.conversationsPath),
      sinceHours: args.sinceHours,
      windowStart: args.sinceHours > 0 ? new Date(windowStartMs).toISOString() : null,
      responseWindowMin: args.responseWindowMin,
      shadowSinceDays: args.shadowSinceDays,
      shadowLimit: args.shadowLimit,
      envFileProvided: !!args.envFile
    },
    summary: {
      total: rows.length,
      statusCounts: statusCounts(rows),
      riskCounts: riskCounts(rows),
      issueCounts: issueCounts(rows),
      replayQueueCount: replayQueue.length,
      highRiskReplayCount: replayQueue.filter(row => row.risk === "high").length,
      mediumRiskReplayCount: replayQueue.filter(row => row.risk === "medium").length
    },
    replayQueue,
    rows
  };

  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, "coverage_intake.json");
  const mdPath = path.join(args.outDir, "coverage_intake.md");
  const replayQueuePath = path.join(args.outDir, "replay_queue.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(replayQueuePath, JSON.stringify({ generatedAt, count: replayQueue.length, rows: replayQueue }, null, 2));
  fs.writeFileSync(mdPath, buildMarkdown(report, args.maxMarkdownRows));

  console.log(
    JSON.stringify(
      {
        ok: true,
        total: rows.length,
        statusCounts: report.summary.statusCounts,
        riskCounts: report.summary.riskCounts,
        replayQueueCount: replayQueue.length,
        outputs: { jsonPath, mdPath, replayQueuePath }
      },
      null,
      2
    )
  );
}

main();
