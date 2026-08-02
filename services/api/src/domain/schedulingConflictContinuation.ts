// ---------------------------------------------------------------------------
// OPEN SCHEDULING CONFLICT — the reply for decideSchedulingTurn's
// "scheduling_conflict_continue" arm.
//
// Origin: William Indelicato +17163591526, msg_2e66f70720313_1784929050013
// (2026-07-24). Scott had spent four turns pinning down a service-visit day:
//   out: "Can you get here first thing in the morning on Wednesday?"
//   in:  "I can try I have an appointment at 9a on Wednesday"
//   out: "What time do you think you can be here on Wednesday?"
//   in:  "Unsure I have to have injections into my shoulder"
// That last turn parsed as stepping_back. Eleven seconds later the lead was
// CLOSED, follow-up was paused indefinitely (followUp.reason
// "customer_stepping_back"), and the draft was the taper "I hear you. If
// anything changes down the road, just give me a shout." Staff overrode it with
// "Ok Let me know what day works best for you and I will try to accommodate".
//
// The customer never withdrew — they could not commit to OUR proposed time. So
// the reply hands the day back to them and says we will work around it, and the
// caller keeps the thread OPEN: no close, no cadence stop, no watch pause.
//
// Shared by BOTH /webhooks/twilio and /conversations/:id/regenerate (AGENTS.md:
// one resolver, both paths) so the two lanes cannot drift.
// ---------------------------------------------------------------------------

/**
 * The customer named a specific obstacle we should not parrot back (a medical
 * procedure, a work shift, a family commitment). We deliberately do NOT restate
 * it — echoing "your shoulder injections" back is the kind of over-familiar
 * line staff edit out — we just make the accommodation explicit.
 */
export function buildSchedulingConflictContinuationReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  return name
    ? `No rush at all, ${name} — just let me know what day works best for you and I'll do my best to work around it.`
    : "No rush at all — just let me know what day works best for you and I'll do my best to work around it.";
}
