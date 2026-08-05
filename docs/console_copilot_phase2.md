# Console Copilot — Phase 2: marketing lists (Joe approved 2026-08-05)

Phase 1 (`console_copilot_phase1.md`) shipped the manager Ask-AI + hot-leads page. Phase 2
adds the other half of Joe's original ask: **marketing-list generation**. The feature
PRODUCES lists — it never sends, and nothing downstream of it may send automatically.

## What it does

On the `/copilot` page, a "Marketing lists" card:
- **Describe it** — "everyone interested in a used Street Glide in the last 90 days" →
  a typed LLM parse (`parseMarketingListRequestWithLLM`, strict JSON schema) fills the
  filters. Shares the Phase 1 daily LLM budget (`COPILOT_ASK_DAILY_CAP`).
- **Manual filters** — channel (sms/email), model contains, condition (new/used), source,
  active-within-days, include-closed. The deterministic builder runs either way.
- **Results** — preview table, the exclusion counts (shown to the manager for trust), and
  a CSV download for campaign tools.

## The compliance layer (the reason this feature is allowed to exist)

`domain/marketingLists.ts` — pure, eval-pinned (`console_copilot_marketing_list:eval`).
Every exclusion fails toward a SMALLER list, checked per row in this order:
1. **missingContact** — no phone (sms) / no email (email)
2. **optedOut** — the channel's intake opt-in flag is explicitly `false`
3. **suppressed** — the phone-level STOP list (`suppressionStore.isSuppressed`)
4. **watchOptOut** — the durable "stop alerting me" conversation flag

Also always excluded: sold customers, non-sales conversations, closed leads unless
`includeClosed`. One row per lead (newest conversation wins). The LLM filter parser can
only NARROW an audience — filters cannot bypass the exclusions, which the handler applies
unconditionally with the live STOP-list predicate.

## Wiring

- `routes/copilot.ts`: `copilotMarketingListHandler` (manager-only) +
  `registerCopilotRoutes(app)` — index.ts carries ONE registration line (it sits at its
  size-ratchet ceiling).
- Copilot LLM lanes moved to `domain/copilotLLM.ts` (llmDraft.ts hit ITS ceiling).
- Web: `/api/copilot/marketing-list` proxy + the card on `app/copilot/page.tsx`.

## Explicitly out (future)

Saved reports / scheduled list refreshes; any send path. A send integration would be a new
approve-first feature with its own compliance review.
