import OpenAI from "openai";
import { dataPath } from "./dataDir.js";
import { readJsonStoreText, writeJsonStoreText } from "./storePersistence.js";
import {
  getSetupGmailMessageText,
  listSetupInboxMessages,
  sendSetupGmailEmail
} from "./googleCalendar.js";
import { getDealerSetup, updateDealerSetup, type DealerSetup } from "./dealerSetupStore.js";
import { addAgentTask } from "./agentTaskStore.js";
import { recordOpenAIUsage } from "./openaiUsageLogger.js";

/**
 * Dealer intake over email (Phase 1 of hands-off onboarding, Joe 2026-08-16).
 *
 * Sends the intake questionnaire from the dedicated setup mailbox (setup@leadrider.ai),
 * watches that mailbox for the dealer's reply, ingests the answers with a typed
 * structured-output parse (strict JSON schema — never regex over dealer prose), PATCHes the
 * Dealer Setup record, and files a notify task for staff.
 *
 * Guardrails:
 *  - Everything is gated on DEALER_INTAKE_EMAIL_ENABLED (default OFF).
 *  - The parser must never emit an EIN/SSN/password/API key/card number; a deterministic
 *    scrub backstops it (compliance gate — allowed deterministic use per AGENTS.md).
 *  - An empty answer never overwrites an existing record value.
 *  - This module deliberately does NOT touch llmDraft.ts / conversation state — dealer
 *    onboarding stays out of the customer-messaging path.
 */

export function isDealerIntakeEmailEnabled(): boolean {
  const raw = String(process.env.DEALER_INTAKE_EMAIL_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// ---------------------------------------------------------------------------
// Store: which invites are out, which replies were processed.
// ---------------------------------------------------------------------------

export type DealerIntakeMailRecord = {
  id: string;
  dealerSetupId: string;
  slug: string;
  to: string;
  threadId?: string;
  inviteMessageId?: string;
  sentAt: string;
  status: "awaiting_reply" | "ingested" | "error";
  processedMessageIds: string[];
  lastIngestAt?: string;
  lastBlanks?: string[];
  lastSensitiveWarning?: string;
  lastError?: string;
  updatedAt: string;
};

const STORE_PATH = process.env.DEALER_INTAKE_MAIL_PATH || dataPath("dealer_intake_mail.json");

let loaded = false;
let rows: DealerIntakeMailRecord[] = [];
let saveTimer: NodeJS.Timeout | null = null;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readJsonStoreText({ store: "dealer_intake_mail", filePath: STORE_PATH });
    const parsed = raw == null ? [] : JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed.filter(row => row && typeof row.id === "string") : [];
  } catch {
    rows = [];
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeJsonStoreText({
      store: "dealer_intake_mail",
      filePath: STORE_PATH,
      text: `${JSON.stringify(rows, null, 2)}\n`
    });
  }, 200);
}

export async function listDealerIntakeMail(dealerSetupId?: string): Promise<DealerIntakeMailRecord[]> {
  await ensureLoaded();
  const all = [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return dealerSetupId ? all.filter(row => row.dealerSetupId === dealerSetupId) : all;
}

// ---------------------------------------------------------------------------
// Questionnaire + invite (canonical copy; the terminal skill mirrors this).
// ---------------------------------------------------------------------------

export const INTAKE_QUESTIONS: Array<{ section: string; items: string[] }> = [
  {
    section: "Dealership identity",
    items: [
      "Dealership name (as customers know it)",
      "Full legal entity name (exactly as registered — used for SMS carrier registration)",
      "DBA name, if different",
      "Street address (street, city, state, zip)",
      "Website address",
      "Main phone number",
      "Federal EIN — do NOT write it in this form. Call us or send it in a separate direct email; we only use it for SMS carrier (A2P) registration."
    ]
  },
  {
    section: "People",
    items: [
      "Primary contact for this setup (name, role, cell, email)",
      "Owner / General Manager (name, email)",
      "Salespeople whose names appear as the text-message sender (each: name + cell)",
      "Who approves outgoing messages before they send?",
      "Who should be contacted after hours if something urgent comes up?"
    ]
  },
  {
    section: "Hours",
    items: [
      "Sales department hours (each day)",
      "Service department hours (each day)",
      "Holiday closures or other regular closures"
    ]
  },
  {
    section: "Leads and systems",
    items: [
      "Which CRM do you use?",
      "Roughly how many leads per month?",
      "Where do your leads come from? (website, marketplaces, walk-ins, events, …)",
      "Where do lead notifications arrive today? (an inbox, the CRM, a phone…)",
      "Inventory feed or export URL (the link your website/inventory provider gives you)",
      "Who keeps that inventory feed up to date?"
    ]
  },
  {
    section: "Voice",
    items: [
      "How should messages to your customers sound? (friendly, formal, short, …)",
      "Anything we should NEVER say or promise in a message?"
    ]
  }
];

export function buildIntakeQuestionnaireText(dealerName: string): string {
  const lines: string[] = [
    `${dealerName} — LeadRider setup questionnaire`,
    "",
    "Please answer right under each question, in your own words — plain sentences are perfect",
    '("closed Sundays, Saturday till 3" is exactly what we want). Skip anything you\'re unsure of.',
    "",
    "IMPORTANT: do NOT include passwords, API keys, or card numbers anywhere in this form.",
    "We will never ask for them here. Your EIN also stays OUT of this form — send it",
    "separately (see the EIN question).",
    ""
  ];
  let n = 1;
  for (const group of INTAKE_QUESTIONS) {
    lines.push(`== ${group.section} ==`, "");
    for (const q of group.items) {
      lines.push(`${n}. ${q}`, "", "");
      n += 1;
    }
  }
  return lines.join("\n");
}

export function buildIntakeInviteEmail(setup: Pick<DealerSetup, "dealerName" | "primaryContact">): {
  subject: string;
  bodyText: string;
} {
  const contact = String(setup.primaryContact ?? "").trim();
  const firstName = contact ? contact.split(/[\s,<(]/)[0] : "";
  const bodyText = [
    `Hi ${firstName || "there"},`,
    "",
    "Excited to get you up and running on LeadRider. Below is a short questionnaire — it",
    "covers the basics we need to set up your texting line, email, calendar, and inventory",
    "feed. Just hit reply and answer under each question, in your own words; skip anything",
    "you're not sure about and we'll sort it out on a call.",
    "",
    "Two important notes:",
    "- Please don't put passwords, API keys, or card numbers anywhere in your reply.",
    "- We do need your federal EIN for text-message carrier registration, but NOT over",
    "  email reply — call us with it or send it in a separate direct email.",
    "",
    "----------------------------------------",
    "",
    buildIntakeQuestionnaireText(setup.dealerName),
    "",
    "Thanks!",
    "The LeadRider team"
  ].join("\n");
  return {
    subject: `Getting ${setup.dealerName} set up on LeadRider — a few questions`,
    bodyText
  };
}

// ---------------------------------------------------------------------------
// Typed structured-output ingest (never regex over dealer prose).
// ---------------------------------------------------------------------------

export const DEALER_INTAKE_ANSWERS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    legalName: { type: "string", description: "Full legal entity name exactly as the dealer wrote it; empty string if unanswered." },
    dbaName: { type: "string" },
    address: { type: "string", description: "Street address as written." },
    website: { type: "string" },
    mainPhone: { type: "string" },
    primaryContact: { type: "string", description: "Name, role, cell, email as written, on one line." },
    ownerGm: { type: "string" },
    salespeople: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, cell: { type: "string" } },
        required: ["name", "cell"]
      }
    },
    messageApprover: { type: "string" },
    afterHoursEscalation: { type: "string" },
    salesHours: { type: "string", description: "Verbatim as written; do not normalize." },
    serviceHours: { type: "string" },
    closures: { type: "string" },
    crmProvider: { type: "string" },
    monthlyLeadVolume: { type: "string" },
    leadSources: { type: "array", items: { type: "string" } },
    leadNotificationDestination: { type: "string" },
    inventoryFeedUrl: { type: "string" },
    inventoryFeedOwner: { type: "string" },
    tonePreferences: { type: "string" },
    neverSay: { type: "array", items: { type: "string" } },
    unansweredQuestions: { type: "array", items: { type: "string" }, description: "Questions the dealer left blank or clearly skipped." },
    extraNotes: { type: "string", description: "Anything the dealer wrote that fits no other field, verbatim." },
    sensitiveDataWarning: {
      type: "string",
      description: "If the dealer included an EIN, SSN, password, API key, token, or card number anywhere, describe WHAT they included and WHERE — but never repeat the value. Empty string if none."
    }
  },
  required: [
    "legalName", "dbaName", "address", "website", "mainPhone", "primaryContact", "ownerGm",
    "salespeople", "messageApprover", "afterHoursEscalation", "salesHours", "serviceHours",
    "closures", "crmProvider", "monthlyLeadVolume", "leadSources", "leadNotificationDestination",
    "inventoryFeedUrl", "inventoryFeedOwner", "tonePreferences", "neverSay",
    "unansweredQuestions", "extraNotes", "sensitiveDataWarning"
  ]
} as const;

export type DealerIntakeAnswers = {
  legalName: string;
  dbaName: string;
  address: string;
  website: string;
  mainPhone: string;
  primaryContact: string;
  ownerGm: string;
  salespeople: Array<{ name: string; cell: string }>;
  messageApprover: string;
  afterHoursEscalation: string;
  salesHours: string;
  serviceHours: string;
  closures: string;
  crmProvider: string;
  monthlyLeadVolume: string;
  leadSources: string[];
  leadNotificationDestination: string;
  inventoryFeedUrl: string;
  inventoryFeedOwner: string;
  tonePreferences: string;
  neverSay: string[];
  unansweredQuestions: string[];
  extraNotes: string;
  sensitiveDataWarning: string;
};

// Deterministic compliance backstop (allowed per AGENTS.md: safety gate, not comprehension):
// even if the model slips, a dashed EIN or a card-length digit run never lands in the record.
export function scrubSensitive(value: string): string {
  return value
    .replace(/\b\d{2}-\d{7}\b/g, "[redacted]")
    .replace(/\b(?:\d[ -]?){13,16}\b/g, "[redacted]");
}

export function scrubDeep<T>(obj: T): T {
  if (typeof obj === "string") return scrubSensitive(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(scrubDeep) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = scrubDeep(v);
    return out;
  }
  return obj;
}

export async function parseDealerIntakeAnswers(rawText: string): Promise<DealerIntakeAnswers> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const isGpt5 = /^gpt-5/i.test(model);
  const questionList = INTAKE_QUESTIONS.flatMap(g => g.items.map(q => `- [${g.section}] ${q}`)).join("\n");
  const prompt = [
    "You are a strict transcriber for a dealership onboarding questionnaire. The dealer answered",
    "in free text below. Extract their answers into the schema.",
    "",
    "Rules:",
    "- Transcribe what the dealer actually wrote. Light cleanup only (whitespace, obvious typos in",
    "  URLs, drop filler like \"Maybe\" from a lead-volume number). Keep hours/closures VERBATIM —",
    "  do not normalize \"closed Sundays, Sat till 3\".",
    "- Empty string (or empty array) for anything unanswered. NEVER guess or fill in a default.",
    "- If an answer says there is none (\"no DBA\", \"n/a\"), that field is the empty string.",
    "- Resolve references WITHIN the dealer's own text (\"same as above\", \"owner is also me\") to",
    "  the actual name/value they refer to. That is transcription, not guessing.",
    "- leadSources and neverSay are lists: one item per source/rule.",
    "- Ignore quoted text from OUR original email (lines starting with > or the questionnaire",
    "  itself) — extract only what the DEALER wrote.",
    "- Anything that fits no field goes into extraNotes verbatim.",
    "- List skipped/blank questions in unansweredQuestions (short paraphrases are fine).",
    "- NEVER output an EIN, SSN, password, API key, token, or card number in ANY field. If the",
    "  dealer included one, leave it out entirely and describe it (without the value) in",
    "  sensitiveDataWarning.",
    "",
    "The questionnaire's questions were:",
    questionList,
    "",
    "Dealer's reply:",
    "----------------------------------------",
    rawText.slice(0, 24000),
    "----------------------------------------"
  ].join("\n");
  const resp = await client.responses.parse({
    model,
    input: prompt,
    // gpt-5-family models reject temperature; everything else runs at 0 (deterministic transcription).
    ...(isGpt5 ? { reasoning: { effort: "minimal" as const } } : { temperature: 0 }),
    max_output_tokens: 3000,
    text: {
      format: {
        type: "json_schema",
        name: "dealer_intake_answers",
        schema: DEALER_INTAKE_ANSWERS_JSON_SCHEMA as unknown as Record<string, unknown>,
        strict: true
      }
    }
  });
  recordOpenAIUsage(resp, {
    feature: "dealer_intake",
    operation: "dealer_intake_answers",
    requestKind: "responses.parse",
    model
  });
  const parsed = (resp as any)?.output_parsed;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("dealer intake structured parse returned nothing");
  }
  return scrubDeep(parsed as DealerIntakeAnswers);
}

// ---------------------------------------------------------------------------
// Pure mapping: answers -> record patch (eval-pinned; empty never clobbers).
// ---------------------------------------------------------------------------

export function buildIntakeNotesBlock(a: DealerIntakeAnswers): string {
  const lines: string[] = [];
  const add = (label: string, value: string) => {
    const v = String(value ?? "").trim();
    if (v) lines.push(`${label}: ${v}`);
  };
  add("Main phone", a.mainPhone);
  add("Sales hours", a.salesHours);
  add("Service hours", a.serviceHours);
  add("Closures", a.closures);
  if (Array.isArray(a.salespeople) && a.salespeople.length) {
    lines.push(`Salespeople: ${a.salespeople.map(p => `${p.name} (${p.cell})`.trim()).join("; ")}`);
  }
  add("Message approver", a.messageApprover);
  add("After-hours escalation", a.afterHoursEscalation);
  if (Array.isArray(a.leadSources) && a.leadSources.length) lines.push(`Lead sources: ${a.leadSources.join(", ")}`);
  add("Lead notifications", a.leadNotificationDestination);
  // These three labels are load-bearing: dealerSetupStore.buildDealerConfigStandard reads
  // "Inventory/export URL:", "Tone:" and "Rules:" lines out of notes.
  add("Inventory/export URL", a.inventoryFeedUrl);
  add("Inventory feed owner", a.inventoryFeedOwner);
  add("Tone", a.tonePreferences);
  if (Array.isArray(a.neverSay) && a.neverSay.length) lines.push(`Rules: ${a.neverSay.join("; ")}`);
  add("Intake extra", a.extraNotes);
  return lines.join("\n");
}

export function applyIntakeAnswersToSetup(
  setup: Pick<
    DealerSetup,
    "legalName" | "dbaName" | "dealerAddress" | "website" | "primaryContact" | "owner" | "crmProvider" | "leadVolume" | "notes"
  >,
  a: DealerIntakeAnswers,
  ingestLabel: string
): {
  patch: Record<string, string>;
  diffs: string[];
  blanks: string[];
  stepStatus: "done" | "waiting_on_dealer";
  stepNote: string;
} {
  const fieldMap: Array<{ key: keyof typeof setup & string; from: string }> = [
    { key: "legalName", from: a.legalName },
    { key: "dbaName", from: a.dbaName },
    { key: "dealerAddress", from: a.address },
    { key: "website", from: a.website },
    { key: "primaryContact", from: a.primaryContact },
    { key: "owner", from: a.ownerGm },
    { key: "crmProvider", from: a.crmProvider },
    { key: "leadVolume", from: a.monthlyLeadVolume }
  ];
  const patch: Record<string, string> = {};
  const diffs: string[] = [];
  for (const { key, from } of fieldMap) {
    const next = String(from ?? "").trim();
    if (!next) continue; // empty = unanswered — never clobber an existing value with a blank
    const prev = String((setup as any)[key] ?? "").trim();
    if (prev === next) continue;
    patch[key] = next;
    diffs.push(`${key}: ${prev ? JSON.stringify(prev) : "(empty)"} -> ${JSON.stringify(next)}`);
  }
  const notesBlock = buildIntakeNotesBlock(a);
  const existingNotes = String(setup.notes ?? "").trim();
  if (notesBlock && !existingNotes.includes(notesBlock)) {
    patch.notes = existingNotes ? `${existingNotes}\n\n[${ingestLabel}]\n${notesBlock}` : `[${ingestLabel}]\n${notesBlock}`;
    diffs.push(`notes: +${notesBlock.split("\n").length} intake lines appended`);
  }
  const blanks = Array.isArray(a.unansweredQuestions) ? a.unansweredQuestions.filter(Boolean) : [];
  // Step status keys off what the dealer actually skipped (the parser's blank report), not
  // off optional fields that are legitimately empty ("no DBA" is an answer, not a blank).
  const stepStatus = blanks.length ? ("waiting_on_dealer" as const) : ("done" as const);
  const stepNote = blanks.length
    ? `Intake ingested (${ingestLabel}); dealer still owes: ${blanks.join("; ")}`.slice(0, 590)
    : `Intake ingested (${ingestLabel}).`;
  return { patch, diffs, blanks, stepStatus, stepNote };
}

// ---------------------------------------------------------------------------
// Send + poll (flag-gated side effects).
// ---------------------------------------------------------------------------

export function extractEmailAddress(text: string): string {
  const m = String(text ?? "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : "";
}

export async function sendDealerIntakeInvite(
  dealerSetupId: string,
  opts: { toOverride?: string } = {}
): Promise<{ to: string; threadId: string; messageId: string }> {
  if (!isDealerIntakeEmailEnabled()) {
    throw new Error("Dealer intake email is disabled (set DEALER_INTAKE_EMAIL_ENABLED=1 to enable).");
  }
  const setup = await getDealerSetup(dealerSetupId);
  if (!setup) throw new Error("Dealer setup not found.");
  const to = String(opts.toOverride ?? "").trim() || extractEmailAddress(setup.primaryContact ?? "");
  if (!to) throw new Error("No recipient: primary contact has no email address (pass one explicitly).");
  const { subject, bodyText } = buildIntakeInviteEmail(setup);
  const sent = await sendSetupGmailEmail({ to, subject, bodyText });
  const now = new Date().toISOString();
  await ensureLoaded();
  rows.unshift({
    id: `intake_mail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    dealerSetupId: setup.id,
    slug: setup.slug,
    to,
    threadId: sent.threadId ?? undefined,
    inviteMessageId: sent.id ?? undefined,
    sentAt: now,
    status: "awaiting_reply",
    processedMessageIds: [],
    updatedAt: now
  });
  scheduleSave();
  await updateDealerSetup(setup.id, {
    stepId: "intake",
    stepStatus: "waiting_on_dealer",
    stepNote: `Intake questionnaire emailed to ${to}.`
  });
  return { to, threadId: String(sent.threadId ?? ""), messageId: String(sent.id ?? "") };
}

export function matchReplyToInvite(
  invites: Array<Pick<DealerIntakeMailRecord, "id" | "threadId" | "to" | "processedMessageIds">>,
  message: { id?: string | null; threadId?: string | null; from?: string | null }
): string | null {
  const messageId = String(message.id ?? "");
  const threadId = String(message.threadId ?? "");
  const fromEmail = extractEmailAddress(String(message.from ?? "")).toLowerCase();
  for (const invite of invites) {
    if (messageId && invite.processedMessageIds.includes(messageId)) continue;
    if (threadId && invite.threadId && invite.threadId === threadId) return invite.id;
  }
  for (const invite of invites) {
    if (messageId && invite.processedMessageIds.includes(messageId)) continue;
    if (fromEmail && invite.to.toLowerCase() === fromEmail) return invite.id;
  }
  return null;
}

// Express handlers + the poll loop live HERE, not in index.ts — the source-size ratchet
// (scripts/source_size_ratchet_eval.ts) is the enforcement that new features arrive as
// domain modules with one-line wiring.
export async function dealerIntakeSendInviteHandler(req: any, res: any) {
  if (!isDealerIntakeEmailEnabled()) {
    return res.status(409).json({ ok: false, error: "Dealer intake email is disabled (DEALER_INTAKE_EMAIL_ENABLED)." });
  }
  try {
    const toOverride = String(req.body?.to ?? "").trim() || undefined;
    const result = await sendDealerIntakeInvite(req.params.id, { toOverride });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: String(err?.message ?? err).slice(0, 300) });
  }
}

export async function dealerIntakeStatusHandler(req: any, res: any) {
  const records = await listDealerIntakeMail(req.params.id);
  return res.json({ ok: true, enabled: isDealerIntakeEmailEnabled(), records });
}

// Startup hook: watches setup@ for questionnaire replies and auto-ingests them.
// Hard-gated on DEALER_INTAKE_EMAIL_ENABLED (default OFF) — the single kill switch.
export function startDealerIntakeMailPollLoop() {
  if (!isDealerIntakeEmailEnabled()) return;
  const minutesRaw = Number(process.env.DEALER_INTAKE_MAIL_POLL_MINUTES ?? "5");
  const minutes = Number.isFinite(minutesRaw) && minutesRaw >= 1 ? minutesRaw : 5;
  console.log(`[dealer intake] mail poll enabled (${minutes} min interval)`);
  const run = async () => {
    try {
      const { checked, ingested, errors } = await pollDealerIntakeMail(15);
      if (checked || ingested || errors) {
        console.log(`[dealer intake] poll checked ${checked} messages, ingested ${ingested}, errors ${errors}`);
      }
    } catch (err: any) {
      console.warn("[dealer intake] poll failed:", err?.message ?? err);
    }
  };
  setTimeout(run, 30_000).unref?.();
  const interval = setInterval(run, minutes * 60 * 1000);
  (interval as any).unref?.();
}

export async function pollDealerIntakeMail(limit = 15): Promise<{
  checked: number;
  ingested: number;
  errors: number;
}> {
  if (!isDealerIntakeEmailEnabled()) return { checked: 0, ingested: 0, errors: 0 };
  await ensureLoaded();
  const open = rows.filter(row => row.status !== "error");
  if (!open.length) return { checked: 0, ingested: 0, errors: 0 };
  const messages = await listSetupInboxMessages(limit);
  let ingested = 0;
  let errors = 0;
  for (const message of messages) {
    const inviteId = matchReplyToInvite(open, message);
    if (!inviteId) continue;
    const invite = rows.find(row => row.id === inviteId)!;
    const messageId = String(message.id ?? "");
    try {
      const full = await getSetupGmailMessageText(messageId);
      const text = String(full.text ?? "").trim();
      invite.processedMessageIds.push(messageId);
      if (!text) {
        invite.updatedAt = new Date().toISOString();
        scheduleSave();
        continue;
      }
      const answers = await parseDealerIntakeAnswers(text);
      const setup = await getDealerSetup(invite.dealerSetupId);
      if (!setup) throw new Error(`dealer setup ${invite.dealerSetupId} vanished`);
      const label = `intake email ${new Date().toISOString().slice(0, 10)}`;
      const applied = applyIntakeAnswersToSetup(setup, answers, label);
      await updateDealerSetup(setup.id, {
        ...applied.patch,
        stepId: "intake",
        stepStatus: applied.stepStatus,
        stepNote: applied.stepNote
      });
      invite.status = "ingested";
      invite.lastIngestAt = new Date().toISOString();
      invite.lastBlanks = applied.blanks;
      invite.lastSensitiveWarning = String(answers.sensitiveDataWarning ?? "").trim() || undefined;
      invite.updatedAt = new Date().toISOString();
      scheduleSave();
      ingested += 1;
      const summaryLines = [
        `Dealer intake reply from ${invite.to} ingested for ${setup.dealerName} [${setup.slug}].`,
        applied.diffs.length ? `Changes: ${applied.diffs.join("; ")}` : "No record changes (already matched).",
        applied.blanks.length ? `Still owed: ${applied.blanks.join("; ")}` : "Fully answered.",
        invite.lastSensitiveWarning
          ? `SENSITIVE DATA in the reply (NOT ingested): ${invite.lastSensitiveWarning}. Ask the dealer to use the proper channel.`
          : ""
      ].filter(Boolean);
      await addAgentTask({
        provider: "claude",
        kind: "dealer_setup",
        title: `Intake reply ingested: ${setup.dealerName}`,
        instructions: summaryLines.join("\n"),
        clientName: setup.dealerName,
        priority: invite.lastSensitiveWarning ? "high" : "normal",
        risk: "low"
      });
      console.log(`[dealer intake] ingested reply for ${setup.slug} (${applied.diffs.length} changes, ${applied.blanks.length} blanks)`);
    } catch (err: any) {
      errors += 1;
      invite.lastError = String(err?.message ?? err).slice(0, 300);
      invite.updatedAt = new Date().toISOString();
      scheduleSave();
      console.warn(`[dealer intake] ingest failed for ${invite.slug}:`, invite.lastError);
    }
  }
  return { checked: messages.length, ingested, errors };
}
