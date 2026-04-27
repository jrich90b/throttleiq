import fs from "node:fs";
import path from "node:path";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type AnyObj = Record<string, any>;

type ChangedRow = {
  convId: string;
  leadRef?: string | null;
  name?: string | null;
  phone?: string | null;
  at: string;
  provider?: string | null;
  generated: string;
  final: string;
};

type ConversationLike = {
  id: string;
  leadKey?: string;
  messages?: Array<{
    id?: string;
    direction?: "in" | "out";
    at?: string;
    body?: string;
    provider?: string;
  }>;
};

type EditLabel =
  | "short_ack_miss"
  | "finance_inventory_miss"
  | "finance_schedule_miss"
  | "department_handoff_miss"
  | "inventory_fact_miss"
  | "fact_correction"
  | "tone_or_personalization"
  | "manual_takeover_rewrite"
  | "other";

type Severity = "high" | "medium" | "low";

type FixtureCase = {
  id: string;
  expectedAllow: boolean;
  expectedReason?: string;
  input: {
    inboundText: string;
    draftText: string;
    followUpMode?: string | null;
    followUpReason?: string | null;
    dialogState?: string | null;
    classificationBucket?: string | null;
    classificationCta?: string | null;
  };
  meta: {
    convId: string;
    leadRef?: string | null;
    label: EditLabel;
    severity: Severity;
    at: string;
  };
};

type ParsedArgs = {
  changesPath: string;
  conversationsPath: string;
  outDir: string;
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

  const changesPath =
    args.get("--changes") ??
    process.env.CHANGED_MESSAGES_PATH ??
    path.resolve(process.cwd(), "reports", "changed_messages_all.json");
  const conversationsPath =
    args.get("--conversations") ??
    process.env.CONVERSATIONS_PATH ??
    path.resolve(process.cwd(), "data", "conversations.json");
  const outDir =
    args.get("--out-dir") ??
    process.env.EDIT_FEEDBACK_OUT_DIR ??
    path.resolve(process.cwd(), "scripts", "generated");

  return { changesPath, conversationsPath, outDir };
}

function readJson(filePath: string): AnyObj {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeRows(raw: AnyObj): ChangedRow[] {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : [];
  return rows
    .map((r: AnyObj) => ({
      convId: String(r?.convId ?? "").trim(),
      leadRef: r?.leadRef ?? null,
      name: r?.name ?? null,
      phone: r?.phone ?? null,
      at: String(r?.at ?? "").trim(),
      provider: r?.provider ?? null,
      generated: String(r?.generated ?? ""),
      final: String(r?.final ?? "")
    }))
    .filter(r => r.convId && r.at && r.generated && r.final);
}

function loadConversations(filePath: string): Map<string, ConversationLike> {
  const raw = readJson(filePath);
  const rows: ConversationLike[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.conversations)
      ? raw.conversations
      : [];
  const byId = new Map<string, ConversationLike>();
  for (const c of rows) {
    if (!c?.id) continue;
    byId.set(String(c.id), c);
  }
  return byId;
}

function isEmojiOnlyText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

function isShortAckText(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (isEmojiOnlyText(t)) return true;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/.test(
    t
  );
}

function looksInventoryPromptDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(which model are you (?:interested|leaning)|exact year\/color\/finish)\b/.test(t) ||
    /\b(keep an eye out|watch for|text you as soon as one comes in|when one comes in)\b/.test(t) ||
    /\b(walkaround video|more photos?|a couple photos?)\b/.test(t) ||
    /\b(stop by to take a look|come check it out)\b/.test(t) ||
    /\b(i'?m not seeing .* in stock|in stock right now)\b/.test(t)
  );
}

function looksSchedulingPromptDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(what day and time works|what day works|what time works|what time were you thinking)\b/.test(t) ||
    /\b(are you looking to set a time|want me to lock that in|want me to book|do any of these times work)\b/.test(
      t
    ) ||
    /\b(appointment|schedule|book)\b/.test(t)
  );
}

function hasFinanceSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(apr|rate|rates|monthly|payment|payments|per month|down payment|how much down|put down|money down|cash down|term|months?|financing|finance|credit score|credit app|credit application|application|deals?|specials?|incentives?|rebates?)\b/.test(
    t
  );
}

function hasSchedulingSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(t) ||
    /\b(schedule|book|appointment|time works)\b/.test(t)
  );
}

function isAdfInboundBlob(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\bweb lead\s*\(adf\)\b/.test(t) ||
    (/^\s*source:\s/m.test(t) &&
      /^\s*ref:\s/m.test(t) &&
      /^\s*name:\s/m.test(t) &&
      /^\s*inquiry:\s/m.test(t))
  );
}

function hasInventoryAskSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(in stock|available|availability|do you have|got any|what do you have|any .* in stock)\b/.test(t) ||
    /\b(anything in (?:the )?\$?\d[\d,]*(?:\s*-\s*\$?\d[\d,]*)?\s*range)\b/.test(t) ||
    /\b(looking for|watch for|keep an eye out)\b/.test(t)
  );
}

function inferDepartment(text: string): "service" | "parts" | "apparel" | null {
  const t = String(text ?? "").toLowerCase();
  if (
    /\b(service|inspection|oil change|maintenance|repair|service department|warranty|headlight|tail ?light|turn signal|led|light bulb|bulb|install|replace|swap|upgrade)\b/.test(
      t
    )
  ) {
    return "service";
  }
  if (
    /\b(parts? department|parts? counter|parts? desk|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?)\b/.test(
      t
    )
  ) {
    return "parts";
  }
  if (/\b(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|helmet|gloves?|boots?|riding gear|gear)\b/.test(t)) {
    return "apparel";
  }
  return null;
}

function inferPrevInboundContext(
  conv: ConversationLike | undefined,
  atIso: string
): { text: string; provider: string } {
  if (!conv?.messages?.length) return { text: "", provider: "" };
  const targetMs = Date.parse(atIso);
  const messages = [...conv.messages].sort(
    (a, b) => Date.parse(String(a?.at ?? "")) - Date.parse(String(b?.at ?? ""))
  );
  let latestInboundText = "";
  let latestInboundProvider = "";
  for (const m of messages) {
    const atMs = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(atMs)) continue;
    if (Number.isFinite(targetMs) && atMs > targetMs) break;
    if (m?.direction === "in" && m?.body) {
      latestInboundText = String(m.body);
      latestInboundProvider = String(m?.provider ?? "");
    }
  }
  return { text: latestInboundText, provider: latestInboundProvider };
}

function classifyEdit(
  row: ChangedRow,
  inboundText: string
): { label: EditLabel; severity: Severity; rationale: string } {
  const generated = String(row.generated ?? "");
  const final = String(row.final ?? "");
  const g = generated.toLowerCase();
  const f = final.toLowerCase();
  const inbound = String(inboundText ?? "");
  const inb = inbound.toLowerCase();

  const inventoryDraft = looksInventoryPromptDraft(generated);
  const schedulingDraft = looksSchedulingPromptDraft(generated);
  const inboundShortAck = isShortAckText(inbound);
  const inboundFinance = hasFinanceSignal(inbound);
  const inboundInventoryAsk = hasInventoryAskSignal(inbound);
  const inboundIsAdf = isAdfInboundBlob(inbound);
  const finalDepartment = inferDepartment(final);

  if (String(row.provider ?? "").toLowerCase() === "human") {
    return { label: "manual_takeover_rewrite", severity: "low", rationale: "provider_human" };
  }
  if (inboundShortAck && inventoryDraft && !inboundIsAdf) {
    return { label: "short_ack_miss", severity: "high", rationale: "short_ack_with_inventory_prompt" };
  }
  if (inboundFinance && inventoryDraft && !inboundIsAdf && !inboundInventoryAsk) {
    return {
      label: "finance_inventory_miss",
      severity: "high",
      rationale: "finance_turn_without_inventory_ask_with_inventory_prompt"
    };
  }
  if (inboundFinance && schedulingDraft && !hasSchedulingSignal(inbound) && !inboundIsAdf) {
    return {
      label: "finance_schedule_miss",
      severity: "high",
      rationale: "finance_turn_without_schedule_ask_with_schedule_prompt"
    };
  }
  if (finalDepartment && inventoryDraft) {
    return {
      label: "department_handoff_miss",
      severity: "high",
      rationale: `department_${finalDepartment}_final_with_inventory_prompt`
    };
  }
  if (
    /\b(i'?m not seeing|not seeing .* in stock|keep an eye out|watch for)\b/.test(g) &&
    /\b(in stock|stock|vin|msrp|asking|currently)\b/.test(f)
  ) {
    return { label: "inventory_fact_miss", severity: "high", rationale: "availability_or_stock_corrected" };
  }
  if (
    /\b(actually|not offered|we are a dealership|independent|located in|sorry|correction)\b/.test(f) ||
    /\bvin\b/.test(f) ||
    /\bmsrp\b/.test(f)
  ) {
    return { label: "fact_correction", severity: "medium", rationale: "facts_or_policy_corrected" };
  }
  const delta = Math.abs(final.length - generated.length);
  if (delta < 80 && !hasFinanceSignal(inb) && !inventoryDraft && !schedulingDraft) {
    return { label: "tone_or_personalization", severity: "low", rationale: "minor_tone_or_context_tweak" };
  }
  return { label: "other", severity: "low", rationale: "unclassified_delta" };
}

function maybeBuildFixture(
  row: ChangedRow,
  inboundText: string,
  label: EditLabel,
  severity: Severity
): FixtureCase | null {
  const generated = String(row.generated ?? "").trim();
  if (!generated || !inboundText) return null;

  const baseMeta = {
    convId: row.convId,
    leadRef: row.leadRef ?? null,
    label,
    severity,
    at: row.at
  };
  const caseId = `${label}_${row.convId.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${String(
    row.at
  ).replace(/[^0-9]/g, "").slice(0, 14)}`;

  if (label === "short_ack_miss") {
    return {
      id: caseId,
      expectedAllow: false,
      expectedReason: "short_ack_no_action_guard",
      input: {
        inboundText,
        draftText: generated
      },
      meta: baseMeta
    };
  }

  if (label === "finance_inventory_miss") {
    return {
      id: caseId,
      expectedAllow: false,
      expectedReason: "finance_priority_inventory_prompt_guard",
      input: {
        inboundText,
        draftText: generated,
        followUpMode: "active",
        followUpReason: "pricing",
        dialogState: "pricing_answered",
        classificationBucket: "inventory_interest",
        classificationCta: "ask_payment"
      },
      meta: baseMeta
    };
  }

  if (label === "finance_schedule_miss") {
    return {
      id: caseId,
      expectedAllow: false,
      expectedReason: "finance_priority_schedule_prompt_guard",
      input: {
        inboundText,
        draftText: generated,
        followUpMode: "active",
        followUpReason: "pricing",
        dialogState: "pricing_answered",
        classificationBucket: "inventory_interest",
        classificationCta: "ask_payment"
      },
      meta: baseMeta
    };
  }

  if (label === "department_handoff_miss") {
    const dept = inferDepartment(row.final) ?? "service";
    return {
      id: caseId,
      expectedAllow: false,
      expectedReason: "manual_handoff_inventory_prompt_guard",
      input: {
        inboundText,
        draftText: generated,
        followUpMode: "manual_handoff",
        followUpReason: `${dept}_request`,
        dialogState: `${dept}_handoff`,
        classificationBucket: dept,
        classificationCta: `${dept}_request`
      },
      meta: baseMeta
    };
  }

  return null;
}

function main() {
  const { changesPath, conversationsPath, outDir } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(changesPath)) {
    console.error(`Missing changes file: ${changesPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(conversationsPath)) {
    console.error(`Missing conversations file: ${conversationsPath}`);
    process.exit(1);
  }

  const changesRaw = readJson(changesPath);
  const rows = normalizeRows(changesRaw);
  const conversationsById = loadConversations(conversationsPath);
  const labeled: Array<
    ChangedRow & {
      inboundText: string;
      label: EditLabel;
      severity: Severity;
      rationale: string;
    }
  > = [];

  const fixtures: FixtureCase[] = [];
  let skippedVoiceInboundRows = 0;
  for (const row of rows) {
    const conv = conversationsById.get(row.convId);
    const inbound = inferPrevInboundContext(conv, row.at);
    const inboundText = inbound.text;
    const inboundProvider = String(inbound.provider ?? "")
      .trim()
      .toLowerCase();
    if (inboundProvider === "voice_transcript") {
      skippedVoiceInboundRows += 1;
      continue;
    }
    const classified = classifyEdit(row, inboundText);
    labeled.push({
      ...row,
      inboundText,
      label: classified.label,
      severity: classified.severity,
      rationale: classified.rationale
    });
    const fixture = maybeBuildFixture(row, inboundText, classified.label, classified.severity);
    if (fixture) fixtures.push(fixture);
  }

  const byLabel = new Map<EditLabel, number>();
  const bySeverity = new Map<Severity, number>();
  for (const row of labeled) {
    byLabel.set(row.label, (byLabel.get(row.label) ?? 0) + 1);
    bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + 1);
  }

  const fixtureResults = fixtures.map(f => {
    const actual = applyDraftStateInvariants(f.input);
    const reasonOk = !f.expectedReason || actual.reason === f.expectedReason;
    const pass = actual.allow === f.expectedAllow && reasonOk;
    return {
      id: f.id,
      pass,
      expectedAllow: f.expectedAllow,
      actualAllow: actual.allow,
      expectedReason: f.expectedReason ?? null,
      actualReason: actual.reason ?? null,
      label: f.meta.label,
      severity: f.meta.severity,
      convId: f.meta.convId,
      at: f.meta.at
    };
  });

  const failingFixtures = fixtureResults.filter(r => !r.pass);
  const passingFixtures = fixtureResults.filter(r => r.pass);

  fs.mkdirSync(outDir, { recursive: true });
  const labeledPath = path.join(outDir, "edit_feedback_labeled.json");
  const fixturesPath = path.join(outDir, "edit_replay_fixtures.json");
  const resultsPath = path.join(outDir, "edit_replay_fixture_results.json");
  const summaryPath = path.join(outDir, "edit_feedback_summary.json");

  fs.writeFileSync(
    labeledPath,
    JSON.stringify(
      {
        source: {
          changesPath,
          conversationsPath
        },
        count: labeled.length,
        rows: labeled
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    fixturesPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: fixtures.length,
        fixtures
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: fixtureResults.length,
        passing: passingFixtures.length,
        failing: failingFixtures.length,
        rows: fixtureResults
      },
      null,
      2
    )
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    sinceHours:
      Number.isFinite(Number(changesRaw?.sinceHours)) && Number(changesRaw?.sinceHours) > 0
        ? Number(changesRaw?.sinceHours)
        : null,
    windowStart:
      typeof changesRaw?.windowStart === "string" && changesRaw.windowStart.trim()
        ? changesRaw.windowStart
        : null,
    source: {
      changesPath,
      conversationsPath,
      sinceHours:
        Number.isFinite(Number(changesRaw?.sinceHours)) && Number(changesRaw?.sinceHours) > 0
          ? Number(changesRaw?.sinceHours)
          : null,
      windowStart:
        typeof changesRaw?.windowStart === "string" && changesRaw.windowStart.trim()
          ? changesRaw.windowStart
          : null
    },
    totalChangedRows: labeled.length,
    labelCounts: Array.from(byLabel.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count })),
    severityCounts: Array.from(bySeverity.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([severity, count]) => ({ severity, count })),
    fixtureCandidates: fixtures.length,
    fixturePassNow: passingFixtures.length,
    fixtureFailNow: failingFixtures.length,
    skippedVoiceInboundRows,
    outputs: {
      labeledPath,
      fixturesPath,
      resultsPath
    }
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
