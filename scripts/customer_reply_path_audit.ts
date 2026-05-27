import fs from "node:fs";
import path from "node:path";

type FindingKind =
  | "primary"
  | "safety"
  | "legacy_live_twilio_direct"
  | "legacy_regenerate_direct"
  | "legacy_adf_initial_direct"
  | "legacy_email_reply_direct"
  | "legacy_other_direct"
  | "dead_or_non_customer";

type Finding = {
  file: string;
  line: number;
  kind: FindingKind;
  code: string;
  detail: string;
};

const repoRoot = process.cwd();

type FileScanContext = {
  liveTwilioStart?: number;
  liveTwilioEnd?: number;
  regenerateStart?: number;
  regenerateEnd?: number;
};

const controlledReplyPipeline = [
  "normalize/parse structured data",
  "deterministic safety gates",
  "LLM parser/router for customer intent",
  "deterministic side effects",
  "orchestrator builds or selects reply",
  "final invariant guard",
  "draft/send"
];

const allowedDeterministicStages = [
  "compliance and safety gates: STOP, wrong number, suppression, TCPA-safe wording, no guessing",
  "side effects: close conversation, pause cadence, create todo, clear watch, suppress number, update state",
  "structured ADF parsing: source, lead ref, vehicle, trade, DLA/test-ride fields, preferred date/time, opt-in",
  "known response templates: credit app received, sold/delivered intake, wrong-number apology, opt-out, service/parts handoff",
  "guardrails: invariant blocks, truncation repair, appointment confirmation checks, price/finance/availability uncertainty",
  "low-confidence parser fallback: safe handoff or todo instead of a creative answer"
];

const targets = [
  "services/api/src/index.ts",
  "services/api/src/routes/sendgridInbound.ts"
];

const expectedLegacyCounts: Record<FindingKind, number> = {
  primary: 0,
  safety: 0,
  legacy_live_twilio_direct: 0,
  legacy_regenerate_direct: 0,
  legacy_adf_initial_direct: 0,
  legacy_email_reply_direct: 0,
  legacy_other_direct: 0,
  dead_or_non_customer: 0
};

function readLines(relPath: string): string[] {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8").split("\n");
}

function findLineIndex(lines: string[], pattern: string): number | undefined {
  const idx = lines.findIndex(line => line.includes(pattern));
  return idx >= 0 ? idx : undefined;
}

function buildScanContext(relPath: string, lines: string[]): FileScanContext {
  if (!relPath.endsWith("index.ts")) return {};
  const liveTwilioStart = findLineIndex(lines, 'app.post("/webhooks/twilio"');
  const liveTwilioVoiceStart = findLineIndex(lines, 'app.post("/webhooks/twilio/voice"');
  const regenerateStart = findLineIndex(lines, 'app.post("/conversations/:id/regenerate"');
  const emptyTwilioStart = findLineIndex(lines, "function emptyTwilioWebhookResponse");
  return {
    liveTwilioStart,
    liveTwilioEnd: liveTwilioVoiceStart != null ? liveTwilioVoiceStart - 1 : undefined,
    regenerateStart,
    regenerateEnd: emptyTwilioStart != null ? emptyTwilioStart - 1 : undefined
  };
}

function inRange(idx: number, start?: number, end?: number): boolean {
  return start != null && end != null && idx >= start && idx <= end;
}

function classify(relPath: string, line: string, idx: number, context: FileScanContext): Finding | null {
  const trimmed = line.trim();
  const lineNo = 0;

  if (relPath.endsWith("index.ts")) {
    const inLiveTwilioWebhook = inRange(idx, context.liveTwilioStart, context.liveTwilioEnd);
    const inRegenerateRoute = inRange(idx, context.regenerateStart, context.regenerateEnd);

    if (trimmed.includes("await safeOrchestrateInbound(")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Parser/router/orchestrator entry point."
      };
    }
    if (trimmed.includes("publishCustomerReplyDraft({")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Controlled final draft publication boundary."
      };
    }
    if (trimmed.includes("publishLiveTwilioReply(")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Live Twilio customer-facing text is handed to the controlled local publication boundary."
      };
    }
    if (trimmed.includes("const twiml =") && trimmed.includes("<Response></Response>")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "safety",
        code: trimmed,
        detail: "Deterministic safety/suppression stage: empty Twilio response, not customer-facing text."
      };
    }
    if (
      inLiveTwilioWebhook &&
      trimmed.includes("appendOutbound(conv, event.to, event.from,") &&
      trimmed.includes('"draft_ai"')
    ) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_live_twilio_direct",
        code: trimmed,
        detail: "Live Twilio creates a customer-facing draft outside the approved publication boundary."
      };
    }
    if (
      inLiveTwilioWebhook &&
      trimmed.includes("appendOutbound(conv, event.to, event.from,") &&
      trimmed.includes('"twilio"')
    ) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_live_twilio_direct",
        code: trimmed,
        detail: "Live Twilio appends customer-facing text outside the shared pipeline publication boundary."
      };
    }
    if (inLiveTwilioWebhook && trimmed.includes("const twiml =") && trimmed.includes("<Message>")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_live_twilio_direct",
        code: trimmed,
        detail: "Live Twilio returns customer-facing TwiML outside the shared pipeline publication boundary."
      };
    }
    if (inRegenerateRoute && trimmed.includes("appendOutbound(conv,") && trimmed.includes('"draft_ai"')) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_regenerate_direct",
        code: trimmed,
        detail: "Regenerate creates a customer-facing SMS draft outside publishCustomerReplyDraft."
      };
    }
    if (inRegenerateRoute && trimmed.includes("conv.emailDraft =")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_regenerate_direct",
        code: trimmed,
        detail: "Regenerate assigns an email draft outside publishCustomerReplyDraft."
      };
    }
    if (trimmed.includes("conv.emailDraft = formatEmailBodyForConversation(")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_other_direct",
        code: trimmed,
        detail: "Customer-facing email draft assignment outside the shared pipeline publication boundary."
      };
    }
  }

  if (relPath.endsWith("sendgridInbound.ts")) {
    if (trimmed.includes("await orchestrateInbound(")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Email reply / ADF route calls the orchestrator."
      };
    }
    if (
      trimmed.includes("publishAdfDraftForPreferredContact(") ||
      trimmed.includes("publishAdfEmailDraft(") ||
      trimmed.includes("publishEarlyAdfSmsDraft(") ||
      trimmed.includes("sendAdfEmailReply(") ||
      trimmed.includes("queueInitialDraftForPreferredContact(")
    ) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "ADF customer-facing text is handed to the controlled local publication boundary."
      };
    }
    if (trimmed.includes("setEmailDraft(conv, result.")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Email draft is published from orchestrator output."
      };
    }
    if (trimmed.includes('appendOutbound(conv, "dealership", leadKey,')) {
      return {
        file: relPath,
        line: lineNo,
        kind: trimmed.includes("invariant.draftText") ? "primary" : "legacy_adf_initial_direct",
        code: trimmed,
        detail: trimmed.includes("invariant.draftText")
          ? "ADF SMS draft append is inside the controlled local publication boundary."
          : "Initial ADF appends customer-facing SMS text before the controlled local publication boundary."
      };
    }
    if (trimmed.includes("setEmailDraft(conv, ack") || trimmed.includes("setEmailDraft(conv, emailDraft")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_adf_initial_direct",
        code: trimmed,
        detail: "Initial ADF assigns customer-facing email text from deterministic branch state before the shared pipeline boundary."
      };
    }
    if (trimmed.includes("setEmailDraft(conv, result.handoff.ack")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Email handoff acknowledgement is orchestrator output."
      };
    }
    if (trimmed.includes("setEmailDraft(conv, result.draft")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "primary",
        code: trimmed,
        detail: "Email draft is orchestrator output."
      };
    }
    if (trimmed.includes("appendOutbound(conv, emailFrom, emailTo!, signed, \"sendgrid\"")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_adf_initial_direct",
        code: trimmed,
        detail: "Initial ADF can send customer-facing email text directly before the shared pipeline boundary."
      };
    }
    if (trimmed.includes("setEmailDraft(conv, result.")) {
      return {
        file: relPath,
        line: lineNo,
        kind: "legacy_email_reply_direct",
        code: trimmed,
        detail: "Email reply draft assignment should stay tied to orchestrator output."
      };
    }
  }

  return null;
}

const findings: Finding[] = [];
for (const relPath of targets) {
  const lines = readLines(relPath);
  const context = buildScanContext(relPath, lines);
  lines.forEach((line, idx) => {
    const finding = classify(relPath, line, idx, context);
    if (finding) findings.push({ ...finding, line: idx + 1 });
  });
}

const counts = findings.reduce<Record<string, number>>((acc, finding) => {
  acc[finding.kind] = (acc[finding.kind] ?? 0) + 1;
  return acc;
}, {});

const legacyKinds: FindingKind[] = [
  "legacy_live_twilio_direct",
  "legacy_regenerate_direct",
  "legacy_adf_initial_direct",
  "legacy_email_reply_direct",
  "legacy_other_direct"
];

const failures: string[] = [];
for (const kind of legacyKinds) {
  const actual = counts[kind] ?? 0;
  const expected = expectedLegacyCounts[kind];
  if (actual !== expected) {
    failures.push(`${kind}: expected ${expected}, found ${actual}`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  policy: {
    goal: "Keep deterministic logic where it is the right tool, but require all customer-facing SMS/email text to pass through one controlled reply pipeline.",
    controlledReplyPipeline,
    allowedDeterministicStages,
    budgetMeaning:
      "Legacy counts track independent customer-facing publication sites. Deterministic parsing, safety, side effects, templates, and guardrails are allowed when used as named stages inside the pipeline."
  },
  targets,
  counts,
  legacyBudget: Object.fromEntries(legacyKinds.map(kind => [kind, expectedLegacyCounts[kind]])),
  failures,
  findings: process.env.REPLY_PATH_AUDIT_VERBOSE === "1" ? findings : undefined
};

console.log(JSON.stringify(report, null, 2));

if (failures.length) {
  console.error(`\nCustomer reply path audit failed:\n${failures.map(f => `- ${f}`).join("\n")}`);
  process.exit(1);
}
