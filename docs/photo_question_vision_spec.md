# Photo-question vision ("ask about the picture we sent") — spec

**Status:** proposal for Joe's decision (2026-07-28). Not built. No production impact.
**Grounding case:** Tim Williams (+17163741119) asked why a light was off in a photo we'd sent —
and, tellingly, **the OTHER lights in the same photo were ON, so the bike was clearly powered up**,
which makes "that one light is dark" a real, worth-flagging observation, not a nothing.

## Goal
Let a customer ask a question about a photo **we already sent them** — "why is that light off?",
"what's that scratch?", "is that the touring seat?" — and have the agent **look at that exact photo,
reason about the whole scene, and reply honestly**, handing anything mechanical to a human.

## Why the Tim case is the whole point
A naive vision reply ("the light's off because the bike is probably powered down") would be **wrong
here** — the other lights prove the bike is ON. The feature is only valuable if the vision **reasons
about scene context**:
> "Good eye, Tim — the running and marker lights are lit, so the bike's powered up, and that one
> auxiliary light does look dark in the photo. That's worth a quick check — let me have a tech confirm
> it before you're back in."

That's the target: **describe + contextually reason + flag + hand off** — never a definitive "it's
broken" and never a dismissive "it's nothing."

## What already exists (reuse)
- The **vision primitive**: `describeUnitEquipmentWithLLM` (equipment/cholo vision) already sends an
  image URL + a structured prompt to the vision model and returns a typed read — proven today
  (stock-vs-real, real feed).
- `customerPhotoShare` — vision on **inbound** customer photos (→ catalog match). This new feature is
  the mirror: vision on an **outbound** photo WE sent, driven by the customer's question.
- Outbound photos are recorded on the messages (`mediaUrls`), so **we know exactly which image(s) the
  customer is reacting to** — no guessing.

## The flow (parser-first, comprehend-not-regex)
1. **Detect the intent (typed parser).** A new `parsePhotoReferenceQuestionWithLLM` reads the
   customer's turn + recent thread and decides: is this a QUESTION about a photo we sent, and what are
   they pointing at (`focus`: a light / a part / a scratch / color / general)? Fail-safe: null / low
   confidence → today's behavior. This is the route decision (centralized in `routeStateReducer`).
2. **Resolve the photo.** Pull the most recent outbound `mediaUrls` in the thread (the picture(s) we
   sent). If none, it isn't this flow → fall through.
3. **Vision Q&A (typed).** A new `answerPhotoQuestionWithLLM({ imageUrls, question, focus })` runs the
   vision model on THAT image with the customer's question. Structured output:
   `{ observation, sceneState, isFunctionalQuestion, confidence }` — e.g.
   `observation: "one auxiliary light appears unlit"`, `sceneState: "bike appears powered (other lights lit)"`,
   `isFunctionalQuestion: true`.
4. **Compose + route (deterministic decision).** `decidePhotoQuestionTurn`:
   - If it's a FUNCTIONAL / condition / "is it broken" question → reply describes what's visible +
     the scene reasoning, then **hands off to a tech** (a "check the <part> Tim asked about" task) —
     NEVER asserts working/broken from a still.
   - If it's a benign visual question (what part is this, what color, does it have X) that vision can
     answer confidently → answer it directly.
   - Low confidence / can't tell from the angle → "let me have someone take a closer look" + task.
   Wired in BOTH `/webhooks/twilio` and `/conversations/:id/regenerate`; suggest-mode draft (staff
   approve), like everything else.

## The guardrail (the part that must be right)
Applied inside the vision prompt AND the decision, mirroring the never-fabricate law:
- **Describe and reason about what's VISIBLE; never diagnose FUNCTION from a still.** "That light is
  dark in the photo, and the others are lit" = OK. "That light is burnt out / working fine" = NOT OK.
- **Any mechanical / condition / safety question → human/tech hand-off** with a task, plus the honest
  visual read so the customer feels heard.
- **Never invent** a part, a cause, or a reassurance. Bad angle → say so and offer a closer look.
- Reuses the existing photo/vision governance (confidence floor; fail toward "let me confirm").

## Eval plan
- Pure decision table (`decidePhotoQuestionTurn`): functional-question → describe+handoff+task;
  benign-visual → answer; low-confidence → closer-look+task; no-outbound-photo → none.
- Parser contract + flag-gating for both new parsers (dark by default).
- Reply-template guards: never asserts working/broken; a functional question always yields a tech task.
- LLM coverage (key present) on the Tim shape: photo with one dark light + others lit →
  observation names the dark light, sceneState = powered, isFunctionalQuestion = true, reply hands off.
- Source guards: both paths call the resolver; two-path parity.
- Ships DARK behind a flag; wired into ci:eval.

## Cost / performance
One vision call per photo-question turn (only when the parser fires — rare), in the suggest-mode draft
step, so no customer-facing latency. Pennies each; cache by image+question if a thread re-asks.

## Decisions (Joe ruled 2026-07-28) — design LOCKED
1. **Answer the easy ones, hand off anything functional.** A clearly-benign visual question ("is that
   the touring seat?", "what color is it?") the vision can answer confidently → answer directly. Any
   FUNCTIONAL / condition / "is it broken / working?" / safety question → honest visual read + tech
   hand-off (never diagnose from a still).
2. **The functional-question task is owned by the LEAD OWNER**, labeled e.g. "Customer asked about the
   <part> in the photo we sent — verify/confirm and follow up."
3. **Dark-first + canary:** ship behind a flag (default off), review a few real ones, then flip — same
   pattern as the photo-realness vision.
4. **Any outbound image** the customer references is in scope (inventory bikes AND service/other pics),
   resolved from the most recent outbound mediaUrls in the thread.
