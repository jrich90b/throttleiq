// Acknowledgment for a trade/sell ADF — a FORM submission, NOT a customer question.
//
// The orchestrator's trade template used to open every trade turn with
// "Totally fair question. I have you on a …", which is correct only when a CUSTOMER
// actually asked something over SMS. An ADF web-lead is a structured form; its body
// ("Inquiry: trade-in appraisal request") trips the same trade/appraisal keywords, so
// the form got answered as if it were a question — and, mid-conversation, cold
// ("I have you on a 2008 Suzuki…") while a live finance deal was in flight
// (Laricuss Nelson, Ref 11466).
//
// This builder produces the right framing for an ADF trade form:
//   - initial: a clean intake; the agent intro is added downstream by
//     applyInitialAdfPrefix, so this text carries no greeting of its own.
//   - mid-conversation: ties the trade to the existing relationship instead of
//     re-introducing cold.
// The "Totally fair question" template stays for genuine customer-SMS trade questions.
export function buildTradeAdfAck(args: {
  bikeLabel?: string | null;
  midConversation: boolean;
}): string {
  const bike = String(args.bikeLabel ?? "").trim() || "your bike";
  if (args.midConversation) {
    return (
      `Thanks — I got your trade-in request for ${bike}. ` +
      "We can fold that into what we're already working on — a quick in-person appraisal gets you a firm number. " +
      "What day and time works best to stop in?"
    );
  }
  return (
    `Thanks — I got your trade-in request for ${bike}. ` +
    "We can give you a firm number after a quick in-person appraisal. " +
    "What day and time works best to stop in?"
  );
}
