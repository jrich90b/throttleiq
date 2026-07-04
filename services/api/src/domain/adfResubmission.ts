// ADF form re-submission detection (Jerill White, +14354061493, open-critic
// repeated_generic_reply_no_engagement, Joe-approved 2026-07-02): the same lead submitting the
// SAME web form again (identical structured fields — only the CRM Ref/message id changes) was
// answered with the same generic first-touch every time. Three submissions in three minutes got
// three near-identical "I got your inquiry" drafts and no human attention.
//
// Detection is a STRUCTURED-FIELD comparison (Source / Vehicle / Stock / VIN / normalized
// Inquiry) between the incoming ADF body and prior `sendgrid_adf` inbounds on the same
// conversation — never free-text comprehension. Fail-direction: any field difference (a new
// inquiry text, a different vehicle) means NOT a re-submission and the full pipeline runs; a
// false negative just reproduces today's duplicate ack.
export type AdfStructuredFields = {
  source: string;
  vehicle: string;
  stock: string;
  vin: string;
  inquiry: string;
};

export function extractAdfStructuredFields(body: string | null | undefined): AdfStructuredFields | null {
  const text = String(body ?? "");
  if (!/web lead\s*\(adf\)/i.test(text)) return null;
  const line = (label: string) =>
    String(text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "im"))?.[1] ?? "")
      .trim()
      .toLowerCase();
  // Inquiry = everything after the "Inquiry:" header, with the volatile CRM Ref stripped and
  // whitespace normalized — the customer's actual free-text payload, compared byte-for-byte.
  const inqIdx = text.toLowerCase().lastIndexOf("inquiry:");
  const inquiry =
    inqIdx >= 0
      ? text
          .slice(inqIdx + "inquiry:".length)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
      : "";
  return {
    source: line("Source"),
    vehicle: line("Vehicle"),
    stock: line("Stock"),
    vin: line("VIN"),
    inquiry
  };
}

export type AdfResubmissionResult = {
  resubmission: boolean;
  priorCount: number;
  hoursSinceLastOutbound: number | null;
  source: string;
};

export function detectAdfFormResubmission(args: {
  messages: Array<{ direction?: string | null; provider?: string | null; body?: string | null; at?: string | null }> | null | undefined;
  newBody: string | null | undefined;
  nowMs: number;
  windowDays?: number;
}): AdfResubmissionResult {
  const none: AdfResubmissionResult = { resubmission: false, priorCount: 0, hoursSinceLastOutbound: null, source: "" };
  const fields = extractAdfStructuredFields(args.newBody);
  if (!fields) return none;
  const messages = Array.isArray(args.messages) ? args.messages : [];
  const windowMs = (args.windowDays ?? 30) * 24 * 60 * 60 * 1000;

  let priorCount = 0;
  let sawOutboundAfterPrior = false;
  let matchedPrior = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.direction !== "in" || String(m?.provider ?? "").toLowerCase() !== "sendgrid_adf") continue;
    const atMs = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(atMs) && args.nowMs - atMs > windowMs) continue; // outside window
    const prior = extractAdfStructuredFields(m?.body);
    if (!prior) continue;
    if (
      prior.source === fields.source &&
      prior.vehicle === fields.vehicle &&
      prior.stock === fields.stock &&
      prior.vin === fields.vin &&
      prior.inquiry === fields.inquiry
    ) {
      matchedPrior = true;
      priorCount += 1;
      // an outbound AFTER this prior submission = we already acknowledged this exact form once
      if (messages.slice(i + 1).some(x => x?.direction === "out")) sawOutboundAfterPrior = true;
    }
  }
  if (!matchedPrior || !sawOutboundAfterPrior) return none;

  const lastOut = [...messages].reverse().find(m => m?.direction === "out");
  const lastOutMs = Date.parse(String(lastOut?.at ?? ""));
  const hoursSinceLastOutbound = Number.isFinite(lastOutMs) ? (args.nowMs - lastOutMs) / (60 * 60 * 1000) : null;
  return { resubmission: true, priorCount, hoursSinceLastOutbound, source: fields.source };
}

// One short re-inquiry ack for a re-submission that arrives AFTER the previous ack already went
// out a while ago — references the existing thread instead of restarting the script. Deliberately
// carries NO availability claim, appointment push, or vehicle-fact assertion.
export function buildAdfResubmissionAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  const name = String(firstName ?? "").trim();
  const greeting = name ? `Hey ${name}, ` : "Hey, ";
  return (
    `${greeting}it's ${agentName} over at ${dealerName} again. I saw your request come through another time — ` +
    "you're on our list and I'm making sure the team gets to you. Anything specific you'd like me to check on in the meantime?"
  );
}
