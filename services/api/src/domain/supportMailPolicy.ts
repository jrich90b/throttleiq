export type SupportMailPolicyMessage = {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  date?: string;
};

function compact(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lowerText(value?: string) {
  return compact(value).toLowerCase();
}

function minutesSinceMailDate(dateValue?: string) {
  const ts = Date.parse(String(dateValue ?? ""));
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return (Date.now() - ts) / 60000;
}

function supportMailPolicyText(message: SupportMailPolicyMessage) {
  return [
    lowerText(message.from),
    lowerText(message.subject),
    lowerText(message.snippet)
  ].join("\n");
}

export function hasSupportMailProtectedSignal(textValue: string) {
  const text = lowerText(textValue);
  return /\b(billing|invoice|payment|receipt|refund|charge|security alert|password|suspicious|sign[- ]in|login|legal|contract|agreement|domain|dns|dmarc|dkim|spf|api key|oauth|outage|down|failed|failure|error|urgent|support ticket|customer|dealer|client|lead|twilio|sendgrid|webhook|integration|production|can't log in|cannot log in)\b/.test(
    text
  );
}

export function classifySupportMailAutoTrash(message: SupportMailPolicyMessage) {
  const from = lowerText(message.from);
  const text = supportMailPolicyText(message);
  if (!text.trim()) return "";
  if (hasSupportMailProtectedSignal(text)) return "";

  const noReply = /\b(no-?reply|notify-noreply|workspace-noreply|noreply|notifications?)\b/.test(from);
  const expiredCode =
    /\b(your code is|verification code|one[- ]time code|otp|security code|passcode)\b/.test(text) &&
    minutesSinceMailDate(message.date) > 30;
  if (expiredCode && (noReply || from.includes("docusign") || from.includes("google"))) {
    return "expired automated one-time code";
  }

  if (
    from.includes("@google.com") &&
    /\b(google workspace|google cloud organization|workspace trial|google workspace trial|referring google workspace)\b/.test(text) &&
    /\b(recommendations?|save time|boost productivity|explore|trial|tips?|getting started|offers professional email|referring)\b/.test(text)
  ) {
    return "Google Workspace promotional/onboarding email";
  }

  if (
    noReply &&
    /\b(boost productivity|newsletter|unsubscribe|webinar|trial tips?|product update|new features?|getting started|start building|save time|explore your trial|recommendations?)\b/.test(
      text
    )
  ) {
    return "obvious no-reply promo or onboarding email";
  }

  return "";
}

export function isSupportMailSummarySafeToAutoTrash(summary: string, context = "") {
  if (!/\bclassification:\s*non_support\b/i.test(summary)) return false;
  const contextSignals = context
    .split(/\r?\n/)
    .filter(line => /^(from|subject|snippet|date|thread id):/i.test(line.trim()))
    .join("\n");
  const text = `${summary}\n${contextSignals}`;
  if (hasSupportMailProtectedSignal(text)) return false;
  return /\b(promo|promotional|marketing|newsletter|unsubscribe|webinar|trial|onboarding|product tip|product update|no[- ]reply|automated notice|workspace recommendation|google workspace|expired.*code|verification code|one[- ]time code)\b/i.test(
    text
  );
}

export function buildSupportMailReviewInstructions(message: SupportMailPolicyMessage, note?: string) {
  return [
    "Review this support Gmail message and draft a reply for approval.",
    "First line must be: Classification: support_ticket, non_support, or unclear.",
    "Use non_support only for obvious low-value mail: automated promotions, newsletters, expired one-time codes, no-reply onboarding/product tips, or unrelated bulk vendor notices.",
    "Do not use non_support for billing, invoices, payments, security/login, domains/DNS, contracts, API/integration failures, outages, dealer/client/user support, or anything uncertain.",
    "Do not send the reply. Create a concise recommended response and note whether a Codex/code task is needed.",
    note ? `Review note: ${note}` : "",
    `Gmail message ID: ${compact(message.id)}`,
    message.threadId ? `Thread ID: ${compact(message.threadId)}` : "",
    `From: ${compact(message.from)}`,
    `Subject: ${compact(message.subject)}`,
    message.date ? `Date: ${compact(message.date)}` : "",
    message.snippet ? `Snippet: ${compact(message.snippet)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
