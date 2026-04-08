type ConversationMessageLike = {
  direction?: "in" | "out" | string;
  provider?: string | null;
  body?: string | null;
  at?: string | null;
  from?: string | null;
  to?: string | null;
  providerMessageId?: string | null;
};

type PickArgs = {
  messages: ConversationMessageLike[];
  latestDraftAt?: string | null;
};

export type RegenerateInboundPick = {
  inbound: ConversationMessageLike | null;
  latestInboundBeforeDraft: ConversationMessageLike | null;
  latestInboundIsCreditAdf: boolean;
  latestInboundIsDlaNoPurchaseAdf: boolean;
};

const REGEN_ACTIONABLE_SIGNAL_REGEX =
  /\?|(?:\bwhat|\bhow|\bwhen|\bwhere|\bwhich|\bwho|\bdo you\b|\bcan you\b|\bcould you\b|\bare there\b|\bany\b|\bprice\b|\bpricing\b|\bpayment\b|\bpayments\b|\bapr\b|\brate\b|\brates\b|\bavailable\b|\bin stock\b|\binventory\b|\bbike\b|\bbikes\b|\bmodel\b|\btrade\b|\bappointment\b|\bschedule\b|\bcome in\b|\btest ride\b|\bwarranty\b|\bspecial\b|\bdeal\b|\bdeals\b)/i;
const REGEN_LOW_SIGNAL_FOLLOWUP_REGEX =
  /^(?:\s*(?:ok(?:ay)?|k|kk|got it|sounds good|perfect|cool|thanks?|thank you|thx|ty|lol|haha|lmao|yall could hire me\b).*)$/i;

function toMs(value: string | null | undefined): number {
  return new Date(value ?? "").getTime();
}

function isLikelyActionableInbound(text: string): boolean {
  return REGEN_ACTIONABLE_SIGNAL_REGEX.test(String(text ?? ""));
}

function isLikelyLowSignalFollowup(text: string): boolean {
  const value = String(text ?? "").trim();
  if (!value) return true;
  if (isLikelyActionableInbound(value)) return false;
  if (REGEN_LOW_SIGNAL_FOLLOWUP_REGEX.test(value)) return true;
  if (value.length <= 60) return true;
  return false;
}

function isCreditAdfBody(text: string): boolean {
  const lower = String(text ?? "").toLowerCase();
  return (
    /source:\s*(hdfs coa online|credit app)/.test(lower) ||
    /\b(credit app|credit application)\b/.test(lower)
  );
}

function isDlaNoPurchaseAdfBody(text: string): boolean {
  const lower = String(text ?? "").toLowerCase();
  return (
    /source:\s*dealer lead app/.test(lower) &&
    /purchase timeframe:\s*i am not interested in purchasing at this time|not interested in purchasing at this time/.test(
      lower
    )
  );
}

export function pickRegenerateInbound(args: PickArgs): RegenerateInboundPick {
  const inboundMessages = [...(args.messages ?? [])]
    .reverse()
    .filter(m => m.direction === "in");
  const latestDraftAtMs = new Date(args.latestDraftAt ?? "").getTime();
  const isBeforeDraft = (m: ConversationMessageLike) => {
    if (!Number.isFinite(latestDraftAtMs)) return true;
    const msgAt = new Date(m.at ?? "").getTime();
    return !Number.isFinite(msgAt) || msgAt <= latestDraftAtMs;
  };
  const latestInboundBeforeDraft =
    inboundMessages.find(m => m.body && isBeforeDraft(m)) ??
    inboundMessages.find(m => m.body) ??
    null;
  const latestInboundBodyLower = String(latestInboundBeforeDraft?.body ?? "").toLowerCase();
  const latestInboundIsCreditAdf =
    latestInboundBeforeDraft?.provider === "sendgrid_adf" && isCreditAdfBody(latestInboundBodyLower);
  const latestInboundIsDlaNoPurchaseAdf =
    latestInboundBeforeDraft?.provider === "sendgrid_adf" &&
    isDlaNoPurchaseAdfBody(latestInboundBodyLower);
  let inbound =
    (latestInboundIsCreditAdf || latestInboundIsDlaNoPurchaseAdf ? latestInboundBeforeDraft : null) ??
    inboundMessages.find(m => m.provider !== "sendgrid_adf" && m.body && isBeforeDraft(m)) ??
    inboundMessages.find(m => m.body && isBeforeDraft(m)) ??
    inboundMessages.find(m => m.provider !== "sendgrid_adf" && m.body) ??
    inboundMessages.find(m => m.body) ??
    null;

  const inboundChronological = (args.messages ?? [])
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.direction === "in" && !!m.body && isBeforeDraft(m))
    .sort((a, b) => {
      const aMs = toMs(a.m.at);
      const bMs = toMs(b.m.at);
      if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
      return a.index - b.index;
    })
    .map(entry => entry.m);
  const latestInboundInBurst =
    inboundChronological.length > 0 ? inboundChronological[inboundChronological.length - 1] : null;
  if (inbound && latestInboundInBurst && inbound === latestInboundInBurst) {
    const latestBody = String(latestInboundInBurst.body ?? "");
    if (isLikelyLowSignalFollowup(latestBody)) {
      const latestMs = toMs(latestInboundInBurst.at);
      const burstPrior = inboundChronological
        .slice(0, -1)
        .filter(m => {
          if (!Number.isFinite(latestMs)) return true;
          const ms = toMs(m.at);
          return !Number.isFinite(ms) || latestMs - ms <= 5 * 60 * 1000;
        });
      const priorActionable = [...burstPrior]
        .reverse()
        .find(m => isLikelyActionableInbound(String(m.body ?? "")));
      if (priorActionable) inbound = priorActionable;
    }
  }
  return {
    inbound,
    latestInboundBeforeDraft,
    latestInboundIsCreditAdf,
    latestInboundIsDlaNoPurchaseAdf
  };
}
