# LeadRider Policy Charter — americanharley

**v1 — compiled 2026-07-30 from Joe's rulings (2026-06 → 2026-07-29). Ratified by Joe's
signature on the PR that introduced it.**

## North star (Joe, confirmed 2026-07-29 night)

LeadRider is the business, not a tool for one store: a self-running AI BDC any dealer can
turn on. American Harley is dealer #1 — the proof and the sales pitch. **Dealer #2 is
triggered by a READINESS BAR, not a sales conversation** (Joe: "I believe a readiness bar"):
the concrete artifacts are `docs/dealer_ready_checklist.md` (every row verified WORKING),
the release gate's clean-day streak, no open P0/P1, and the rollout-readiness scorecard.

What this means for every decision made under this charter: portability outranks
AH-specific polish; an AH-only hardcode is debt; the standing question on every build is
"would this work at a dealer we've never met?"; and anything that requires Joe (or any
owner) in the daily loop is a defect against the goal, not a feature.

### The bar, as five tests (Joe, confirmed 2026-07-30 — "Ok")

The readiness bar is scored by `scripts/rollout_readiness_report.ts` into
`reports/rollout_readiness/latest.json`. It has FIVE sections, and **all five are visible
from day one** — a section we have not measured yet reads `NOT_MEASURED`, never omitted:

1. **Funnel** — answer / book / show rates against the 58/16/27 baseline (offered 58%,
   booked 16%, offer→book 27%; americanharley, 30d, 6/16, sales-scoped), plus first-touch
   latency.
2. **Portability** — the universal-vs-dealer eval split is clean, and the count of
   AH hardcodes sitting in universal code paths is at or under its ratchet.
3. **Operability** — every `docs/dealer_ready_checklist.md` row WORKING, the release gate's
   clean-day streak at target, no open P0/P1, and escalations that need a human trending down.
4. **Stranger test** — has a fresh synthetic "dealer #2" been provisioned **from config
   alone** and passed the gates cold? Yes/no + date. Starts at *not yet attempted*.
5. **Pitch numbers** — response time, booking lift, BDC hours replaced: what we can
   actually claim to dealer #2. Starts at *not yet measured*.

**The score must not flatter.** The bar is MET only when every section meets its target AND
no section is still unmeasured — an unmeasured section blocks the bar exactly like a failing
one, so "we never checked" can never round up to "we're ready." Targets are proposed by the
loop and live in `READINESS_TARGETS` in that script; they are Joe's to veto in one place.

## What this document is

The machine-consulted record of **settled policy**: every product/behavior decision Joe has
already made, in one place. It is the boundary line in the Tier-2 split (AGENTS.md
"Autonomous Self-Healing Loop"):

- A Tier-2 change that **implements or corrects toward a rule in this charter** is
  **Tier-2a**: it may merge without pre-approval when the cross-model reviewer cleanly
  approves AND confirms the cited rule genuinely covers the change, gates are green, and a
  kill switch or clean revert exists. Joe is notified **after**, with a plain-English
  summary and the revert path. A Joe veto demotes that category back to ask-first.
- A Tier-2 change with **no covering rule here** is **Tier-2b**: ping Joe and wait.
  **Unsure whether a rule covers it ⇒ it doesn't. Ask.**
- A citation must be **specific** (one rule ID, e.g. `C3.2`), and the reviewer judges the
  fit adversarially. Stretching a rule to cover a new judgment call is the failure mode
  this file exists to prevent.

Amending this file is itself Tier-2b (Joe signs), with one exception: **recording a new
ruling Joe just made** (with the date and his wording) is Tier-1 doc-work.

### Standing improvement authority (Joe, 2026-07-30 — "You are the expert")

Joe: *"If you notice anything that can be improved or something that is not in line with
achieving the end goal I want to give you the freedom to make the fix."* Standing grant to
all sessions and routines:

- **Non-behavioral improvements** (tooling, routines, docs, evals, priorities, refactors,
  de-duplication, cost/waste removal): fix directly under Tier-1 rules; note it in the run
  report. Don't ask.
- **Customer-behavior changes with no covering rule id** that clearly serve the North star:
  treat as Tier-2a with the citation **`NS`** — the cross-model reviewer is shown the
  North-star section and judges the alignment claim adversarially, with the same
  clean-approve + coverage requirement, the same notify-after, the same veto/demotion. A
  stretched alignment claim must fail coverage exactly like a stretched rule citation.
- **Never covered by this grant (unchanged):** the always-Tier-2b list below, and ANY
  expansion of the agent's own authority — authority is granted only by Joe, in his own
  words, ratified the way this section was.

### Always Tier-2b, even if a rule below seems to cover it
Compliance / opt-out behavior; pricing, payment or finance FIGURES the agent may state;
any brand-new reply class (a kind of message never sent before); flag flips from
shadow/draft/dark → enforce/live/auto-send; core-comprehension / model-authority /
parser-consolidation cutovers (the de-tangle endgame, per CLAUDE.md); anything with legal
exposure; changes to this charter's boundary rules.

---

## C1 — Voice & composition

- **C1.1** Voice is "texting a friend" per `docs/voice_charter.md`; no AI-tells
  (banned-phrase list), no emoji icons in UI (shared `UiIcon` set). *(charter initiative;
  no-emoji ruling)*
- **C1.2** The full self-intro ("it's Alexandra over at American Harley-Davidson") is
  INTENDED on both text and email first touches — keep it; don't dedupe it away. *(7/26 #3:
  "Keep the intro")*
- **C1.2a** …but ONLY on a first touch. Once the customer has received ANY message from us on
  the thread, never introduce again — no "Hey there, it's {name} over at {dealer}". A second
  lead form from the same customer is still the same thread: answer the new bike, don't restart.
  And the name must not change mid-thread across channels: if they met Alexandra by text, the
  email is Alexandra too. *(7/23 #: Brian +17166021492 got a fresh self-intro on turn 25; 8/15:
  Boyd +17169401820 and Mark +17169071289 re-introduced on a second demo-ride lead the next day)*
- **C1.3** Replies hard-anchor to the live conversation: price/MSRP answers lock to the
  bike under discussion THIS TURN, never a stale ADF lead-record vehicle. *(7/23 #6)*
- **C1.4** Never attribute to the customer a claim they didn't make (timeframes, colors,
  demo rides): customer-sourced facts only; ADF form fields are not the customer speaking.
  *(7/19 #3; fabricated-frame class; GLA demo-ride 7/29 refinement: lead source alone never
  proves a ride happened)*
- **C1.5** Answer, don't hedge/deflect: a direct question gets a direct answer or an honest
  named handoff — never a vague "I'll check and follow up" when the data is on hand.
  *(answer-don't-hedge program; 7/24 #5 open-ask "honest bail")*
- **C1.6** Walk-in acks recap the LOGGED SPEC from parsed slots only — never staff-note
  prose, and never a dollar figure from a walk-in note (could be a trade appraisal).
  *(7/28 #4)*
- **C1.7** **Every customer-facing reply ends with ONE question that advances the lead**,
  fitted to what the customer just said and preferring a choice of two ("cash or finance?",
  "Saturday afternoon or Monday evening?"). The agent's job is a salesperson's: drive
  appointments and sales, politely. "At most one question per message" is a CEILING, never a
  floor. Four structural exceptions, and they are decided in CODE, never in prompt text (as
  prompt caveats they lost 3 of 3 probes, including asking a newly bereaved customer to
  schedule): `needsEmpathy`, `dispositionClosing` (not interested), `alreadyPurchased`, and a
  booked appointment. A suppressed turn means DO NOT PUSH, not never ask — it falls back to
  the legacy rules, which still ask when the thread calls for it. **This rule binds our
  deterministic TEMPLATES exactly as it binds the LLM composer**: a hardcoded ack that ends
  in a statement is out of compliance with it, the same way template copy must pass our own
  voice charter. *(Joe 8/7, option 3 of three: "Treat this as you are a human salesman
  looking to be polite like the ai in the example and your main job is to drive appointments
  and sales" · "Must be appropriate questions to the conversation" · "Asking questions would
  really be a way to control the flow of the conversation". Built as PR #606 `a939baca`; Joe
  approved turning it on 8/8 — "Ok approve d deploy" — and `DRAFT_ADVANCE_EVERY_REPLY=1` has
  been live in the runtime env since 2026-08-08T12:35:55Z. The baseline it moves: only 65 of
  383 replies, 17%, ended by asking anything in the prior 30 days.)*
- **C1.8** Never offer to show someone a bike they have already ridden. On a
  `GLA - Demo Ride - DAT` lead the ride DID happen — Joe ran the event and saw those customers —
  so the first touch says so ("Hope you enjoyed riding the …") and must NOT say "if you'd ever
  like to see one in person". This lane ONLY: every other demo-ride source keeps the rule that
  the lead source alone never proves a ride happened, and an unknown source falls back to it.
  Unchanged either way: no appointment times, no availability claim, no follow-up cadence.
  *(Joe 8/15 "2 yes", knowingly superseding the completed-ride half of his 7/02 ruling for this
  lane; he reported the sentence three times first. Built as PR #721.)*

## C2 — When to stay silent

- **C2.1** Call-only leads: never draft/send SMS; give them a day-1 call task instead.
  *(7/9 #1; 7/24 #3)*
- **C2.2** Enthusiasm/closing acks with no question ("Can't wait", "you too!") get no
  reply — reciprocate a warm closer once, then stop. *(7/17 Q6; conversation-closeout)*
- **C2.3** International (out-of-country) numbers: stay silent, log "international lead"
  to CRM, close. *(7/22 #4)*
- **C2.4** Human-owned threads: greeting the owner after a human send draws no auto-draft;
  human mode suppresses customer-facing auto replies. *(owner-thread step-back)*
- **C2.5** Marketplace relay leads (no phone/email): never attempt to message; create a
  "reply in Facebook" task on the owner with a ready-to-paste drafted reply. Driving a
  personal FB account is RULED OUT (ToS). *(7/24 #1)*
- **C2.6** Vendor HTML notices, bare tapbacks/emoji reactions: no draft; excluded from
  stuck-turn and scorer counts. *(7/22 #8; scoring exclusions)*

## C3 — Cadence & follow-ups

- **C3.1** Later touches are VALUE-gated: bring a real reason (offer, arrival, price drop)
  or don't touch; never generic check-ins. "Not at this time" ⇒ long-term value-gated
  deferral. *(high-quality-cadence principle; 7/26 #6)*
- **C3.2** Cadence NEVER references: a unit that's held/sold (no re-pitching its numbers
  either), a dated event already past, a promo on the wrong model-year, or new-bike
  national-promo financing on a used unit (unknown condition = used). *(7/28 #3; 7/22 #5,
  #2, #6)*
- **C3.3** An unengaged lead with a NEW unit SHOULD still get a genuine national-promo
  financing touch — value-gated proactive outreach to quiet leads is intended, not spam.
  *(7/22 #6 follow-up)*
- **C3.4** Calls don't silence cadence ("I would not want the robot to go quiet once
  called") — voicemails change nothing; a live call yields the voice next-step plan:
  customer-owed step ⇒ cadence waits; staff promise ⇒ dated task; 48h breather after a live
  conversation. Unsure ⇒ cadence continues. *(7/19 #1)*
- **C3.5** Staff manual sends PAUSE cadence but never advance/burn ladder steps; a parsed
  "I'll decide soon" ⇒ dated 2-3 day owner check-in task. *(7/23 #2)*
- **C3.6** Timeframe mapping: 4+ months ⇒ long_term (ADF and Meta promo alike).
  Ride-challenge cadence anchors to the EVENT date. Custom-coverage touches: NEW bikes
  only. Post-sale warranty reminder: new-bike only. *(initial-ADF timeframe; 7/9 #3, #4)*
- **C3.7** Human-thread quiet nudge: hands-off bump after ~3 quiet days, max 2 bumps,
  rep's voice, value-gated. *(7/23 #1)*
- **C3.8** The disengaged taper closes out HONESTLY — no fake "no rush" framing. *(7/29)*
- **C3.9** Soft visit commitment ("I'll be there Saturday") holds cadence ~3 days AND
  creates an upcoming-visit staff task. *(7/17 Q4; soft-visit cadence)*

## C4 — Scheduling & appointments

- **C4.1** Confirm, don't re-ask: a customer-named day gets a confirmation (day-level ⇒
  soft-visit hold; concrete time ⇒ auto-book live; regen is draft-only). *(7/11 #1;
  scheduling-auto-book-on-confirm)*
- **C4.2** A stated time WINDOW books at its START ("between 4 and 5" ⇒ 4:00). *(7/28 #1,
  #2)*
- **C4.3** Never offer a test-ride time on a bike not in stock (stock-check first).
  *(test-ride stock-check-first)*
- **C4.4** A settled (past + showed) appointment can't be "rescheduled" by a stray parse;
  the 24h YES/NO reminder is suppressed once acknowledged or on human threads. *(7/19
  follow-ups #236; settled-appt guard)*
- **C4.5** Staff availability: PRESUME AVAILABLE — answer from the rep's calendar; only a
  day-off-semantics block flips to not-in; calendar unreadable ⇒ named "let me check with
  [rep]" handoff + task, never guess a NO. Confirming a visit-to-see-a-rep drops an FYI
  task on that rep. *(7/23 #8)*
- **C4.6** Service visits: parser-first department check before the service scheduling
  handoff; service appointments are a HANDOFF, never a booked slot (no DMS); "drop off
  Tuesday" is service, not a sales soft-visit. *(#242; service-appt handoff; 7/11 #1
  exclusion)*
- **C4.7** Business-hours questions are answered from `scheduler_config.businessHours`
  (deterministic template) — Saturday is 9–3; detection of the question is parser work.
  *(7/29 "build it" ruling)*

## C5 — Inventory watches

- **C5.1** Watch alerts fire on FUTURE arrivals + hold-release only; in-stock-on-create
  alerting stays OFF until Joe flips it (flag exists, 45-day freshness bound). *(7/27;
  7/25 #2)*
- **C5.2** The watch target is the bike the customer WANTS: a trade-listed bike can never
  become the watch target; a staff note's stated want outranks the ADF vehicle field;
  never watch a model lifted from our own question. *(7/22 #1; 7/24 #6; connective-garbage
  guard)*
- **C5.3** Family-only references ("a trike", "an 883") ⇒ ask WHICH model, never guess or
  set a family-wide watch; cross-family never fires; same-family gets one clarify ask.
  Attribute terms narrow or clarify — never hard-resolve. Ruled aliases: bagger ≠ trikes;
  "3 wheeler" = trikes; fixed/frame-mounted/sharknose fairing = Road Glide;
  batwing/fork-mounted = Street/Electra Glide. *(7/11 #4; 7/24 glossary rulings)*
- **C5.4** No impossible YEAR pins and no "new" on discontinued models; sanitize
  trim/color junk; duplicate watches merge; per-conversation daily alert cap — same-day
  matches bundle into ONE text. *(#244; 7/22 #3; #260; 7/23 #4)*
- **C5.5** A different-color match still alerts, WITH honest disclosure of the color
  difference — never claim it's what they watched for. *(7/23 #5)*
- **C5.6** Closing a conversation ("not interested right now") does NOT kill a live watch;
  watch opt-out is parser-first and pauses the watch. *(7/24 #7; watch-opt-out)*
- **C5.7** Finish/equipment gates SUPPRESS only on a confident opposite read, never
  require an assertion. *(#329/#330)*

## C6 — Trade-ins & acquisition

- **C6.1** A trade-tagged ADF vehicle never becomes the motorcycle of interest. *(standing)*
- **C6.2** Trade + down-payment volunteered without a payment ask ⇒ GATHER info, don't
  fire the calculator; the calculator requires an explicit numbers ask. *(7/9 #7; #183)*
- **C6.3** Non-motorcycle trades (camper/RV/car) get a warm handoff. "Do you buy bikes?" ⇒
  sell-TO-dealer acquisition flow (answer + appraisal task), not a sales pivot. *(standing;
  #286; #324)*

## C7 — Finance & pricing

- **C7.1** Finance "needs more info" ALWAYS routes to a business-manager handoff with an
  OPEN task listing lender items; never quote/guess rates, payments, approval terms, or
  lender claims not present in the note. *(7/11 #2; 7/23 #10)*
- **C7.2** Pre-qualification ≠ credit application: prequals get normal follow-up + cadence,
  no outcome task; a TLP staff note mentioning credit doesn't make it a credit-app lead
  (structured source/App ID only). *(7/9 #5; #332)*
- **C7.3** Credit-app/prequal ADF leads also get a finance-specific EMAIL draft with a
  booking link. *(7/25 #1)*
- **C7.4** National-promo financing figures are real (Harley's page) but NEW-bike-scope
  only; Riding Academy graduate offers only to affirmatively new/unlicensed riders or
  Academy mentions. *(7/22 #6; 7/23 #7)*
- **C7.5** Payment methods FAQ is deterministic; AH card cap $1,000. *(standing)*
- **C7.6** Price objection ⇒ acknowledge + offer a cheaper-option watch, never re-quote;
  a soft objection ("a little out of my range") earns ONE gentle budget-capture reply,
  then respect silence. A stated budget outranks the original unit in sold/hold cadence
  touches. *(7/23 #6; 7/17 Q1; 7/29)*

## C8 — Campaigns, broadcasts & events

- **C8.1** EVENT blasts reach everyone; PROMO blasts skip in-play/sold/hold. Only
  sweepstakes auto-archive. *(event-vs-promo suppression; event-promo ≠ sales drafts)*
- **C8.2** Campaign 'sent' tag fades after 14 days; 'reply' never fades; a blast tags
  without reordering the inbox. *(campaign-tag lifecycle)*
- **C8.3** Broadcasts are not graded as 1:1 voice. *(voice-charter exclusion)*

## C9 — Closing, disposition & reopen

- **C9.1** A live ask never closes a lead: if the customer deferred but asked for
  something (pics, price), answer it — don't brush off and close. Never close a lead the
  affordability/ride-confidence guard protects. *(live-ask-never-closes; KEEP-guard 6/22)*
- **C9.2** A clean decline auto-archives (not just closes); an SMS reopens a
  closed-with-HOLD thread; SOLD never reopens. *(7/22 #7; hold-thread reopen)*
- **C9.3** Wrongful-close triage: pin the actual closing call site first — human console
  archives are not agent closes. *(7/29 anomaly review)*

## C10 — ADF & intake routing

- **C10.1** Department ADFs (parts/apparel/service) route to their department before any
  availability heuristic; merch = apparel; an apparel-widget lead asking about a BIKE gets
  a clarify (dept vs bike), not a sales pivot. *(standing; 7/26 #4)*
- **C10.2** ADF sales leads are TEXT-FIRST unless preferred contact = email ⇒ email draft;
  the intro matches what the customer actually RECEIVED (first received message). *(7/26
  #5 + #323; ADF-intro-first-received)*
- **C10.3** Web-widget non-sales leads get a handoff-ack draft, not silence and not a
  sales pitch; service-history asks route to service_records handoff, not scheduling.
  *(standing)*
- **C10.4** Non-buyer survey ADFs get a warm no-pressure ack. *(standing)*

## C11 — Tasks, handoffs & staff

- **C11.1** A staff promise in a manual outbound ("I'll send numbers Monday") becomes a
  dated task + cadence hold. *(manual-outbound promise)*
- **C11.2** Fulfilled tasks auto-close (0.85 floor); needs-your-reply clears on first real
  staff outbound; media-only MMS counts as photo fulfillment. *(task-fulfillment; 7/23 #10)*
- **C11.3** Handed-off leads that go stale get staff todos, not customer cadences;
  takeover threads that go quiet drop an owner task. *(stale-handoff net; #223)*
- **C11.4** 👎 = "report this message": staff instructions in the note route to a human;
  the redraft WAITS for and OBEYS the staff note. *(thumbs-down routing; 7/23 #3)*
- **C11.5** In-process deals are SILENT for the agent; the owner gets a "nudge?" todo
  after ~3 days. *(in-process-deal)*

## C12 — Photos & vision

- **C12.1** Photos are understood by vision, never a filename/database lookup; photo
  requests serve REAL photos from the live feed or create a task — never fabricate.
  *(photo handling; #312)*
- **C12.2** Questions about a photo WE sent: benign visual questions answered; FUNCTIONAL
  questions go to a tech. *(#322)*

## C13 — Ops & loop conduct

- **C13.1** Deploys: API only via `npm run deploy:api` (profile flag law); web deploys
  require the hard-refresh warning. Corrective-fix PRs stay small and parser-first; the
  eval-first rule for parser coverage (evals always, few-shots only on a failing row).
  *(CLAUDE.md; 7/29 eval-first ruling)*
- **C13.2** KPI counts bucket by LEAD-arrival date (leave as-is). *(7/29)*
- **C13.3** Salespeople see their own + unassigned leads. *(standing)*

---

*Recording a ruling here: add the rule under its section with the date + source; never
rewrite an existing rule's meaning without Joe (that's Tier-2b by definition).*
