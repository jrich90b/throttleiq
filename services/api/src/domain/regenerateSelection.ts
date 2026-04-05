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
  const inbound =
    (latestInboundIsCreditAdf || latestInboundIsDlaNoPurchaseAdf ? latestInboundBeforeDraft : null) ??
    inboundMessages.find(m => m.provider !== "sendgrid_adf" && m.body && isBeforeDraft(m)) ??
    inboundMessages.find(m => m.body && isBeforeDraft(m)) ??
    inboundMessages.find(m => m.provider !== "sendgrid_adf" && m.body) ??
    inboundMessages.find(m => m.body) ??
    null;
  return {
    inbound,
    latestInboundBeforeDraft,
    latestInboundIsCreditAdf,
    latestInboundIsDlaNoPurchaseAdf
  };
}
