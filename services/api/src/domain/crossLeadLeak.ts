/**
 * Cross-lead data-leakage detector (read-only).
 *
 * The worst trust/safety miss: the agent puts ANOTHER customer's contact info into this lead's thread
 * (a different lead's phone or email appearing in an outbound). Conservative + deterministic: it only
 * flags a phone/email in an outbound that is ANOTHER conversation's OWN lead contact (a real customer's
 * number/email), so a stray digit string or the dealer's own number won't fire. Stock numbers are
 * shared inventory, not PII, so they are NOT flagged. Surfaces candidates for the agent-watch loop.
 *
 * A DEALER'S OWN CONTACT IS NOT LEAKABLE PII. A rep handing a customer their work email or desk line
 * is the intended behavior. Lead feeds routinely drop a rep's address into a lead record
 * (`lead.email = gio@<dealer-domain>`), which made that staff address "belong" to a customer
 * conversation and flagged every later thread that quoted it. Pass `dealerContacts` (built by
 * `collectDealerContacts` from the dealer's own staff roster + profile — no hardcoded domain, so it
 * stays dealer-portable) and those contacts are neither REGISTERED as a customer's nor FLAGGED when
 * quoted. Deterministic on purpose: this governs what a safety scorer is allowed to see, not how
 * customer intent is read.
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

export type DealerContacts = { phones: Set<string>; emails: Set<string>; emailDomains: Set<string> };

export const EMPTY_DEALER_CONTACTS: DealerContacts = { phones: new Set(), emails: new Set(), emailDomains: new Set() };

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/**
 * Pure. Collects the dealership's OWN contacts from its staff roster (`users.json`) and profile
 * (`dealer_profile.json`). Dealer-portable: every value comes from that dealer's own records.
 *
 * `emailDomains` covers the shared boxes no roster lists (sales@, finance@, service@) — a domain the
 * dealer already publishes as its own from/reply-to/website is the dealership, never a customer.
 */
export function collectDealerContacts(args: { users?: any; dealerProfile?: any }): DealerContacts {
  const phones = new Set<string>();
  const emails = new Set<string>();
  const emailDomains = new Set<string>();

  const rawUsers = args.users;
  const users: any[] = Array.isArray(rawUsers) ? rawUsers : Array.isArray(rawUsers?.users) ? rawUsers.users : [];
  for (const u of users) {
    const p = normalizePhone(u?.phone);
    if (p) phones.add(p);
    const e = String(u?.email ?? "").trim().toLowerCase();
    if (e.includes("@")) {
      emails.add(e);
      const d = emailDomain(e);
      if (d) emailDomains.add(d);
    }
  }

  const profile = args.dealerProfile ?? {};
  for (const key of ["fromEmail", "replyToEmail"]) {
    const e = String(profile?.[key] ?? "").trim().toLowerCase();
    if (e.includes("@")) {
      emails.add(e);
      const d = emailDomain(e);
      if (d) emailDomains.add(d);
    }
  }
  const profilePhone = normalizePhone(profile?.phone);
  if (profilePhone) phones.add(profilePhone);
  // The dealer's public website host is its own domain — staff mail lives there too.
  const site = String(profile?.website ?? "").trim().toLowerCase();
  const host = site.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (host.includes(".")) emailDomains.add(host);

  return { phones, emails, emailDomains };
}

/**
 * Is this address the DEALERSHIP'S own rather than a customer's?
 *
 * Exported so the identity join (`domain/leadIdentity.ts`) asks the same question this audit
 * asks, of the same dealer records — one definition, not two that can drift. Both callers
 * enforce the same 2026-08-04 ruling: a rep's work address sitting in a lead record does not
 * make it that customer's contact.
 */
export const isDealerOwnedEmail = (email: string, dealer: DealerContacts): boolean => {
  const text = String(email ?? "").trim().toLowerCase();
  if (!text) return false;
  return dealer.emails.has(text) || dealer.emailDomains.has(emailDomain(text));
};

const isDealerEmail = (email: string, dealer: DealerContacts): boolean =>
  isDealerOwnedEmail(email, dealer);

const isDealerPhone = (phone: string, dealer: DealerContacts): boolean => dealer.phones.has(phone);

const isOutbound = (m: any) =>
  m?.direction === "out" && (m?.provider === "draft_ai" || m?.provider === "human" || m?.provider === "twilio" || m?.provider === "sendgrid");

/**
 * Pure. Builds an index of which conversation each customer phone/email belongs to, then scans every
 * outbound for a contact that belongs to a DIFFERENT conversation. Dealer-owned contacts never enter
 * the index and are never flagged.
 */
export function findCrossLeadLeaks(args: { conversations: Conversation[]; dealerContacts?: DealerContacts }): CrossLeadLeak[] {
  const convs = args.conversations ?? [];
  const dealer = args.dealerContacts ?? EMPTY_DEALER_CONTACTS;
  const phoneOwner = new Map<string, { convId: string; leadKey: string }>();
  const emailOwner = new Map<string, { convId: string; leadKey: string }>();
  for (const conv of convs) {
    const id = String((conv as any).id ?? "");
    const leadKey = String((conv as any).leadKey ?? "");
    const { phones, emails } = leadContacts(conv);
    // A rep's address sitting in a lead record does not make it that customer's contact.
    for (const p of phones) if (!isDealerPhone(p, dealer) && !phoneOwner.has(p)) phoneOwner.set(p, { convId: id, leadKey });
    for (const e of emails) if (!isDealerEmail(e, dealer) && !emailOwner.has(e)) emailOwner.set(e, { convId: id, leadKey });
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
        if (!p || own.phones.has(p) || isDealerPhone(p, dealer)) continue;
        const owner = phoneOwner.get(p);
        if (owner && owner.convId !== id) {
          leaks.push({ convId: id, leadKey: String((conv as any).leadKey ?? ""), kind: "phone", leakedValue: p, ownerConvId: owner.convId, ownerLeadKey: owner.leadKey, at: String(m?.at ?? ""), preview: body.slice(0, 160) });
        }
      }
      for (const raw of body.match(EMAIL_RE) ?? []) {
        const e = raw.toLowerCase();
        if (own.emails.has(e) || isDealerEmail(e, dealer)) continue;
        const owner = emailOwner.get(e);
        if (owner && owner.convId !== id) {
          leaks.push({ convId: id, leadKey: String((conv as any).leadKey ?? ""), kind: "email", leakedValue: e, ownerConvId: owner.convId, ownerLeadKey: owner.leadKey, at: String(m?.at ?? ""), preview: body.slice(0, 160) });
        }
      }
    }
  }
  return leaks;
}
