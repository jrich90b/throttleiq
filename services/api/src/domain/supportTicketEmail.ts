import { sendEmail } from "./emailSender.js";
import type { OpsAnomaly } from "./opsAnomalyStore.js";

type SupportTicketEmailKind = "created" | "completed";

function supportEmailsEnabled() {
  return String(process.env.SUPPORT_TICKET_EMAILS_ENABLED ?? "1").trim() !== "0";
}

function fromEmail() {
  return (
    process.env.SUPPORT_TICKET_EMAIL_FROM ||
    process.env.SENDGRID_FROM_EMAIL ||
    "support@leadrider.ai"
  ).trim();
}

function replyToEmail() {
  return (process.env.SUPPORT_TICKET_REPLY_TO || "support@leadrider.ai").trim();
}

function recipientFor(ticket: OpsAnomaly) {
  return String(ticket.reporter?.email ?? "").trim();
}

function ticketLabel(ticket: OpsAnomaly) {
  return ticket.id.replace(/^ops_/, "").toUpperCase();
}

function buildTicketText(ticket: OpsAnomaly, kind: SupportTicketEmailKind) {
  const leadLine = ticket.context?.leadName ? `\nRelated lead: ${ticket.context.leadName}` : "";
  const pageLine = ticket.context?.pageUrl ? `\nPage: ${ticket.context.pageUrl}` : "";
  if (kind === "completed") {
    return `Hi ${ticket.reporter?.name || "there"},

Your LeadRider support ticket is marked complete.

Ticket: ${ticketLabel(ticket)}
Issue: ${ticket.title}${leadLine}${pageLine}

If anything still looks off, reply to this email and we will reopen it.

LeadRider Support`;
  }
  return `Hi ${ticket.reporter?.name || "there"},

We received your LeadRider support ticket and it is now in the queue.

Ticket: ${ticketLabel(ticket)}
Issue: ${ticket.title}${leadLine}${pageLine}

We will review it and follow up when it is complete or if we need more detail.

LeadRider Support`;
}

export async function sendSupportTicketEmail(ticket: OpsAnomaly, kind: SupportTicketEmailKind) {
  if (!supportEmailsEnabled()) return { sent: false, reason: "disabled" };
  const to = recipientFor(ticket);
  const from = fromEmail();
  if (!to) return { sent: false, reason: "missing_recipient" };
  if (!from) return { sent: false, reason: "missing_from" };
  const subject =
    kind === "completed"
      ? `LeadRider support ticket complete: ${ticketLabel(ticket)}`
      : `LeadRider support ticket received: ${ticketLabel(ticket)}`;
  await sendEmail({
    to,
    from,
    replyTo: replyToEmail(),
    subject,
    text: buildTicketText(ticket, kind)
  });
  return { sent: true };
}
