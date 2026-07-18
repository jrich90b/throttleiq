/**
 * inboundMailActionability — recognizes machine-generated "view this in an HTML-capable email
 * client" boilerplate that some senders put in the plain-text alternative part of an HTML-only
 * email.
 *
 * Real case (americanharley, 2026-07-18): a vendor notification from
 * `autosender@trafficlogpro.com` arrived HTML-only; its plain-text alternative was nothing but
 *   "This email contains HTML formatted content, please be sure to view it in an HTML capable
 *    email client."
 * `cleanInboundEmailText` returns that plain-text part verbatim (it doesn't look like MIME), so
 * the boilerplate became the "customer message". The draft pipeline then produced a generic
 * "what are you looking for?" reply, which the quality gate held after ~14 wasted self-heal
 * round-trips. No customer was on the other end — it was vendor noise (confirmed by Joe).
 *
 * Detecting the notice lets the inbound path DROP it instead of drafting a junk reply.
 *
 * FAIL-DIRECTION (AGENTS.md): this suppresses a reply, so it must NEVER swallow a real customer.
 * The match therefore requires the notice to be the WHOLE message — once the boilerplate sentence
 * is removed, nothing meaningful can remain. A customer who types real words keeps them and is
 * never suppressed; no human writes this exact sentence as their message. This is non-content
 * detection of a fixed machine string (structured extraction), not comprehension of customer
 * intent — same deterministic class as `isCallOnlyText` / `looksLikeAdfMetadataBlob`.
 */

const HTML_CLIENT_NOTICE =
  /this email contains html[- ]?formatted content[,.]?\s*please\s+(?:be sure to\s+)?view\s+(?:it|this)\s+in\s+an\s+html[- ]?capable\s+email\s+client\.?/gi;

/**
 * True when `body` is (only) the "view this in an HTML-capable email client" machine notice —
 * i.e. there is no customer content to answer. Returns false for any body that carries real
 * words alongside (or instead of) the notice, and for empty input.
 */
export function isHtmlClientNoticeOnly(body?: string | null): boolean {
  const normalized = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  // Remove every occurrence of the notice; if only punctuation/whitespace remains, it was the
  // entire message. Anything else the customer wrote survives here and blocks suppression.
  const remainder = normalized.replace(HTML_CLIENT_NOTICE, " ").replace(/[\s.,;:!?-]+/g, " ").trim();
  return remainder.length === 0;
}
