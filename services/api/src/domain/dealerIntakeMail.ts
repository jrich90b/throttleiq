import OpenAI from "openai";
import crypto from "node:crypto";
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
  formToken?: string;
  formSubmittedAt?: string;
  followUpSentAt?: string;
  lastFollowUpBlanks?: string[];
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
      "Everyone who needs a LeadRider console login (one per line: name + email)",
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
      "Who keeps that inventory feed up to date?",
      "What sales tax rate applies to vehicle purchases at your store? (e.g. 8.75%)",
      "Do you have an online credit application? Paste the link customers use to apply.",
      "Where is the current-promotions page on your website, if you have one?",
      "Will you provide LeadRider a CRM login so leads and calls get logged back into your CRM automatically? Just yes or no here — if yes, we collect the login through a secure channel, NEVER this form."
    ]
  },
  {
    section: "Your website and email providers",
    items: [
      "Who runs your website? (the company or person — your website provider)",
      "Best contact EMAIL for your website provider — we'll email them directly, with you CC'd, to add the technical records LeadRider needs (DNS) and the SMS consent wording on your web lead forms (the carriers require it before they approve your texting number).",
      "Who manages your domain / DNS, if different from the website provider?",
      "Who hosts your business email? (e.g. Rackspace, Google Workspace, GoDaddy)",
      "What email address should messages to your customers come from (and reply to)? Note any logo or email signature you want used.",
      "Link to the privacy policy page on your website, if you have one — carriers require one covering SMS consent; if you don't have it, your website provider will add it (we'll include it in our email to them)."
    ]
  },
  {
    section: "Google and social",
    items: [
      "Link to your Google Business Profile (your dealership's listing on Google Maps), and which Google account manages it — so we can eventually help you respond to reviews. Never send the password.",
      "Which Google account runs the calendar where appointments should book (address only — never the password), and who at the store can click Allow when we connect it?",
      "Your social media accounts (one per line: platform + page name or URL) — for future integrations."
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

export function buildIntakeInviteEmail(
  setup: Pick<DealerSetup, "dealerName" | "primaryContact">,
  formUrl?: string
): {
  subject: string;
  bodyText: string;
} {
  const contact = String(setup.primaryContact ?? "").trim();
  const firstName = contact ? contact.split(/[\s,<(]/)[0] : "";
  const bodyText = [
    `Hi ${firstName || "there"},`,
    "",
    "Excited to get you up and running on LeadRider. We need a few basics to set up your",
    "texting line, email, calendar, and inventory feed" +
      (formUrl ? " — the easiest way is our setup form:" : ". Just hit reply and answer below."),
    ...(formUrl
      ? [
          "",
          `    ${formUrl}`,
          "",
          "It takes about 10 minutes, saves as soon as you submit, and works fine on a phone.",
          "Prefer email? Just reply to this message and answer in your own words instead."
        ]
      : ["", "----------------------------------------", "", buildIntakeQuestionnaireText(setup.dealerName)]),
    "",
    "Two important notes:",
    "- Please don't put passwords, API keys, or card numbers in the form or any reply.",
    "- We do need your federal EIN for text-message carrier registration, but NOT through",
    "  the form or email — call us with it or send it in a separate direct email.",
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
    taxRate: { type: "string", description: "Sales tax rate for vehicle purchases, as written (e.g. 8.75%)." },
    creditAppUrl: { type: "string", description: "URL of the dealer's online credit application; empty if none." },
    offersUrl: { type: "string", description: "URL of the dealer's current-promotions page; empty if none." },
    crmLoginWillingness: { type: "string", description: "Whether they'll provide a CRM login (yes/no + any comment). NEVER the credential itself." },
    websiteProvider: { type: "string", description: "Company/person who runs the dealer's website." },
    websiteProviderEmail: { type: "string", description: "Contact email for the website provider (used to request DNS records + SMS consent wording, dealer CC'd)." },
    dnsManager: { type: "string", description: "Who manages the domain/DNS if different from the website provider." },
    emailHostProvider: { type: "string", description: "Who hosts the dealer's business email (e.g. Rackspace, Google Workspace)." },
    googleBusinessProfile: { type: "string", description: "Google Business Profile link and/or which Google account manages it. NEVER a password." },
    socialMedia: { type: "array", items: { type: "string" }, description: "Social accounts, one item per platform/page." },
    consoleUsers: { type: "array", items: { type: "string" }, description: "Staff who need a LeadRider console login, one item per person (name + email as written)." },
    outboundEmailIdentity: { type: "string", description: "The from/reply-to address for customer emails, plus any logo/signature notes." },
    calendarGoogleAccount: { type: "string", description: "Google account that runs the booking calendar + who can click Allow. NEVER a password." },
    privacyPolicyUrl: { type: "string", description: "Privacy policy page URL if one exists; empty if none." },
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
    "inventoryFeedUrl", "inventoryFeedOwner", "taxRate", "creditAppUrl", "offersUrl",
    "crmLoginWillingness", "websiteProvider", "websiteProviderEmail",
    "dnsManager", "emailHostProvider", "googleBusinessProfile", "socialMedia",
    "consoleUsers", "outboundEmailIdentity", "calendarGoogleAccount", "privacyPolicyUrl",
    "tonePreferences", "neverSay", "unansweredQuestions", "extraNotes", "sensitiveDataWarning"
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
  taxRate: string;
  creditAppUrl: string;
  offersUrl: string;
  crmLoginWillingness: string;
  websiteProvider: string;
  websiteProviderEmail: string;
  dnsManager: string;
  emailHostProvider: string;
  googleBusinessProfile: string;
  socialMedia: string[];
  consoleUsers: string[];
  outboundEmailIdentity: string;
  calendarGoogleAccount: string;
  privacyPolicyUrl: string;
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
    lines.push(`Salespeople: ${a.salespeople.map(p => (p.cell ? `${p.name} (${p.cell})` : p.name)).join("; ")}`);
  }
  add("Message approver", a.messageApprover);
  add("After-hours escalation", a.afterHoursEscalation);
  if (Array.isArray(a.leadSources) && a.leadSources.length) lines.push(`Lead sources: ${a.leadSources.join(", ")}`);
  add("Lead notifications", a.leadNotificationDestination);
  // These three labels are load-bearing: dealerSetupStore.buildDealerConfigStandard reads
  // "Inventory/export URL:", "Tone:" and "Rules:" lines out of notes.
  add("Inventory/export URL", a.inventoryFeedUrl);
  add("Inventory feed owner", a.inventoryFeedOwner);
  add("Tax rate", a.taxRate);
  add("Credit app URL", a.creditAppUrl);
  add("Promotions page", a.offersUrl);
  add("CRM login", a.crmLoginWillingness);
  add("Website provider", a.websiteProvider);
  add("Website provider email", a.websiteProviderEmail);
  add("DNS manager", a.dnsManager);
  add("Email host", a.emailHostProvider);
  add("Google Business Profile", a.googleBusinessProfile);
  if (Array.isArray(a.socialMedia) && a.socialMedia.length) lines.push(`Social: ${a.socialMedia.join("; ")}`);
  if (Array.isArray(a.consoleUsers) && a.consoleUsers.length) lines.push(`Console users: ${a.consoleUsers.join("; ")}`);
  add("Outbound email", a.outboundEmailIdentity);
  add("Calendar Google account", a.calendarGoogleAccount);
  add("Privacy policy", a.privacyPolicyUrl);
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
  if (notesBlock) {
    // Intake sections are machine-owned: REPLACE any prior [intake …] sections instead of
    // appending (a re-parse of the same answers is never byte-identical, so append-with-
    // dedupe piled up near-duplicates — seen on the demo record 8/16). Human-written note
    // segments (anything not starting with "[intake") are always preserved.
    const humanSegments = existingNotes
      ? existingNotes.split(/\n\n+/).filter(segment => !segment.trimStart().startsWith("[intake"))
      : [];
    const next = [...humanSegments, `[${ingestLabel}]\n${notesBlock}`].join("\n\n");
    if (next !== existingNotes) {
      patch.notes = next;
      diffs.push(`notes: intake section refreshed (${notesBlock.split("\n").length} lines)`);
    }
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
  const formToken = crypto.randomBytes(18).toString("hex");
  const formUrl = `${String(process.env.LEADRIDER_API_BASE_URL ?? "https://api.leadrider.ai").replace(/\/$/, "")}/public/dealer-intake/${formToken}`;
  const { subject, bodyText } = buildIntakeInviteEmail(setup, formUrl);
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
    formToken,
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

// ---------------------------------------------------------------------------
// Branded public intake FORM (Joe 2026-08-16: "a branded LeadRider form on a page
// they fill out" instead of questions in the email). The invite email carries a
// tokenized link; the page posts labeled fields; mapping is DETERMINISTIC
// (structured extraction of labeled inputs — allowed per AGENTS.md; free-text
// answers like hours stay verbatim). Reply-by-email stays as the fallback lane.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FORM_FIELDS: Array<{
  name: keyof DealerIntakeAnswers & string;
  label: string;
  hint?: string;
  multiline?: boolean;
  perLine?: boolean; // textarea parsed one item per line (lists)
  section?: string;
}> = [
  { name: "legalName", label: "Full legal entity name", hint: "Exactly as registered — used for SMS carrier registration.", section: "Dealership identity" },
  { name: "dbaName", label: "DBA name, if different" },
  { name: "address", label: "Street address", hint: "Street, city, state, zip." },
  { name: "website", label: "Website address" },
  { name: "mainPhone", label: "Main phone number" },
  { name: "primaryContact", label: "Primary contact for this setup", hint: "Name, role, cell, email.", section: "People" },
  { name: "ownerGm", label: "Owner / General Manager", hint: "Name and email." },
  { name: "salespeople", label: "Salespeople who appear as the text-message sender", hint: "One per line: Name - cell number.", multiline: true, perLine: true },
  { name: "consoleUsers", label: "Everyone who needs a LeadRider console login", hint: "One per line: Name - email address.", multiline: true, perLine: true },
  { name: "messageApprover", label: "Who approves outgoing messages before they send?" },
  { name: "afterHoursEscalation", label: "Who should be contacted after hours if something urgent comes up?" },
  { name: "salesHours", label: "Sales department hours", hint: "In your own words — \"9-6 weekdays, Sat till 3, closed Sunday\" is perfect.", multiline: true, section: "Hours" },
  { name: "serviceHours", label: "Service department hours", multiline: true },
  { name: "closures", label: "Holiday closures or other regular closures", multiline: true },
  { name: "crmProvider", label: "Which CRM do you use?", section: "Leads and systems" },
  { name: "monthlyLeadVolume", label: "Roughly how many leads per month?" },
  { name: "leadSources", label: "Where do your leads come from?", hint: "One per line — website, marketplaces, walk-ins, events…", multiline: true, perLine: true },
  { name: "leadNotificationDestination", label: "Where do lead notifications arrive today?", hint: "An inbox, the CRM, a phone…" },
  { name: "inventoryFeedUrl", label: "Inventory feed or export URL", hint: "The link your website/inventory provider gives you." },
  { name: "inventoryFeedOwner", label: "Who keeps that inventory feed up to date?" },
  { name: "taxRate", label: "Sales tax rate on vehicle purchases", hint: "E.g. 8.75% — used so payment estimates come out right." },
  { name: "creditAppUrl", label: "Online credit application link", hint: "The link customers use to apply for financing. Leave blank if you don't have one." },
  { name: "offersUrl", label: "Current-promotions page on your website", hint: "Leave blank if you don't have one." },
  { name: "crmLoginWillingness", label: "Will you provide LeadRider a CRM login?", hint: "So leads and calls get logged back into your CRM automatically. Yes or no is all we need here — if yes, we collect the login through a secure channel, NEVER this form." },
  { name: "websiteProvider", label: "Who runs your website?", hint: "The company or person — your website provider.", section: "Your website & email providers" },
  { name: "websiteProviderEmail", label: "Best contact email for your website provider", hint: "We'll email them directly, with you CC'd, to add the technical records LeadRider needs (DNS) and the SMS consent wording on your web lead forms — the carriers require it before approving your texting number." },
  { name: "dnsManager", label: "Who manages your domain / DNS, if different?" },
  { name: "emailHostProvider", label: "Who hosts your business email?", hint: "E.g. Rackspace, Google Workspace, GoDaddy." },
  { name: "outboundEmailIdentity", label: "What email address should messages to your customers come from?", hint: "The from/reply-to address customers see. Note any logo or email signature you want used." },
  { name: "privacyPolicyUrl", label: "Privacy policy page on your website, if you have one", hint: "Carriers require one covering SMS consent. No page yet? Leave blank — your website provider will add it and we'll include it in our email to them." },
  { name: "googleBusinessProfile", label: "Your Google Business Profile", hint: "Paste the Google Maps link to your dealership, or just tell us the account email that manages the listing — no ID numbers needed. Never the password.", section: "Google & social" },
  { name: "calendarGoogleAccount", label: "Which Google account runs your appointment calendar?", hint: "Address only — never the password — plus who at the store can click Allow when we connect it." },
  { name: "socialMedia", label: "Social media accounts", hint: "One per line: platform + page name or URL — for future integrations.", multiline: true, perLine: true },
  { name: "tonePreferences", label: "How should messages to your customers sound?", hint: "Friendly, formal, short…", multiline: true, section: "Voice" },
  { name: "neverSay", label: "Anything we should NEVER say or promise in a message?", hint: "One per line.", multiline: true, perLine: true },
  { name: "extraNotes", label: "Anything else we should know?", multiline: true }
];

export function renderIntakeFormHtml(setup: Pick<DealerSetup, "dealerName">): string {
  const dealer = escapeHtml(setup.dealerName);
  const fields = FORM_FIELDS.map(f => {
    const section = f.section ? `<h2>${escapeHtml(f.section)}</h2>` : "";
    const hint = f.hint ? `<p class="hint">${escapeHtml(f.hint)}</p>` : "";
    const input = f.multiline
      ? `<textarea name="${f.name}" rows="3" maxlength="2000"></textarea>`
      : `<input type="text" name="${f.name}" maxlength="2000" />`;
    return `${section}<label>${escapeHtml(f.label)}${hint}${input}</label>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${dealer} — LeadRider setup</title><style>
:root{--brand:#fb7f04;--action:#a94e00;--ink:#050505;--paper:#fbfaf9;--line:#d9d5cf}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.bar{height:6px;background:var(--brand)}.wrap{max-width:720px;margin:0 auto;padding:24px 16px 64px}
.logo{font-weight:800;font-size:22px;letter-spacing:-.02em}.logo span{color:var(--action)}
h1{font-size:24px;margin:16px 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--action);margin:32px 0 4px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:#4d4a45;margin:0 0 8px}
.warn{background:#fdeada;border:1px solid var(--brand);border-radius:8px;padding:12px 14px;margin:16px 0;font-size:14px}
label{display:block;margin:16px 0;font-weight:600;font-size:15px}
.hint{font-weight:400;color:#6b675f;font-size:13px;margin:2px 0 6px}
input,textarea{width:100%;margin-top:6px;padding:10px 12px;font:inherit;border:1px solid var(--line);border-radius:8px;background:#fff}
input:focus,textarea:focus{outline:2px solid var(--brand);border-color:var(--brand)}
button{margin-top:24px;background:var(--action);color:#fff;border:0;border-radius:8px;padding:14px 28px;font:inherit;font-weight:700;cursor:pointer}
button:hover{background:#933f00}.foot{margin-top:32px;font-size:13px;color:#6b675f}
</style></head><body><div class="bar"></div><div class="wrap">
<div class="logo">Lead<span>Rider</span></div>
<h1>${dealer} — setup questionnaire</h1>
<p class="sub">Answer in your own words — plain sentences are perfect. Skip anything you're unsure of; everything saves when you hit Submit.</p>
<div class="warn"><strong>Please do NOT enter passwords, API keys, card numbers, or your EIN anywhere on this form.</strong> We never ask for them here. We do need your EIN separately for SMS carrier registration — call us with it or send it in a direct email.</div>
<form method="POST" action="">
${fields}
<button type="submit">Submit to LeadRider</button>
</form>
<div class="foot">This private link was sent to ${dealer} by LeadRider. Questions? Just reply to the email that brought you here.</div>
</div></body></html>`;
}

// Missing-info follow-up (Joe 8/17): when an ingest leaves blanks, setup@ chases the DEALER
// automatically — each owed item with the WHY (the form's own hint text) and the form link.
// Loop-safe: never re-sent while the owed list is unchanged (a "thanks!" reply that answers
// nothing must not trigger the same nag again).
export function buildMissingInfoFollowUpEmail(
  setup: Pick<DealerSetup, "dealerName" | "primaryContact">,
  blanks: string[],
  formUrl?: string
): { subject: string; bodyText: string } {
  const contact = String(setup.primaryContact ?? "").trim();
  const firstName = contact ? contact.split(/[\s,<(]/)[0] : "";
  const items = blanks.map(label => {
    const field = FORM_FIELDS.find(f => f.label === label);
    return field?.hint ? `- ${label}\n    (${field.hint})` : `- ${label}`;
  });
  const bodyText = [
    `Hi ${firstName || "there"},`,
    "",
    `Thanks — we got your setup answers for ${setup.dealerName}. Just ${blanks.length === 1 ? "one thing" : `${blanks.length} things`} still missing:`,
    "",
    ...items,
    "",
    formUrl
      ? `Easiest fix: open your setup form and fill in just those — everything you already answered is saved:\n\n    ${formUrl}\n\nOr simply reply to this email with the answers.`
      : "Just reply to this email with the answers.",
    "",
    "As always: no passwords, API keys, card numbers, or your EIN by email or form.",
    "",
    "Thanks!",
    "The LeadRider team"
  ].join("\n");
  return { subject: `${setup.dealerName} setup — ${blanks.length === 1 ? "one item" : "a few items"} still needed`, bodyText };
}

async function maybeSendMissingInfoFollowUp(
  invite: DealerIntakeMailRecord,
  setup: DealerSetup,
  blanks: string[]
): Promise<boolean> {
  if (!isDealerIntakeEmailEnabled() || !blanks.length) return false;
  const last = invite.lastFollowUpBlanks ?? [];
  if (last.length === blanks.length && last.every((b, i) => b === blanks[i])) return false;
  const formUrl = invite.formToken
    ? `${String(process.env.LEADRIDER_API_BASE_URL ?? "https://api.leadrider.ai").replace(/\/$/, "")}/public/dealer-intake/${invite.formToken}`
    : undefined;
  const { subject, bodyText } = buildMissingInfoFollowUpEmail(setup, blanks, formUrl);
  await sendSetupGmailEmail({ to: invite.to, subject, bodyText });
  invite.followUpSentAt = new Date().toISOString();
  invite.lastFollowUpBlanks = blanks;
  scheduleSave();
  console.log(`[dealer intake] missing-info follow-up sent to ${invite.to} (${blanks.length} item(s))`);
  return true;
}

// A blank in these fields is normal, not something the dealer "owes" — everything else
// blank goes into the still-owed list the console task and intake step report.
const OPTIONAL_FORM_FIELDS = new Set<string>([
  "extraNotes", "dbaName", "dnsManager", "googleBusinessProfile", "socialMedia", "privacyPolicyUrl",
  "creditAppUrl", "offersUrl"
]);

// Deterministic mapping of the LABELED form fields — no LLM needed: the form itself
// disambiguates which answer is which. Free-text values stay verbatim.
export function parseIntakeFormSubmission(body: Record<string, unknown>): DealerIntakeAnswers {
  const text = (name: string) => String((body as any)?.[name] ?? "").trim().slice(0, 2000);
  const lines = (name: string) => text(name).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const salespeople = lines("salespeople").map(line => {
    // Split on the FIRST separator only — phone numbers contain their own hyphens.
    const sep = line.match(/\s[-–—:]\s|[–—:]/);
    if (sep && sep.index !== undefined) {
      return { name: line.slice(0, sep.index).trim(), cell: line.slice(sep.index + sep[0].length).trim() };
    }
    return { name: line, cell: "" };
  });
  const answers: DealerIntakeAnswers = {
    legalName: text("legalName"),
    dbaName: text("dbaName"),
    address: text("address"),
    website: text("website"),
    mainPhone: text("mainPhone"),
    primaryContact: text("primaryContact"),
    ownerGm: text("ownerGm"),
    salespeople,
    messageApprover: text("messageApprover"),
    afterHoursEscalation: text("afterHoursEscalation"),
    salesHours: text("salesHours"),
    serviceHours: text("serviceHours"),
    closures: text("closures"),
    crmProvider: text("crmProvider"),
    monthlyLeadVolume: text("monthlyLeadVolume"),
    leadSources: lines("leadSources"),
    leadNotificationDestination: text("leadNotificationDestination"),
    inventoryFeedUrl: text("inventoryFeedUrl"),
    inventoryFeedOwner: text("inventoryFeedOwner"),
    taxRate: text("taxRate"),
    creditAppUrl: text("creditAppUrl"),
    offersUrl: text("offersUrl"),
    crmLoginWillingness: text("crmLoginWillingness"),
    websiteProvider: text("websiteProvider"),
    websiteProviderEmail: text("websiteProviderEmail"),
    dnsManager: text("dnsManager"),
    emailHostProvider: text("emailHostProvider"),
    googleBusinessProfile: text("googleBusinessProfile"),
    socialMedia: lines("socialMedia"),
    consoleUsers: lines("consoleUsers"),
    outboundEmailIdentity: text("outboundEmailIdentity"),
    calendarGoogleAccount: text("calendarGoogleAccount"),
    privacyPolicyUrl: text("privacyPolicyUrl"),
    tonePreferences: text("tonePreferences"),
    neverSay: lines("neverSay"),
    unansweredQuestions: FORM_FIELDS.filter(f => !OPTIONAL_FORM_FIELDS.has(f.name) && !text(f.name)).map(f => f.label),
    extraNotes: text("extraNotes"),
    sensitiveDataWarning: ""
  };
  // Deterministic compliance gate: detect a leaked EIN/card BEFORE scrubbing so the
  // warning survives even though the value never does.
  const flat = JSON.stringify(answers);
  if (/\b\d{2}-\d{7}\b/.test(flat) || /\b(?:\d[ -]?){13,16}\b/.test(flat.replace(/\b\d{10,11}\b/g, ""))) {
    answers.sensitiveDataWarning = "The form submission contained what looks like an EIN or card number; the value was redacted and NOT stored.";
  }
  return scrubDeep(answers);
}

const FORM_TOKEN_SHAPE = /^[a-f0-9]{24,64}$/;

export async function findIntakeRecordByFormToken(token: string): Promise<DealerIntakeMailRecord | null> {
  if (!FORM_TOKEN_SHAPE.test(String(token ?? ""))) return null;
  await ensureLoaded();
  return rows.find(row => row.formToken === token) ?? null;
}

const FORM_CLOSED_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font:16px -apple-system,sans-serif;padding:40px;max-width:560px;margin:0 auto"><h2>This setup link isn't active</h2><p>It may have been mistyped or replaced. Reply to the LeadRider email that brought you here and we'll send a fresh one.</p></body>`;

export async function dealerIntakeFormPageHandler(req: any, res: any) {
  const record = await findIntakeRecordByFormToken(String(req.params?.token ?? ""));
  const setup = record ? await getDealerSetup(record.dealerSetupId) : null;
  if (!record || !setup) return res.status(404).type("html").send(FORM_CLOSED_HTML);
  return res.type("html").send(renderIntakeFormHtml(setup));
}

export async function dealerIntakeFormSubmitHandler(req: any, res: any) {
  const record = await findIntakeRecordByFormToken(String(req.params?.token ?? ""));
  const setup = record ? await getDealerSetup(record.dealerSetupId) : null;
  if (!record || !setup) return res.status(404).type("html").send(FORM_CLOSED_HTML);
  const answers = parseIntakeFormSubmission(req.body ?? {});
  const label = `intake form ${new Date().toISOString().slice(0, 10)}`;
  const applied = applyIntakeAnswersToSetup(setup, answers, label);
  await updateDealerSetup(setup.id, { ...applied.patch, stepId: "intake", stepStatus: applied.stepStatus, stepNote: applied.stepNote });
  record.formSubmittedAt = new Date().toISOString();
  record.status = "ingested";
  record.lastIngestAt = record.formSubmittedAt;
  record.lastBlanks = applied.blanks;
  record.lastSensitiveWarning = String(answers.sensitiveDataWarning ?? "").trim() || undefined;
  record.updatedAt = record.formSubmittedAt;
  scheduleSave();
  const followUpSent = await maybeSendMissingInfoFollowUp(record, setup, applied.blanks).catch(() => false);
  await addAgentTask({
    provider: "claude",
    kind: "dealer_setup",
    title: `Intake form submitted: ${setup.dealerName}`,
    instructions: [
      `Dealer intake FORM submitted for ${setup.dealerName} [${setup.slug}].`,
      applied.diffs.length ? `Changes: ${applied.diffs.join("; ")}` : "No record changes (already matched).",
      applied.blanks.length
        ? `Left blank: ${applied.blanks.join("; ")}${followUpSent ? " — follow-up email sent to the dealer." : ""}`
        : "Fully answered.",
      record.lastSensitiveWarning ? `SENSITIVE DATA flagged (NOT stored): ${record.lastSensitiveWarning}` : ""
    ].filter(Boolean).join("\n"),
    clientName: setup.dealerName,
    priority: record.lastSensitiveWarning ? "high" : "normal",
    risk: "low"
  });
  console.log(`[dealer intake] form submitted for ${setup.slug} (${applied.diffs.length} changes, ${applied.blanks.length} blanks)`);
  return res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font:16px -apple-system,sans-serif;padding:40px;max-width:560px;margin:0 auto"><div style="height:6px;background:#fb7f04;border-radius:3px"></div><h2>Thanks — got it!</h2><p>Your answers are saved with LeadRider. ${applied.blanks.length ? "We'll follow up on the few items left blank — no need to resubmit." : "Everything we need is here."} We'll be in touch with next steps.</p></body>`);
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
      const followUpSent = await maybeSendMissingInfoFollowUp(invite, setup, applied.blanks).catch(() => false);
      const summaryLines = [
        `Dealer intake reply from ${invite.to} ingested for ${setup.dealerName} [${setup.slug}].`,
        applied.diffs.length ? `Changes: ${applied.diffs.join("; ")}` : "No record changes (already matched).",
        applied.blanks.length
          ? `Still owed: ${applied.blanks.join("; ")}${followUpSent ? " — follow-up email sent to the dealer." : ""}`
          : "Fully answered.",
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
