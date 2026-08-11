import { extractAskedQuestions } from "./leadInGuards.js";
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
 *  - alreadyPurchased — they already bought. FOUND BY SAMPLING, not by reasoning: across 25 real
 *    reply-turns a customer who had just taken delivery and wrote "absolutely loving it, took a
 *    short day today at work to go out for a ride" was answered with "Do you want to aim for
 *    tomorrow after work or first thing Saturday to swing by?" Inviting an owner in, for nothing.
 *    Same class as the June ride-home-warmth miss. Post-sale threads get warmth and service, not
 *    an appointment push.
 *  - dispositionClosing — the customer said they are not interested. I first assumed routing caught
 *    this before the composer; CHECKED, and it does not: that early branch only fires for
 *    contactPreference "call_only" leads. On an ordinary SMS lead the turn reaches here, and the
 *    arm asked a man who had just bought elsewhere whether we should keep looking for him.
 */
export function advanceEveryReplySuppressed(ctx: {
  needsEmpathy?: boolean | null;
  dispositionClosing?: boolean | null;
  alreadyPurchased?: boolean | null;
  appointment?: any;
  /**
   * FIFTH EXCEPTION (Joe, 2026-08-10): we already have enough for a salesperson to take the lead —
   * reachable, money path known, bike question settled — so the turn is a HAND-OFF. Another
   * question past that point is not advancing anything; John Zimmerman (+17169902571) answered our
   * own either/or with "Couple options" and was asked what he meant. Decided by
   * decideSalesHandoffReadiness in routeStateReducer, never here and never in prompt text.
   */
  enoughInfoHandoff?: boolean | null;
}): boolean {
  if (ctx.enoughInfoHandoff) return true;
  if (ctx.needsEmpathy) return true;
  if (ctx.dispositionClosing) return true;
  if (ctx.alreadyPurchased) return true;
  const appt = ctx.appointment;
  if (appt && typeof appt === "object") {
    const status = String(appt.status ?? "").toLowerCase();
    if (appt.startLocal || appt.startsAt || status === "booked" || status === "confirmed") return true;
  }
  return false;
}

/**
 * Charter C1.7 for a COMPOSED DETERMINISTIC reply — the tail that makes a template end by asking.
 *
 * C1.7 binds our own templates exactly as it binds the LLM composer: "a hardcoded ack that ends in
 * a statement is out of compliance with it". The finance-submission ack (#618) applies the rule to a
 * single fixed string; this helper is the same rule for a draft ASSEMBLED from several optional
 * lines, where whether anything asks depends on which lines happened to fire.
 *
 * The turn that named it: Mike Wolf (+17164323990, 2026-08-07 18:02) — "Thanks Scott, I've already
 * seen one but I'll be by soon to get a price on a trade in." He told us he was coming in. The
 * multi-intent composer answered with a price line and a trade-estimate line and asked NOTHING, so
 * the one thing worth knowing — which day — was never asked, and the rep replaced the draft by hand
 * with "let me know when you plan on stopping by with your bike."
 *
 * Two guards, and both are the charter's own words:
 *  - the four suppressions are `advanceEveryReplySuppressed` — the SAME referee the composer uses,
 *    so grief / not-interested / already-bought / already-booked threads are never pushed;
 *  - "At most one question per message" is a CEILING ("One question. Never two."), so a draft that
 *    already asks something is returned untouched. That is why this reads the assembled draft
 *    rather than any one line: the scheduling, out-of-stock-preference and payment-follow-up lines
 *    each ask on their own, and any of them may or may not be present.
 *
 * FAIL DIRECTION: a miss is exactly today's behavior (a statement-only reply — the pre-C1.7 norm).
 * An over-fire appends one visit question to a reply that had none, on a thread with no hardship, no
 * closing, no sale and no booking — recoverable, staff-visible, and a draft either way in suggest
 * mode. Returns the tail (space-prefixed) so the caller's copy stays in one place.
 */
export function templateAdvanceTail(args: {
  draft: string;
  ask: string;
  ctx: {
    needsEmpathy?: boolean | null;
    dispositionClosing?: boolean | null;
    alreadyPurchased?: boolean | null;
    appointment?: any;
  };
}): string {
  const draft = String(args.draft ?? "");
  const ask = String(args.ask ?? "").trim();
  if (!draft.trim() || !ask) return "";
  if (advanceEveryReplySuppressed(args.ctx ?? {})) return "";
  if (draft.includes("?")) return ""; // the ceiling: never a second question
  return ` ${ask}`;
}

/**
 * The per-channel rule block for the draft prompt. Lifted out of llmDraft.ts so the surface that
 * changes every time we learn something about voice can grow on its own budget — the same move as
 * customerAckActionExemplars.ts and vehicleChoiceConfidencePrompt.ts.
 */
/**
 * The GOAL for this turn's question, when a lane has one, in the composer's own words.
 *
 * Joe, 2026-08-11, on the pre-qualification ladder reaching follow-up turns: *"If the customer goes
 * off track and asks or says something unpredictable, will it ask the question needed to get back on
 * track?"* — so the goal is deliberately written as a SUBORDINATE clause to answering them.
 *
 * The measured reason it is phrased that way: a caveat placed under a strong imperative loses to it
 * 3 times out of 3 (advanceEveryReplySuppressed's own history — a grieving customer was offered a
 * follow-up pause). So "answer what they said" cannot be the caveat; it has to be the instruction,
 * with the goal riding along inside it. A goal that steamrolls the customer's actual question is a
 * worse agent than one with no goal at all.
 */
/**
 * Never ask the same question twice in the same words (Joe, 2026-08-11).
 *
 * MEASURED that day: of 743 conversations touched in 45 days, **60 (8%) contain a verbatim repeated
 * question** — 128 repeat-askings. Now that every reply ends with a question, a customer who does not
 * answer one gets it back at them identically, which is the single clearest tell that nobody is
 * really there.
 *
 * The prompt rule is the FIRST line of defence and the cheap one. The second is deterministic and
 * lives in the self-heal loop (`isRepeatedOutboundQuestion`), because a prompt rule alone is a
 * request, not a guarantee — the same reason the four suppressions are in code.
 *
 * Re-asking is ENCOURAGED; repeating is not. If they dodged the question, ask it a different way.
 */
function buildNoRepeatRule(askedAlready?: string[] | null): string {
  const asked = (askedAlready ?? []).map(q => String(q ?? "").trim()).filter(Boolean).slice(-4);
  const base = `- NEVER ask a question you have already asked in this thread using the same words. If they did not
  answer it, ask it a DIFFERENT way — shorter, or from another angle, or by offering a choice of two.
  Re-asking is fine and often right; sounding like a recording is not.`;
  if (!asked.length) return base;
  return `${base}
- You have already asked, word for word: ${asked.map(q => `"${q}"`).join(" / ")}. Do not send any of
  those sentences again.`;
}

function advanceGoalBlock(goal: string): string {
  return `- THIS LEAD HAS A GOAL: ${goal}
- If what they said makes the goal impossible or wrong for them, drop the goal for this turn and just
  be useful. Getting back on track is worth one turn of patience.`;
}

/**
 * ANSWER THEM FIRST — unconditional, every SMS reply (Joe, 2026-08-11: *"if the customer responds
 * with questions the agent needs to know how to handle this in the ladder"*).
 *
 * This started life inside `advanceGoalBlock`, so it only reached lanes that happened to carry a
 * goal. That was backwards: answering the customer is not a property of having a goal. Every lane
 * that asks them in — which since 8/11 is Room58, walk-ins and the finance lanes — can get a QUESTION
 * back, and the reply must deal with it.
 *
 * It sits immediately before the goal (when there is one) so it reads as the binding instruction, for
 * the measured reason a caveat placed UNDER a strong imperative loses to it 3 times out of 3.
 */
function answerThemFirstRule(): string {
  return `- ANSWER WHAT THEY ACTUALLY SAID FIRST — always, even when it has nothing to do with where you are
  trying to get them. If they asked something, answer it; if you do not have the answer, say so plainly
  and say when you will. If they told you something, acknowledge it. THEN ask your one question. A
  customer whose question gets ignored twice stops replying, and no plan survives that.`;
}

export function buildChannelRules(
  ctx: Pick<DraftContext, "channel" | "needsEmpathy" | "dispositionClosing" | "appointment"> & {
    advanceGoal?: string | null;
    history?: { direction: "in" | "out"; body: string }[];
  }
): string {
  // Derived HERE, not at the call site: llmDraft.ts is at its source_size_ratchet ceiling and this
  // module is not, which is exactly what this module exists for.
  const askedAlready = extractAskedQuestions(
    (ctx.history ?? []).filter(h => h.direction === "out").map(h => h.body).join(" ")
  );
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
  lead. One question. Never two.
${answerThemFirstRule()}
${String(ctx.advanceGoal ?? "").trim() ? `${advanceGoalBlock(String(ctx.advanceGoal).trim())}` : ""}`
    : `- BE BRIEF. Default to 1–2 short sentences; 3 only if truly needed. Answer ONLY what the customer
  asked THIS turn — do not pile on extra options, facts, offers, or multiple questions they didn't
  ask for. At most ONE question per message. If you have more to say, save it for their reply.
  (Staff's #1 complaint is replies that say too much — when in doubt, cut it.)
- Do NOT offer appointment times unless the customer explicitly asks to schedule or stop in.`
}
${buildNoRepeatRule(askedAlready)}
- No signatures.
- If not first outbound, do NOT repeat the intro.
- Do NOT mention email unless the customer explicitly asked to email.
- If the customer says "later/next month/next year/I’ll let you know", acknowledge and say you’re here when they’re ready. Do NOT ask to set reminders.
- If the customer asks for a phone call today/now and dealerClosedToday is true, say we’re closed today and someone will call tomorrow. Do NOT offer appointment times.
- If the customer asks for a phone call today/now and dealerClosedToday is false, acknowledge and confirm someone can call today.
`;

  return channelRules;
}
