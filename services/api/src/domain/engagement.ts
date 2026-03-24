import type { Conversation } from "./conversationStore.js";
import type { InboundMessageEvent } from "./types.js";

type EngagementSource = "sms" | "email" | "call";

const NEGATIVE_INTENT = /(not interested|not ready|no thanks|no thank you|stop texting|unsubscribe|do not contact|don't contact|do not call|no longer interested|just browsing|just looking|maybe later|not right now|someday|dream)\b/i;

const STRONG_INTEREST_PATTERNS: Array<{ key: string; re: RegExp }> = [
  {
    key: "purchase",
    re: /\b(buy|purchase|ready to buy|ready to purchase|interested in|want to|looking for|check out)\b/i
  },
  {
    key: "schedule",
    re: /\b(appointment|schedule|set (a )?time|book|reserve|come in|stop in|stop by|visit|test ride|demo ride)\b/i
  },
  {
    key: "trade",
    re: /\b(trade[- ]?in|trade in|appraisal|sell my bike|sell (my )?bike|cash offer)\b/i
  },
  {
    key: "finance",
    re: /\b(finance|financing|payment|apr|pre[- ]?qual|credit|approval|down payment|monthly)\b/i
  },
  {
    key: "pricing",
    re: /\b(price|pricing|msrp|otd|out[- ]?the[- ]?door|how much)\b/i
  },
  {
    key: "availability",
    re: /\b(available|in stock|do you have)\b/i
  }
];

function hasStrongInterest(text: string): { ok: boolean; reason?: string } {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false };
  if (NEGATIVE_INTENT.test(t)) return { ok: false };
  for (const entry of STRONG_INTEREST_PATTERNS) {
    if (entry.re.test(t)) return { ok: true, reason: entry.key };
  }
  return { ok: false };
}

function hasMultipleSpeakers(transcript: string): boolean {
  const lines = transcript
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const speakers = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _.-]{1,40}):/);
    if (match) speakers.add(match[1].toLowerCase());
  }
  return speakers.size >= 2;
}

function markEngaged(
  conv: Conversation,
  source: EngagementSource,
  reason?: string,
  messageId?: string
) {
  if (conv.engagement?.at) return;
  conv.engagement = {
    at: new Date().toISOString(),
    source,
    reason,
    messageId
  };
}

export function maybeMarkEngagedFromInbound(conv: Conversation, evt: InboundMessageEvent) {
  if (conv.engagement?.at) return;
  if (!evt?.body) return;
  if (evt.provider === "sendgrid_adf" || evt.provider === "debug") return;
  const { ok, reason } = hasStrongInterest(evt.body);
  if (!ok) return;
  const source: EngagementSource = evt.channel === "email" ? "email" : "sms";
  markEngaged(conv, source, reason, evt.providerMessageId);
}

export function maybeMarkEngagedFromCall(
  conv: Conversation,
  transcript: string,
  opts?: { isVoicemail?: boolean; messageId?: string }
) {
  if (conv.engagement?.at) return;
  if (!transcript?.trim()) return;
  if (opts?.isVoicemail) return;
  if (!hasMultipleSpeakers(transcript)) return;
  const { ok, reason } = hasStrongInterest(transcript);
  if (!ok) return;
  markEngaged(conv, "call", reason, opts?.messageId);
}

export function isLikelyVoicemailTranscript(text: string): boolean {
  const raw = String(text ?? "");
  const t = raw.toLowerCase();
  if (!t.trim()) return true;
  const vmRe =
    /voicemail|voice mail|mailbox|leave (a )?message|after the (tone|beep)|at the (tone|beep)|please leave|not available|unable to (answer|take your call)|your call has been forwarded|record your message|sorry we (missed|couldn't take) your call/;
  const lines = raw
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const customerLines = lines
    .filter(line => /^customer:/i.test(line))
    .map(line => line.replace(/^customer:\s*/i, "").trim().toLowerCase())
    .filter(Boolean);
  const hasNonVoicemailCustomer = customerLines.some(line => !vmRe.test(line));
  if (hasNonVoicemailCustomer) return false;
  return vmRe.test(t);
}
