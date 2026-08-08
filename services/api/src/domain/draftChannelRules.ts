import type { DraftContext } from "./llmDraft.js";

/**
 * Every reply ends with ONE question that advances the lead toward a visit (Joe, 2026-08-07).
 *
 * Measured that day: of 383 replies to a live customer in 30 days, only 65 (17%) ended by asking
 * anything at all. That was not a capability gap — the SMS rules said "Answer ONLY what the
 * customer asked THIS turn", capped questions at "at most ONE" (a ceiling, never a floor) and
 * flatly forbade offering a time unless the customer asked first. Our agent ANSWERED; a competitor
 * demo Joe tested ADVANCED on every single turn, and the booking funnel is the binding constraint
 * (57% offered a time, 17% booked).
 *
 * SHIPS DARK. The legacy rules are the default and remain the revert: unset the flag and the
 * composed prompt is byte-identical to today. Joe's framing for the new arm, verbatim: act like a
 * human salesman looking to be polite, whose main job is driving appointments and sales — and the
 * questions "must be appropriate to the conversation", which is why the arm leads with following
 * from what the customer just said rather than with asking.
 *
 * Joe's other framing, and the reason the arm prefers a choice of two: "asking questions would
 * really be a way to control the flow of the conversation". An either/or is easier to answer than
 * an open question, and every answer qualifies the lead further — which is exactly what the demo
 * does on every turn ("daily driver or towing?", "cash or finance?", "11am or around 2pm?").
 *
 * The brevity rule survives on purpose. The demo that prompted this is BRIEF; it advances in two
 * or three sentences. Verbosity was staff's #1 complaint and this is not a licence to pile on.
 */
export function advanceEveryReplyEnabled(): boolean {
  const raw = String(process.env.DRAFT_ADVANCE_EVERY_REPLY ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Turns where the salesperson arm must NOT be handed to the model at all.
 *
 * MEASURED 2026-08-07, and this is why it is code and not a prompt caveat. The first cut listed the
 * exceptions inside the rules ("DO NOT ask anything when the customer ... disclosed a hardship").
 * Probed on five real-shaped turns, the exception list lost to the imperative above it 3 times out
 * of 3 — including a customer who had written *"my husband passed away last week"* and got back
 * *"Would you like me to pause follow-ups for now or check back in a few weeks?"* A strong opening
 * instruction beats a caveat further down, every time.
 *
 * So the arm is selected in CODE from signals the draft context already carries, and the caveat
 * stays only as a second line of defence:
 *  - needsEmpathy — the affect parser confidently read a hardship this turn. Never sell into grief.
 *  - a booked appointment — the thread is settled; confirm it, do not re-open it with a new ask.
 *  - dispositionClosing — the customer said they are not interested. I first assumed routing caught
 *    this before the composer; CHECKED, and it does not: that early branch only fires for
 *    contactPreference "call_only" leads. On an ordinary SMS lead the turn reaches here, and the
 *    arm asked a man who had just bought elsewhere whether we should keep looking for him.
 */
export function advanceEveryReplySuppressed(ctx: {
  needsEmpathy?: boolean | null;
  dispositionClosing?: boolean | null;
  appointment?: any;
}): boolean {
  if (ctx.needsEmpathy) return true;
  if (ctx.dispositionClosing) return true;
  const appt = ctx.appointment;
  if (appt && typeof appt === "object") {
    const status = String(appt.status ?? "").toLowerCase();
    if (appt.startLocal || appt.startsAt || status === "booked" || status === "confirmed") return true;
  }
  return false;
}

/**
 * The per-channel rule block for the draft prompt. Lifted out of llmDraft.ts so the surface that
 * changes every time we learn something about voice can grow on its own budget — the same move as
 * customerAckActionExemplars.ts and vehicleChoiceConfidencePrompt.ts.
 */
export function buildChannelRules(ctx: Pick<DraftContext, "channel" | "needsEmpathy" | "dispositionClosing" | "appointment">): string {
  const isEmail = ctx.channel === "email";
  const channelRules = isEmail
    ? `
EMAIL RULES (strict):
- 4–6 sentences. Warm, professional, complete sentences.
- No emojis. No bullet lists.
- Do NOT include a signature; the system will append it.
- If dealerProfile.bookingUrl exists, include exactly: "You can book an appointment here: <bookingUrl>".
- If not first outbound, do NOT repeat the intro.
`
    : `
SMS RULES (strict):
${
  advanceEveryReplyEnabled() && !advanceEveryReplySuppressed(ctx)
    ? `- YOU ARE A SALESPERSON and the job is getting people in the door. Be brief and warm — 1-3 short
  sentences — then END WITH EXACTLY ONE QUESTION that moves this lead toward a visit.
- THE QUESTION MUST FOLLOW FROM WHAT THEY JUST SAID. It is the next thing a good rep would actually
  want to know, never a bolt-on and never something they already answered in this thread. They named
  how they will use it => ask about a trade or how they are paying. They asked price => cash or
  finance. They are weighing it => what would help them decide. Nothing left to learn => ask them in.
- PREFER A CHOICE OF TWO over an open question. "Trade or straight purchase?", "cash or finance?",
  "earlier in the day or later?" A two-option question is far easier to answer from a phone, it
  keeps the thread moving instead of stalling, and every answer tells us something we need. Save
  open questions for when neither option would be fair to assume.
- ASK THEM IN once the basics are covered and nothing is booked: name a specific day and a rough
  time ("we're open till 6 Saturday — would around 4:30 work?"). One concrete offer beats "let me
  know when you're free". Use suggestedSlots when given; otherwise stay inside the dealer's posted
  hours for that day and keep it approximate. NEVER name a time we cannot honour.
- DO NOT ask anything when the customer is closing the thread, said they are not interested, is
  being handed to a person, already has an appointment booked (confirm it instead), gave a specific
  later date to follow up, or disclosed a hardship. Answer warmly and stop — pushing there costs the
  lead. One question. Never two.`
    : `- BE BRIEF. Default to 1–2 short sentences; 3 only if truly needed. Answer ONLY what the customer
  asked THIS turn — do not pile on extra options, facts, offers, or multiple questions they didn't
  ask for. At most ONE question per message. If you have more to say, save it for their reply.
  (Staff's #1 complaint is replies that say too much — when in doubt, cut it.)
- Do NOT offer appointment times unless the customer explicitly asks to schedule or stop in.`
}
- No signatures.
- If not first outbound, do NOT repeat the intro.
- Do NOT mention email unless the customer explicitly asked to email.
- If the customer says "later/next month/next year/I’ll let you know", acknowledge and say you’re here when they’re ready. Do NOT ask to set reminders.
- If the customer asks for a phone call today/now and dealerClosedToday is true, say we’re closed today and someone will call tomorrow. Do NOT offer appointment times.
- If the customer asks for a phone call today/now and dealerClosedToday is false, acknowledge and confirm someone can call today.
`;

  return channelRules;
}
