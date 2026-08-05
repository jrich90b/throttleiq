/**
 * The walk-in-note step-0 cadence copy, moved verbatim out of `index.ts`.
 *
 * WHY IT MOVED (2026-08-04): this is a regex ladder over a salesperson's prose — the shape
 * AGENTS.md keeps out of the comprehension path — and it sat 71k lines deep in `index.ts` where no
 * eval could reach it. Nothing about it changed in the move; it is byte-for-byte the ladder that
 * shipped, so the two call sites behave exactly as before. It is here so the guard eval can call it
 * directly, and so the `source_size_ratchet` ceiling on `index.ts` could come down far enough to
 * fund the committed-return-day cadence line in `walkInFollowUpTopic.ts`.
 *
 * Its known blind spot is the reason that sibling exists: a note whose one load-bearing fact is
 * "COMING BACK TUESDAY AUGUST 4TH TO TEST RIDE" trips the `test ride` arm and answers with a
 * weather deferral, because the ladder has no arm for a day the customer already named. The day is
 * a PARSED SLOT (`return_visit` / `return_day_text`), so the fix belongs where the slot is read —
 * not in a new arm here.
 */
export type WalkInCommentFollowUpCtx = {
  name: string;
  agent: string;
  dealerName: string;
  comment: string;
  label: string;
};

export const buildWalkInCommentFollowUp = ({
  name,
  agent,
  dealerName,
  comment,
  label
}: WalkInCommentFollowUpCtx) => {
  const raw = String(comment ?? "")
    .replace(/\(step\s*\d+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const lower = raw.toLowerCase();
  const bike = String(label ?? "").replace(/^the\s+/i, "").trim() || "bike";
  const bikeWithArticle = /^the\s+/i.test(String(label ?? "")) ? String(label).trim() : `the ${bike}`;
  const intro = `Hi ${name} — this is ${agent} at ${dealerName}.`;

  const mentionsDepositOrCommitment =
    /\b(deposit|left\s+\$?\d+|finalize|finalise)\b/.test(lower);
  if (mentionsDepositOrCommitment) {
    return `${intro} Let’s get a time set to go over options and next steps on ${bikeWithArticle}. What day works best for you?`;
  }

  const mentionsOrderPath =
    /\b(order|dealer trade|get one|find one|locate one|commitment|commit)\b/.test(lower);
  if (mentionsOrderPath) {
    return `${intro} Just following up. I can walk you through timing, numbers, and next steps to get ${bikeWithArticle}. Want to pick a time this week to go over options?`;
  }

  const mentionsWeatherTestRide =
    /\b(weather|test ride|ride when|when it.*nice|when it.*better)\b/.test(lower);
  if (mentionsWeatherTestRide) {
    return `${intro} Sounds good, when the weather turns we can line up a test ride on ${bikeWithArticle}.`;
  }

  const mentionsWatchRequest =
    /\b(keep an eye|watch|let me know when|when (you|we) have|coming in|in stock)\b/.test(lower);
  if (mentionsWatchRequest) {
    return `${intro} Got it, I'll keep an eye out for ${bikeWithArticle} and text you as soon as one comes in.`;
  }

  const mentionsFinanceHold =
    /\b(credit union|bank|financing|finance|loan|approval|cosigner|co-signer|down payment|saving up)\b/.test(
      lower
    );
  if (mentionsFinanceHold) {
    return `${intro} No problem, whenever you're ready to go over financing on ${bikeWithArticle} I can help with next steps.`;
  }

  const mentionsDecisionHold =
    /\b(thinking|sleep on|not ready|hold off|wait|let you know|talk to (my )?(wife|husband|spouse|partner))\b/.test(
      lower
    );
  if (mentionsDecisionHold) {
    return `${intro} No pressure at all. If you want to revisit ${bikeWithArticle}, just text me and I’ll help from there.`;
  }

  return `${intro} Just checking back on ${bikeWithArticle}. Want to go over options and next steps? I can help whenever you're ready.`;
};
