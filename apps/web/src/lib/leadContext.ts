/**
 * "What the agent knows" — the context a rep needs in front of them BEFORE they type.
 *
 * WHY THIS EXISTS (measured 2026-08-02). Over 45 days, 45% of everything customers received was
 * typed by a person, and 32% of ALL outbound never touched a draft at all — the rep composed from
 * scratch. The product assumes agent-drafts / staff-approves, so every feature built on the draft
 * loop has a blind spot covering a third of customer contact.
 *
 * The concrete cost: Dennis Daffron (+16303628805) arrived on a Room58 ADF naming a 2024 Street
 * Glide, stock U902-24. The agent opened correctly — "Thanks for your inquiry about the 2024 Street
 * Glide." Thirteen hours later a rep texted him from a phone: "reaching out to see what bike you
 * were inquiring about?" Dennis answered "Im only interested in the bike I inquired about." The
 * bike was on the lead card the whole time; it just wasn't in front of the person typing.
 *
 * These are PURE readers over data the conversation payload already carries — no new endpoint, no
 * new state, and nothing here can change what gets sent. Every one returns null when it cannot say
 * something specific, and a null simply renders nothing: the strip can be silent, never wrong.
 *
 * NOTE ON THE QUOTE READER: it scans OUR OWN outbound copy for a figure we already told the
 * customer. That is structured extraction from dealer text for a display hint — not comprehension
 * of customer intent, which stays with the typed parsers (AGENTS.md).
 */

export type LeadVehicleLike = {
  year?: string | number | null;
  model?: string | null;
  description?: string | null;
  stockId?: string | null;
  condition?: string | null;
} | null | undefined;

export type LeadLike = { vehicle?: LeadVehicleLike } | null | undefined;

export type ContextMessage = {
  direction: "in" | "out";
  body?: string | null;
  at?: string | null;
  /** Unsent drafts are not something the customer has seen — they never count as a reply. */
  provider?: string | null;
  draftStatus?: string | null;
};

/** Did the customer actually receive this outbound? A draft sitting in the box has not been seen. */
export function isDeliveredOutbound(m: ContextMessage): boolean {
  if (m.direction !== "out") return false;
  if (m.draftStatus === "pending" || m.draftStatus === "stale") return false;
  return String(m.provider ?? "") !== "draft_ai";
}

/**
 * "2024 Street Glide · U902-24" — the unit this lead is actually about. Null when the lead carries
 * no usable vehicle, so the row disappears rather than rendering a bare stock number or "undefined".
 */
export function formatLeadBikeLabel(lead: LeadLike): string | null {
  const v = lead?.vehicle;
  if (!v) return null;
  const year = String(v.year ?? "").trim();
  const model = String(v.model ?? v.description ?? "").trim();
  const stock = String(v.stockId ?? "").trim();
  const name = [year, model].filter(Boolean).join(" ").trim();
  // A stock number alone is not something a rep can say out loud to a customer.
  if (!name) return null;
  return stock ? `${name} · ${stock}` : name;
}

/** A money figure ($22,995 / $22995.00) as it appeared. Deliberately not parsed into a number. */
const MONEY = /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d{3,}(?:\.\d{2})?/;

export type LastQuote = { amount: string; at: string | null };

/**
 * The most recent price WE quoted this customer. Dennis was told "$22,995" by a rep on 7/23 and
 * asked ten days later "What bike was this again for 22995" — the figure and the bike lived in two
 * different heads. Scans delivered dealer messages newest-first; null when we never quoted one.
 */
export function findLastDealerQuote(messages: ContextMessage[] | null | undefined): LastQuote | null {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!isDeliveredOutbound(m)) continue;
    const hit = MONEY.exec(String(m.body ?? ""));
    if (hit) return { amount: hit[0].replace(/\s+/g, ""), at: m.at ?? null };
  }
  return null;
}

export type OpenQuestion = { text: string; at: string | null };

/**
 * The customer's last question that nobody has answered yet — i.e. no delivered outbound came
 * after it. This is the "they are waiting on you" line, and it is the one a rep most often misses
 * when they open a thread cold.
 *
 * Deliberately conservative: it requires a literal question mark. A statement that implies a
 * question is a comprehension judgement, and getting that wrong would put words in the customer's
 * mouth on the rep's screen. Fail direction: show nothing rather than a guess.
 */
export function findOpenCustomerQuestion(
  messages: ContextMessage[] | null | undefined
): OpenQuestion | null {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    // A delivered reply closes the loop — anything before it is no longer outstanding.
    if (isDeliveredOutbound(m)) return null;
    if (m.direction !== "in") continue;
    const body = String(m.body ?? "").trim();
    if (!body.includes("?")) continue;
    // ADF / web-form payloads and call transcripts are not the customer asking us something.
    if (/^web lead|^web text widget|^customer:|^agent:/i.test(body)) return null;
    return { text: body, at: m.at ?? null };
  }
  return null;
}

export type RepLeadContext = {
  bike: string | null;
  lastQuote: LastQuote | null;
  openQuestion: OpenQuestion | null;
  /** False when there is nothing specific to say — the caller renders nothing at all. */
  hasAnything: boolean;
};

export function buildRepLeadContext(
  lead: LeadLike,
  messages: ContextMessage[] | null | undefined
): RepLeadContext {
  const bike = formatLeadBikeLabel(lead);
  const lastQuote = findLastDealerQuote(messages);
  const openQuestion = findOpenCustomerQuestion(messages);
  return { bike, lastQuote, openQuestion, hasAnything: !!(bike || lastQuote || openQuestion) };
}
