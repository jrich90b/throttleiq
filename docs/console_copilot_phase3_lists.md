# Console Copilot Phase 3 — a described list becomes a real customer list

**Status:** SPEC, approve-first (Lane 2). Written 2026-08-08 from Joe's question: *"Should we move
the marketing list in copilot to the customer list section instead so we can build the marketing
list out right there?"* Answer: yes — but the move is the small half. The value is the **save**.

**Owner:** the agent loop (`throttleiq-unstack-loop`). Console change + a new persisted object ⇒
not auto-merge material.

---

## 1. What exists today (verified in code, 2026-08-08)

**Copilot's marketing list** — `/copilot` (`apps/web/src/app/copilot/page.tsx`),
`services/api/src/domain/marketingLists.ts` → `buildMarketingList(convs, …)`.
- Input: a plain-English description ("everyone interested in a used Street Glide in the last 90
  days") or six filters: `modelQuery`, `condition`, `source`, `activeWithinDays`, `includeClosed`,
  `riderExperience`.
- Reads **conversations**. Model matching is scoped by `audienceModelMatches` so a trike never lands
  in a two-wheel list (the #585/#587 substring bug).
- Applies compliance exclusions in a fixed order and REPORTS the counts: missing contact, opted out,
  STOP-suppressed, watch opt-out. Every check fails toward a *smaller* list, by design.
- Output: a table (first 50) and **Download CSV**. The panel says so out loud: *"builds a list only
  — nothing is ever sent from here."*

**The Customer List section** — the `contacts` section of `apps/web/src/app/page.tsx`,
`resolveContactIdsForList` + `contactMatchesListFilter` in `services/api/src/index.ts`.
- A list is a named group in the Groups sidebar. Membership = explicitly added `contactIds`
  **unioned with** a saved `filter` rule, re-resolved every time the list is read (so a filter list
  is LIVE, not a snapshot).
- The filter matches the **contact record's own vehicle**: `condition`, `year`, `make`,
  `model`/`vehicle`, plus a loose `motorcycleInterest` scan over year/make/model/trim/description.
- A list is what a campaign sends to (`openSendQueueSendDialog` seeds the send dialog from the
  selected list).

## 2. The gap, in one line

Copilot can find exactly the right people and can't do anything with them; the list section can send
to anyone it holds and can barely find them.

## 3. Does this REPLACE the current list builder? **No — and it must not.**

They select from different populations, on different facts, with different lifetimes:

| | today's list filters | Copilot |
|---|---|---|
| searches | the **contacts** store (the address book) | **conversations** (people who messaged us) |
| matches on | the bike **on their record** — what they own or bought | what they **asked about**, their source, rider experience |
| time | no time dimension | "last replied within N days", open vs closed |
| result | a **live rule** that keeps re-resolving | a point-in-time result |

A contact who has never had a conversation — an imported owner list, a service customer — is
**invisible** to Copilot. And "everyone who owns a 2019 Road Glide" (service / trade-up) is a
different marketing job from "everyone who asked about a used Street Glide in the last 90 days"
(sales follow-up). Deleting either one removes an audience we cannot otherwise reach.

**So: two ways to START a list, in one place, ending at the same object.** In the Groups sidebar,
`New list` offers:
- **From your customer records** — today's filter form, unchanged, still saved as a live rule.
- **Describe it** — the Copilot builder, saved as a snapshot (below).

Label them by *what they search*, never by technology. Do NOT label one "AI"; the dealer does not
care which one uses a model, they care whether it searches their address book or their inbox.

## 4. The real work: a lead is not a contact

`buildMarketingList` returns rows keyed by `convId`/`leadKey` with phone/email. A customer list
holds `contactIds` from the **contacts** store. The only mapping that exists today runs the other
way (`resolveConversationForContact`). So "Save as list" needs:

1. resolve each row to an existing contact (phone first, then email — normalized the way
   `isSuppressed` normalizes, so the match agrees with the suppression check);
2. decide what happens when there is no contact record. **Recommended: create one**, marked with its
   origin, so the group is complete and the dealer's address book grows from real leads. The
   alternative (skip unmatched rows) silently shrinks the list, which is the failure mode the
   dealer will notice last and trust least;
3. report both numbers back on the save ("48 added · 6 new contact records created"), because a
   list that quietly differs in size from the preview destroys confidence in the feature.

This is the bulk of the implementation. The UI move is the easy half.

## 5. Snapshot, not a live AI rule (recommended ruling)

Save the described list as a **snapshot** — the people it found, plus the description text stored
alongside for provenance ("built from: *everyone interested in a used Street Glide in the last 90
days*, 2026-08-08").

Why not a live rule: the description is interpreted by a model, so a re-running rule could silently
change *who receives a campaign* with nobody deciding that. We have already been bitten once by
list matching that was looser than it looked (#585/#587: a substring match put trikes in a Street
Glide list). Snapshots are auditable; a drifting AI audience is not. Today's dropdown rules stay
live exactly as they are — they are deterministic, so they can be.

Add a `Rebuild from this description` action on the saved list instead. Re-running is then a
decision someone made, and the size delta can be shown before it is accepted.

## 6. Compliance (checked, so nobody re-litigates it)

A saved list going out days later cannot text someone who opted out in the meantime:
`assessBroadcastRecipient` re-checks `isSuppressed(phone)` / `isSuppressed(email)` and the contact's
own status at **send** time, plus the deal/engagement suppression rules per campaign kind (Joe's
2026-07-16 ruling). Copilot's exclusion counts stay what they are — a *preview*, never the
safeguard.

Unchanged and non-negotiable: **nothing sends from the list builder.** Building a list stays a
separate act from sending to it.

## 7. Acceptance

Deterministic evals, wired into `ci:eval`:
- lead→contact resolution: phone match, email match, no-match-creates-one, and the same
  normalization the suppression check uses (a lead that IS suppressed must resolve to the same key
  that `isSuppressed` would reject);
- saving a described list produces a group whose membership equals the previewed rows minus
  compliance exclusions — the saved count must equal the number the user was shown;
- a saved described list carries `source: "snapshot"` and does **not** acquire a dynamic `filter`
  (i.e. it can never start re-resolving by accident);
- today's dropdown filter lists keep resolving live — a regression pin, since this change touches
  `resolveContactIdsForList`.

`apps/web/src/app/page.tsx` is 25k lines and on the size ratchet: the new panel goes in its own
component file, not into `page.tsx`.

## 8. Open for Joe

1. When a described list finds someone with no contact record — create the contact (recommended) or
   leave them out?
2. Should the described-list builder stay on the `/copilot` page as well, or move entirely into the
   Customer List section? (Recommend: move it. One place to build a list is the point of the
   change; Copilot keeps ask + insights.)

Related: `docs/console_copilot_phase1.md`, `docs/console_copilot_phase2.md`.
