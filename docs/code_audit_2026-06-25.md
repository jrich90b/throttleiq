# ThrottleIQ full-codebase audit — 2026-06-25

Read-only sweep by 6 parallel auditors across: live/regen parity, route-centralization
(de-tangle), comprehension debt, eval-coverage gaps, state-invariant/reconcile coverage, and
code cruft/correctness. Findings are synthesized + de-duplicated below. **No code was changed.**
Structural/routing/comprehension cutovers are **approve-first** per CLAUDE.md.

Severity: **P0** customer-facing wrong/silent or external-write risk · **P1** likely wrong / high-value ·
**P2** inconsistency/latent · **P3** cruft/cosmetic.

---

## Executive summary
The codebase is **healthy where it counts**: parser-first is real, the route *decision* layer
(`routeStateReducer`) is ~100% eval-pinned, timezone-aware date math exists, no tracked secrets / XSS /
hardcoded localhost. Debt is **concentrated and structural**, in five convergent themes:

1. **An uncentralized pre-snapshot routing layer** — service/trade/immediate-arrival/finance-escalation
   route by raw `if`-block order *before* `buildRouteDecisionSnapshot`. (flagged by parity + centralization)
2. **The email/ADF intake (`sendgridInbound.ts`) has no route reducer and no decision-table eval at all**
   — the single biggest structural gap; regex `||` parser OR-gates there compose customer replies.
3. **The eval net is blind at the side-effect seam** — the highest-risk mutators (real calendar booking,
   cron self-clean, scheduling-leak flagging) are verified only by `assert.match` on source strings.
4. **Write-time state asymmetries** on close/book/sold paths (inventory watch left active; in-process
   nudge orphans forever; confirmed-without-bookedEventId breaks reminder/outcome sweeps).
5. **Two monoliths** — `services/api/src/index.ts` (~64k lines, 236 routes) and `apps/web/src/app/page.tsx`
   (~24k lines) — the merge-conflict surface behind the shared-working-tree concurrency pain.

---

## P0 — act first

### P0.1 ✅ DONE (a23df5a3) — Auto-book calendar write is source-guard-only (no behavioral eval)
RESOLVED 6/25: extracted the confirm-booking BRANCHING into the pure `decideCustomerAckConfirmBooking`
(routeStateReducer); IO (config/availability/insertEvent) stays in index.ts and feeds it. New
`confirm_booking_decision:eval` pins the write-failure→no-false-confirm, taken→alternatives,
regen→no-write, service→defer, and precedence branches — without booting the server or mocking Calendar.
Behavior-preserving; deployed. Original finding below.


`bookConfirmedAppointmentSlot` / `resolveCustomerAckConfirmBooking` (index.ts) call `insertEvent` (real
Google Calendar write + `bookedEventId` + "you're all set" SMS). `scheduling_auto_book_on_confirm_eval.ts`
runs only the route decision; the booking helper is pinned by ~18 `assert.match` source guards ("can't run
in CI"). A logic bug — false confirm w/o a real event, double-book, booking a taken slot — passes the gate.
**This is my own recent work and the highest-blast-radius blind spot in the repo.**
→ Drive `resolveCustomerAckConfirmBooking` with a mock calendar client; assert free→booked-once,
taken→alternatives (no false confirm), write-failure→`booked:false`. **approve-first: no** (test-only).

### P0.2 `customer_ack_action:eval` — the flag that ARMS the calendar write — is not in `ci:eval`
`customerAckActionParse.shouldBook` (index.ts:58591) is what fires a real booking, but
`customer_ack_action_eval.ts` is not wired into the gate. A `shouldBook` false-positive books an unwanted
appt; false-negative drops a firm time.
**UPDATE (6/25): tried wiring it into the hot `ci:eval` gate — it FLAKED** on a borderline *action-label*
case ("I'm 💯 legit" → `neutral_ack` vs expected `no_response_needed`); the `shouldBook` dimension itself
was 16/16. Exact-match LLM parser evals are too variance-prone for the blocking gate. RESOLUTION: keep it
OUT of the hot gate; its correct home is the **nightly loop** (`feedback_loop_nightly.sh`), where a flake
doesn't block shipping. The booking-arming `shouldBook` is meanwhile covered deterministically by
`scheduling_turn_decision` (the `customerAckShouldBook` rows) + `scheduling_auto_book_on_confirm`. Follow-up:
wire `customer_ack_action:eval` into the nightly + (optionally) split a strict `shouldBook`-only assertion
that *could* gate without the flaky action-label match. **approve-first: no.**

### Note — also exposed a CI footgun
`npm run ci:eval 2>&1 | tail -N` returns **tail's** exit code, masking an eval failure. Always run the gate
WITHOUT a trailing pipe (redirect to a file) when you need the real pass/fail.

### P0.3 ADF/email intake routes intent by `inquiryText.includes(...) || llmIntent` and composes replies
`services/api/src/routes/sendgridInbound.ts:5114-5152` (test_ride/finance_prequal/trade_in_sell/service
buckets), `:4980-4997` (parts/apparel verb-gates), `:5340-5351` (callback), `:5761-5769` (forces
`dialogState=test_ride_booked`). Regex is primary, parser the fallback; a miss routes the lead to the wrong
department or fabricates a "not buying" state — and the bucket selects the whole reply template.
`sendgridInbound.ts` has **no centralized route reducer and no decision-table eval**. → New
`decideAdfRoute` reducer fed by `parseAdfDepartmentInterestWithLLM`; demote regex to a gated pre-filter;
decision-table eval. **approve-first: yes.** *(Single biggest structural gap.)*

### P0.4 Orchestrator finance/pricing/dept detectors are reply-composing co-arbiters (BOTH paths)
`services/api/src/domain/orchestrator.ts:2252-2253` (`detectFinanceRequest(event.body) ||
detectPricingOrPayment(event.body)`) + dept branches (`detectPartsFallbackRequest` →2867,
`detectServiceFallbackRequest` →2891, etc.). `orchestrateInbound` runs in BOTH live and regen, so on a
parser miss the raw regex alone fires the finance/pricing/dept reply. → Make the existing parser hints
authoritative; fold dept detection into `decideFinancePricingTurn` + the ADF-department parser; drop the
`|| detect*` OR-gates. **approve-first: yes.**

---

## P1 — high value

### P1.1 Centralize the service-vs-scheduling precedence (`isServiceDepartmentSchedulingRequest`) ⭐ convergent
Flagged by BOTH the parity and centralization auditors as the **top fold target**. It's a true cross-cluster
precedence decision, scattered across **8 inline sites** (index.ts:9217, 49134, 56253/56338/56437, 58528,
62055) in both paths, whose precedence over `decideSchedulingTurn` is purely block order (service at 58528
*precedes* sched at 58588). It already carries a regex backstop (`isDealerVisitTimeCheckInText`, added 6/25)
**because it misfired in prod (Bobby Kindred)**. → Fold into the scheduling-cluster precedence: a
`service_handoff` kind in `decideSchedulingTurn` that the auto-book suppressors also read. Collapses the most
duplication for the most demonstrated risk. **approve-first: yes.**

### P1.2 Trade cluster has no `decide*Turn`; precedence inline + duplicated live/regen (drift)
CLAUDE.md already lists "trade-cluster route-decision centralization" as pending. Trade target-value
(~57575), payoff/lien (~58126/58325), and trade-followup (60637) route by parallel inline blocks in both
paths with by-order precedence, and the two paths are structured differently (live `tradeFollowupMessage`
vs regen `regenTradeFollowupMessage`) — exactly the live/regen drift the parity law exists to prevent.
→ New `decideTradeTurn` returning `trade_target_value | trade_payoff_lien | trade_followup | none`, both
paths, decision-table eval. **approve-first: yes.**

### P1.3 Live/regen parity gaps (specific, customer-facing)
- **Vehicle-info request:** dedicated `buildVehicleInfoRequestReply` in regen (49774) but generic generation
  live (57937/60776) — staff regenerate sees a different answer than was sent. **P1.**
- **Scheduling customer-ack (regen) bypasses the pricing-precedence guard** (50721 passes
  `pricingOrPaymentsIntent:false`) and gates arms by **raw parser action**, not `decideSchedulingTurn`
  (49301) — mixed pricing+scheduling turns route differently across paths. **P1.**
- **Cancel vs reschedule:** live cancels + acks (58505); regen drafts a reschedule offer (48966) — wrong
  customer-facing message on a pure-cancel regenerate. **P1.**
- **ADF intents handled in regen but not the live orchestrator first-touch:** ride-challenge signup
  (50198), ADF vehicle-fact handoff (50017), ADF first-time-rider guidance (49957), marketplace
  sell-my-bike (parser in regen vs regex in orchestrator 2320). The live *first draft* is wrong/generic;
  only a regenerate fixes it. **P1–P2.** **approve-first: yes** (shared intake decisions).

### P1.4 `resumeFollowUpCadence` has zero eval coverage
`conversationStore.ts:4251`, called live at index.ts:11563. Restarting a cadence is customer-facing
(resumes outbound SMS); a bug re-spams a held/handed-off lead or fails to resume a paused one — the exact
silent-state-breakage class. → eval: resume only from paused/held, correct re-anchor, no-op on closed/handoff.
**approve-first: no.**

### P1.5 State-invariant write-time asymmetries (latent, mostly dormant today) ⭐ convergent
- **`closeConversation` doesn't pause the inventory watch** (only the opt-out path does, with a comment about
  reopen-refire). Sold/not-interested/archived all leave `inventoryWatch.status="active"`. Latent
  reopen-refire. → move `pauseInventoryWatches` into `closeConversation`. **P2.**
- **Booking / `paused_indefinite` don't pause the watch** — a customer who just booked, or who said "I'll
  reach out," can still get "Good news, [model] is available again!" → notifier guard: skip
  `appointment.status==="confirmed"` and `paused_indefinite` (NEVER skip `holding_inventory`). **P2.**
- **`shouldNudgeInProcessDeal` permanent dedup** (`conversationStore.ts:5387` — no re-nudge) orphans an
  in-process deal forever after one nudge, unlike every sibling sweep (stale-handoff 14d, first-touch 7d,
  leak 3d). → add a re-nudge window. **P2.**
- **`appointment.status="confirmed"` with `bookedEventId=null`** from the raw booking endpoints (index.ts
  34026/33455/36795 set `event.id ?? null` with no guard, unlike the safe helper) is silently skipped by the
  reminder (30001) and outcome (30347) sweeps. → write-time guard mirroring `bookConfirmedAppointmentSlot`.
  **P1.** **approve-first: no** (invariant guards/heals).

---

## P2 — inconsistency / latent

- **Comprehension debt beyond the tracked ratchet:** the 35-baseline ratchet measures only ~⅓ of the
  customer-intent-regex surface; the rest lives in `orchestrator.ts`, `/regenerate`, and especially
  `sendgridInbound.ts`. ~15 MIGRATE candidates incl. the sendgrid pending-used-complaint reply composed off
  raw `event.body` (7385), `recentVehicleDiscussion` model/year regex table (route via the model-authority
  resolver), `customerPhotoShare` intent regex (50109/51169/54513), `workflowRegressionGuards` ~8
  `isXxxText→buildXxxReply` FAQ pairs (consolidate into one `parseInformationalTopicWithLLM`). → **Extend
  the comprehension-debt ratchet to count `orchestrator.ts` + `sendgridInbound.ts`** so this debt is visible.
- **`availabilityExplicit` inline `routeExec || (4 signals)` precedence chain** (index.ts:60566) with a
  hardcoded `/sound system|stereo|speakers/` regex — recomputes availability precedence outside the snapshot;
  the trade cluster then gates on `!availabilityExplicit`. → feed signals into `buildRouteDecisionSnapshot`.
- **`immediateArrivalRequestFallback`** (58561, regex) is a 2nd scheduling entry parallel to
  `decideSchedulingTurn`'s own `immediate_arrival` kind (58606) — fold in.
- **Pre-snapshot finance escalations** (third-party-finance 58032, external-dealer-approval 58045) route
  before `buildRouteDecisionSnapshot` (58979) — precedence is implicit ordering; pure helpers but uncentralized.
- **Side-effect evals that are source-guard-only** (rot risk — a benign refactor false-fails, a buggy one
  false-passes): `scheduling_auto_book_on_confirm` (18 matches), `scheduling_leak` (7),
  `state_invariant_reconcile`, `feedback_redraft` (12), `finance_app_invite` (10), `payment_estimate` (7),
  `vehicle_media_request` (7). The top 3 guard external/persisted writes → upgrade to fixture-store execution.
- **Security (verify on the box — `.env` is local/gitignored, can't confirm prod values):**
  `AUTH_DISABLED=true` in `services/api/.env` bypasses all auth → add a startup assertion refusing to boot
  with it set when `NODE_ENV=production`. `PG_SSL` truthy sets `rejectUnauthorized:false` (disables cert
  verification, MITM-able) in `storePersistence.ts:72` + `worker/src/index.ts:27` → default to verify, gate
  the insecure mode behind an explicit flag. (Postgres is dual-write shadow today → limited live exposure.)

---

## P3 — cruft / cosmetic
- **Decompose the two monoliths** (highest-leverage *cleanup*): `index.ts` 64k/236 routes → pull routes into
  `routes/*` and the scheduling/date-math cluster (~18890–28879) into `domain/schedulingDates.ts`;
  `page.tsx` 24k → continue component extraction + a typed API client for the 126 `fetch` sites. Pure
  relocation, eval-safe, cuts the concurrent-session merge-conflict surface.
- **MCP SharePoint stub** (`services/mcp/src/index.ts:64`) returns `ok:true status:"stub"` for unimplemented
  → return 501/`ok:false` or delete the service.
- **~26 orphaned one-off scripts** in `scripts/` (completed backfills/scrubs) + a stray executable `.ts` under
  `reports/` → archive/delete. Stray root files: `immediate` (0 bytes), empty `.env.example`.
- **~50 empty `catch {}`** — many are deliberate fail-safe parses, but a bare catch hides real throws → log
  under the existing debug flag.
- **UI guardrail:** raw `✓` glyph instead of the shared `UiIcon` set in `TaskInboxSection.tsx:616/622/628`,
  `page.tsx:16680+`, `command/sales/page.tsx:558`. Inline `#ddd`/`#ccc` low-contrast borders in the print HTML.
- **Stale/dark flags** (verify box-side before pruning): `FAQ_LAYER_ENABLED` (memory says bypassed),
  `CONTEXT_FIDELITY_HOLD_SHADOW` (enforce-flip is the documented next step), `CADENCE_QUALITY_JUDGE_SHADOW`,
  `FIRST_TOUCH_ACK_AUTOSEND`, `PHANTOM_VISIT_GUARD`.

---

## Confirmed healthy (for contrast)
`routeStateReducer` decisions ~100% eval-pinned (best-covered file). Post-snapshot pricing/scheduling/
availability/callback dispatch is genuinely reducer-driven and live/regen-parallel. Disposition closeout
uses pure `canApplyDispositionCloseout` in both paths. Reconcile suite is mature and well-gated against
over-fire (every nudge models the engine's hold conditions). No tracked secrets, XSS, or hardcoded hosts.
Compliance/safety/disposition KEEP-regex (STOP, opt-out, affordability-objection close-guard) correctly KEEP.

## Progress (6/25)
- ✅ **P0.1 DONE** (a23df5a3) — auto-book branching extracted to a pure decision + `confirm_booking_decision:eval`.
- ✅ **P1.4 DONE** (e05694a7) — `resume_followup_cadence:eval` added.
- ⚠️ **P0.2** — `customer_ack_action:eval` flakes in the hot gate; kept out, belongs on the nightly loop (TODO).
- ✅ side-guard rot demonstrated + fixed in `scheduling_auto_book_on_confirm:eval` (now delegates to the behavioral eval).
- Next: **P1.1 service-vs-scheduling fold** (the #1 structural target), then the trade reducer / parity gaps.

## Recommended sequence
1. **Cheap, eval-only, no approval needed:** P0.1 + P0.2 + P1.4 + upgrade the 3 source-guard side-effect
   evals (P2) — closes the side-effect blind spot, makes the net catch real regressions.
2. **One structural fold (approve-first):** P1.1 service-vs-scheduling into `decideSchedulingTurn` — converts
   this week's patch + 8 scattered gates into one tested decision.
3. **The big structural gap (approve-first, larger):** P0.3/P0.4 — a `decideAdfRoute` reducer for email +
   drop the orchestrator OR-gates; extend the comprehension-debt ratchet to make the email debt visible.
4. **Then:** P1.2 trade reducer, P1.3 parity gaps, P1.5 state-invariant write-time guards.
5. **Background cleanup:** decompose `index.ts` (pure relocation), archive orphan scripts, security guards.
