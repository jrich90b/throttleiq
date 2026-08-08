/**
 * Save a described marketing list as a real customer list (docs/console_copilot_phase3_lists.md).
 *
 * THE PROBLEM THIS SOLVES: `buildMarketingList` finds people in CONVERSATIONS and returns rows keyed
 * by convId/leadKey. A customer list holds `contactIds` from the CONTACTS store — the address book.
 * The only mapping that existed ran the other way (`resolveConversationForContact`), so Copilot could
 * find exactly the right people and then dead-end at a CSV. This module is that missing direction.
 *
 * JOE RULED, 2026-08-08: a row with no contact record GETS ONE CREATED — the group is complete, the
 * saved size matches the preview the manager was shown, and the address book grows from real leads
 * instead of silently dropping them. Skipping unmatched rows is the failure mode a dealer notices
 * last and trusts least. Two things follow, and both are load-bearing:
 *   - contacts are created at SAVE, never at preview. Describing a list must stay free of side
 *     effects, or a manager exploring audiences quietly mutates the address book.
 *   - BOTH counts come back ("48 added · 6 new contact records created"), because a list that
 *     quietly differs in size from its preview destroys confidence in the whole feature.
 *
 * A CREATED CONTACT IS NEVER A ROUTE AROUND COMPLIANCE. Rows arrive here already filtered by
 * `buildMarketingList`'s exclusion order (missing contact → channel opt-out → STOP list → watch
 * opt-out), so an excluded person is never created in the first place; and the send path re-checks
 * `isSuppressed` and contact status at SEND time regardless (`assessBroadcastRecipient`). Building a
 * list stays a separate act from sending to it.
 */
import type { MarketingListRow } from "./marketingLists.js";

export type SaveMarketingListDeps = {
  /** Every contact currently on file. */
  listContacts: () => { id: string; phone?: string; email?: string }[];
  /** Resolve-or-create, by phone then email — the contacts store's own upsert. */
  upsertContact: (input: Record<string, unknown>) => { id: string };
  /** The SAME phone normalization the STOP list uses, so a match here agrees with suppression. */
  normalizePhone: (input: string) => string;
};

export type SaveMarketingListResult = {
  contactIds: string[];
  /** How many rows resolved to a contact that already existed. */
  matched: number;
  /** How many rows had no contact record and got one created. */
  created: number;
  /** Rows that carried neither a phone nor an email — cannot be a contact, and are NOT invented. */
  unresolvable: number;
  /** matched + created — the number that must equal the saved list's size. */
  total: number;
};

const cleanEmail = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * Resolve marketing-list rows to contact ids, creating a contact for any row that has none.
 * Pure apart from the injected store functions, so the eval drives it with fakes and the wiring is
 * proven separately rather than mocked away.
 */
export function saveMarketingListRowsAsContacts(
  rows: MarketingListRow[],
  deps: SaveMarketingListDeps,
  origin: { description?: string | null; listName: string; at: string }
): SaveMarketingListResult {
  const existing = deps.listContacts();
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const c of existing) {
    const p = deps.normalizePhone(String(c.phone ?? ""));
    if (p && !byPhone.has(p)) byPhone.set(p, String(c.id));
    const e = cleanEmail(c.email);
    if (e && !byEmail.has(e)) byEmail.set(e, String(c.id));
  }

  const contactIds: string[] = [];
  const seen = new Set<string>();
  let matched = 0;
  let created = 0;
  let unresolvable = 0;

  for (const row of rows) {
    const phone = deps.normalizePhone(String((row as any).phone ?? ""));
    const email = cleanEmail((row as any).email);
    // Phone FIRST, then email — the same precedence the suppression check cares about, and the
    // stronger identifier for a texting audience.
    const hit = (phone && byPhone.get(phone)) || (email && byEmail.get(email)) || null;
    if (hit) {
      matched += 1;
      if (!seen.has(hit)) {
        seen.add(hit);
        contactIds.push(hit);
      }
      continue;
    }
    if (!phone && !email) {
      // Nothing to identify a person by. Creating a nameless, contactless record would pad the count
      // with something no campaign could ever reach.
      unresolvable += 1;
      continue;
    }
    const madeContact = deps.upsertContact({
      leadKey: (row as any).leadKey ?? undefined,
      conversationId: (row as any).convId ?? undefined,
      name: (row as any).name ?? undefined,
      phone: phone || undefined,
      email: email || undefined,
      vehicleDescription: (row as any).modelInterest ?? undefined,
      // Origin stamp: a contact nobody typed can always be traced back to the list that made it.
      leadSource: `copilot list: ${origin.listName}`,
      inquiry: origin.description ? `Added from described list on ${origin.at}: ${origin.description}` : undefined
    });
    created += 1;
    const id = String(madeContact.id);
    if (!seen.has(id)) {
      seen.add(id);
      contactIds.push(id);
      if (phone) byPhone.set(phone, id);
      if (email) byEmail.set(email, id);
    }
  }

  return { contactIds, matched, created, unresolvable, total: matched + created };
}
