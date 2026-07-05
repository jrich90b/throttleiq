/**
 * Cross-lead data-leakage detector (read-only).
 *
 * The worst trust/safety miss: the agent puts ANOTHER customer's contact info into this lead's thread
 * (a different lead's phone or email appearing in an outbound). Conservative + deterministic: it only
 * flags a phone/email in an outbound that is ANOTHER conversation's OWN lead contact (a real customer's
 * number/email), so a stray digit string or the dealer's own number won't fire. Stock numbers are
 * shared inventory, not PII, so they are NOT flagged. Surfaces candidates for the agent-watch loop.
 */
import type { Conversation } from "./conversationStore.js";

export type CrossLeadLeak = {
  convId: string;
  leadKey: string;
  kind: "phone" | "email";
  leakedValue: string; // the other customer's contact that appeared here
  ownerConvId: string; // the conversation that contact actually belongs to
  ownerLeadKey: string;
  at: string;
  preview: string;
};

export function normalizePhone(s: string | null | undefined): string {
  const digits = String(s ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : "";
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function leadContacts(conv: any): { phones: Set<string>; emails: Set<string> } {
  const phones = new Set<string>();
  const emails = new Set<string>();
  const p1 = normalizePhone(conv?.leadKey);
  if (p1) phones.add(p1);
  const p2 = normalizePhone(conv?.lead?.phone);
  if (p2) phones.add(p2);
  const e = String(conv?.lead?.email ?? "").trim().toLowerCase();
  if (e && e.includes("@")) emails.add(e);
  const lk = String(conv?.leadKey ?? "").trim().toLowerCase();
  if (lk.includes("@")) emails.add(lk);
  return { phones, emails };
}

const isOutbound = (m: any) =>
  m?.direction === "out" && (m?.provider === "draft_ai" || m?.provider === "human" || m?.provider === "twilio" || m?.provider === "sendgrid");

/**
 * Pure. Builds an index of which conversation each customer phone/email belongs to, then scans every
 * outbound for a contact that belongs to a DIFFERENT conversation.
 */
export function findCrossLeadLeaks(args: { conversations: Conversation[] }): CrossLeadLeak[] {
  const convs = args.conversations ?? [];
  const phoneOwner = new Map<string, { convId: string; leadKey: string }>();
  const emailOwner = new Map<string, { convId: string; leadKey: string }>();
  for (const conv of convs) {
    const id = String((conv as any).id ?? "");
    const leadKey = String((conv as any).leadKey ?? "");
    const { phones, emails } = leadContacts(conv);
    for (const p of phones) if (!phoneOwner.has(p)) phoneOwner.set(p, { convId: id, leadKey });
    for (const e of emails) if (!emailOwner.has(e)) emailOwner.set(e, { convId: id, leadKey });
  }

  const leaks: CrossLeadLeak[] = [];
  for (const conv of convs) {
    const id = String((conv as any).id ?? "");
    const own = leadContacts(conv);
    for (const m of (conv as any).messages ?? []) {
      if (!isOutbound(m)) continue;
      const body = String(m?.body ?? "");
      if (!body) continue;
      for (const raw of body.match(PHONE_RE) ?? []) {
        const p = normalizePhone(raw);
        if (!p || own.phones.has(p)) continue;
        const owner = phoneOwner.get(p);
        if (owner && owner.convId !== id) {
          leaks.push({ convId: id, leadKey: String((conv as any).leadKey ?? ""), kind: "phone", leakedValue: p, ownerConvId: owner.convId, ownerLeadKey: owner.leadKey, at: String(m?.at ?? ""), preview: body.slice(0, 160) });
        }
      }
      for (const raw of body.match(EMAIL_RE) ?? []) {
        const e = raw.toLowerCase();
        if (own.emails.has(e)) continue;
        const owner = emailOwner.get(e);
        if (owner && owner.convId !== id) {
          leaks.push({ convId: id, leadKey: String((conv as any).leadKey ?? ""), kind: "email", leakedValue: e, ownerConvId: owner.convId, ownerLeadKey: owner.leadKey, at: String(m?.at ?? ""), preview: body.slice(0, 160) });
        }
      }
    }
  }
  return leaks;
}
