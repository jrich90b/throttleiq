/**
 * THE OPEN CUSTOMER TURN — every customer message still waiting on an answer.
 *
 * WHY THIS EXISTS (Joe, operator-reported 2026-08-04): *"If the customer asks multiple questions
 * before the draft is sent, it won't answer previous questions."* Both draft paths reduced the
 * customer's turn to ONE message — the live webhook composes against `event.body`, regenerate and
 * the thumbs-down re-draft against the LAST inbound. Anything the customer said before that got
 * demoted into background history, where the composer reads it as thread colour rather than as an
 * open question. Measured on the live store: of the multi-message customer turns since 2026-07-01
 * that the agent answered, the reply routinely addressed only the newest message —
 *   • `+17163390288` "Photos, service history, any known mods/upgrades from stock?" then "More than
 *     what's listed on the site" -> "I'll have the team check service records (battery/tires)":
 *     photos and mods dropped.
 *   • `+17163591526` "do you have any pictures of the road king?" then a credit-application ADF ->
 *     a pure credit-app acknowledgement: the photo request dropped.
 *   • `+17166035402` "can you deliver my bike to my house?" -> "I'll check where everything stands
 *     on the remaining parts": the delivery question dropped.
 *
 * WHAT CLOSES A TURN — only an outbound the customer ACTUALLY RECEIVED. This is the crux of Joe's
 * framing ("before the draft is sent"): a pending `draft_ai` row is a PROPOSAL, not an answer, so
 * it must not close the turn. Two messages arriving either side of an unsent draft are still ONE
 * unanswered turn. `CUSTOMER_FACING_OUTBOUND_PROVIDERS` (agentVoice.ts) is the existing referee for
 * "did this reach them"; a delivered `voice_call` also closes the turn, because a rep who phoned
 * them may well have answered by voice and we would rather under-collect than re-ask.
 *
 * DETERMINISTIC ON PURPOSE, and allowed to be. This is message SELECTION (structured extraction —
 * AGENTS.md's deterministic carve-out), not comprehension. Nothing here decides what the customer
 * MEANT or what to say back; it hands the composer the full text of the open turn and the typed
 * parsers keep every comprehension job they already had.
 *
 * FAIL DIRECTION — over-collecting shows the composer MORE of what the customer said, so the worst
 * case is a reply that addresses a question we would otherwise have ignored. Under-collecting
 * degrades exactly to today's behaviour (the newest message alone). It can never produce silence,
 * and it never invents a customer turn: an empty result falls back to the caller's own inbound.
 */

/** Only what this module reads — deliberately structural, so both call paths can pass raw rows. */
export type OpenTurnMessage = {
  direction?: string | null;
  provider?: string | null;
  delivered?: boolean | null;
  body?: string | null;
  at?: string | null;
};

/**
 * Outbounds the customer actually received. Mirrors `CUSTOMER_FACING_OUTBOUND_PROVIDERS`
 * (agentVoice.ts) and adds `voice_call`: a placed call is real contact with the customer, so it
 * closes the turn. `voice_summary` / `voice_transcript` are our own NOTES about that call, not
 * messages, and must not close anything on their own.
 */
const TURN_CLOSING_OUTBOUND_PROVIDERS = new Set([
  "twilio",
  "sendgrid",
  "human",
  "web_widget",
  "voice_call"
]);

/** Our own notes about a call — never a customer message in either direction. */
const NOTE_ONLY_PROVIDERS = new Set(["voice_summary", "voice_transcript"]);

/** Prompt guards. Both keep the NEWEST messages, so trimming degrades toward today's behaviour. */
export const OPEN_TURN_MAX_MESSAGES = 6;
export const OPEN_TURN_MAX_CHARS = 2000;

function isNoteOnly(msg: OpenTurnMessage | null | undefined): boolean {
  return NOTE_ONLY_PROVIDERS.has(String(msg?.provider ?? ""));
}

/** Did this outbound reach the customer? An unsent `draft_ai` proposal never does. */
function closesTheTurn(msg: OpenTurnMessage | null | undefined): boolean {
  if (msg?.direction !== "out") return false;
  if (isNoteOnly(msg)) return false;
  return TURN_CLOSING_OUTBOUND_PROVIDERS.has(String(msg?.provider ?? "")) && msg?.delivered !== false;
}

/**
 * The trailing run of customer messages that arrived after the last outbound they received —
 * oldest first, so the composer reads the turn in the order the customer said it.
 */
export function collectOpenCustomerTurn(
  messages: ReadonlyArray<OpenTurnMessage | null | undefined> | null | undefined
): OpenTurnMessage[] {
  if (!Array.isArray(messages)) return [];
  const run: OpenTurnMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (closesTheTurn(msg)) break;
    // An unsent draft, a voice note, or any other non-delivered outbound is transparent here:
    // it neither closes the turn nor belongs to it. Keep walking back.
    if (msg.direction !== "in") continue;
    if (isNoteOnly(msg)) continue;
    if (!String(msg.body ?? "").trim()) continue;
    run.push(msg);
  }
  return run.reverse();
}

/**
 * The open turn as one block of text for the draft composer's `inquiry`.
 *
 * Single-message turns return that message verbatim — the overwhelmingly common case must stay
 * byte-identical to today's input, so this change is a no-op on the vast majority of traffic. Only
 * a genuinely multi-message turn gets the labelled block, and the label is what tells the composer
 * these are all still open rather than a quoted thread.
 */
export function buildOpenTurnInquiry(
  messages: ReadonlyArray<OpenTurnMessage | null | undefined> | null | undefined
): string {
  const turn = collectOpenCustomerTurn(messages);
  if (!turn.length) return "";

  const bodies = turn.map(m => String(m.body ?? "").trim()).filter(Boolean);
  if (!bodies.length) return "";
  if (bodies.length === 1) return bodies[0];

  // Keep the NEWEST messages when trimming — the tail is the part today's code would have used,
  // so every guard degrades toward current behaviour rather than away from it.
  let kept = bodies.slice(-OPEN_TURN_MAX_MESSAGES);
  while (kept.length > 1 && kept.join("\n").length > OPEN_TURN_MAX_CHARS) kept = kept.slice(1);
  if (kept.length === 1) return kept[0];

  const numbered = kept.map((body, i) => `(${i + 1}) ${body}`).join("\n");
  return [
    "The customer sent these messages and has had NO reply yet — every one of them is still open:",
    numbered,
    "Answer ALL of them in one reply. If you genuinely cannot answer one, say so explicitly rather than ignoring it."
  ].join("\n");
}

/** True when the customer is waiting on more than one message — for route-outcome observability. */
export function hasMultiMessageOpenTurn(
  messages: ReadonlyArray<OpenTurnMessage | null | undefined> | null | undefined
): boolean {
  return collectOpenCustomerTurn(messages).length > 1;
}

/**
 * The SINGLE newest inbound — the narrow question this module widens. Moved here out of index.ts
 * (2026-08-04) so both readings of "which customer message are we talking about" live together:
 * the open turn for the composer, the last message for the ~40 callers that legitimately want just
 * the triggering turn (route decisions, parser inputs, previews). Unchanged behaviour.
 */
export function getLastInboundMessage(conv: any): any | null {
  return conv?.messages?.slice().reverse().find((m: any) => m.direction === "in") ?? null;
}

/** `getLastInboundMessage`'s body, or null. */
export function getLastInboundBody(conv: any): string | null {
  return getLastInboundMessage(conv)?.body ?? null;
}
