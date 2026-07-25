import { formatEmailLayout } from "./tone.js";

/**
 * Email body for a credit-application / finance-prequalification lead (Joe ruling, 2026-07-25).
 *
 * Credit-app and prequal ADF leads used to get an SMS-only ack ("received your credit
 * application, finance team will reach out") and no email at all — the `isCreditLead` branch
 * returns before the product-lead path that also builds a `publishAdfEmailDraft`. Joe wants these
 * leads to ALSO get an email draft, in email format, with a booking link so the customer can set
 * up a time to come in and go over numbers.
 *
 * Deliberately NOT the product `buildInitialEmailDraft`: that copy talks about inventory /
 * "check out the bike", which is wrong for a finance lead. This body only acknowledges the
 * submission, reassures that finance will reach out, and offers the booking link.
 *
 * Shared by BOTH draft paths (live `handleSendgridInbound` + `/conversations/:id/regenerate`) so
 * the two stay in parity — each path passes its own already-built booking URL (the URL builders
 * are duplicated per file; the copy is not). Pinned by `credit_lead_email:eval`.
 */
export function buildCreditLeadEmailDraft(args: {
  firstName?: string | null;
  fullName?: string | null;
  dealerName?: string | null;
  agentName?: string | null;
  bookingUrl?: string | null;
  isPrequal: boolean;
}): string {
  const rawName = String(args.firstName ?? args.fullName ?? "there").trim() || "there";
  const name = rawName.split(" ")[0] || "there";
  const dealerName = args.dealerName?.trim() || "American Harley-Davidson";
  const agentName = args.agentName?.trim() || "our team";
  const bookingUrl = (args.bookingUrl ?? "").trim();

  const thanks = args.isPrequal
    ? "Thanks for your pre-qualification submission."
    : "Thanks for your online credit application.";
  const intro = `It's ${agentName} over at ${dealerName}.`;
  const reassure = "Our finance team will reach out shortly to go over your options and next steps.";
  // Fail-safe: no valid booking URL → no booking line (never emit a dangling "book here:").
  const bookingLine = bookingUrl
    ? `If you'd like to set up a time to come in and go over the numbers in person, you can book here: ${bookingUrl}`
    : "";

  const draft = `Hi ${name},\n\n${thanks} ${intro} ${reassure}\n\n${bookingLine}`
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return formatEmailLayout(draft, { firstName: name, fallbackName: "there" });
}
