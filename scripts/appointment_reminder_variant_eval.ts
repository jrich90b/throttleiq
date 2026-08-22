/**
 * appointment_reminder_variant:eval
 *
 * The 24-hour appointment reminder has TWO forms, and which one goes out is the decision.
 *
 * WHY. Charter **C4.4** suppresses "the 24h **YES/NO** reminder" once acknowledged or on a human
 * thread — it scopes the suppression to the robotic FORM. The warm form Joe described the same week
 * ("warm confirm naming the day + agent", 7/19) was never built, so `suppress` was the only lever
 * the code had, and the reminder went silent entirely: last customer reminder of any kind
 * **2026-07-19**, the day before the ruling, and 0 of 72 booked appointments eligible on 2026-08-21.
 *
 * THE NUMBER THAT DECIDES IT, measured on the live store 2026-08-21: **all six no-shows had
 * `acknowledged === true`.** Six for six. The population C4.4 silences is exactly the population
 * that forgets — confirming in your own words has never once predicted attendance here.
 *
 * Pins, in fail-direction order:
 *  1. the variant decision, executed on every combination;
 *  2. the YES/NO copy is UNCHANGED where we genuinely need an answer (the regression guard);
 *  3. the warm note ASKS FOR NOTHING — the whole point, and the thing that made the old text an
 *     offence rather than a service;
 *  4. it names no rep and does not re-introduce (C1.2a), so it is correct under either answer to
 *     Joe's open "whose name" question;
 *  5. it is WIRED, and the old inline template is gone (SKILL trap 2 — an unwired fix is inert).
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  resolveAppointmentReminderVariant,
  shouldSuppressAppointmentConfirmationReminder
} from "../services/api/src/domain/transitionSafety.ts";
import { buildAppointmentReminderMessage } from "../services/api/src/domain/agentVoice.ts";

let n = 0;

// --- 1. The decision, executed -----------------------------------------------------------------
{
  const cases: Array<[{ acknowledged?: boolean | null; humanMode?: boolean | null }, string, string]> = [
    [{ acknowledged: true, humanMode: false }, "warm_note", "Peter Meredith's shape: he said 'Sounds good see you Monday'"],
    [{ acknowledged: false, humanMode: true }, "warm_note", "a human owns the thread"],
    [{ acknowledged: true, humanMode: true }, "warm_note", "both"],
    [{ acknowledged: false, humanMode: false }, "confirm_ask", "never confirmed, bot-owned — we need an answer"],
    [{}, "confirm_ask", "unknown flags fall to the ask, exactly as the old gate did"],
    [{ acknowledged: null, humanMode: null }, "confirm_ask", "nulls are not acknowledgements"]
  ];
  for (const [args, expected, why] of cases) {
    assert.equal(resolveAppointmentReminderVariant(args), expected, why);
    n += 1;
  }
  // The variant must stay a pure re-reading of C4.4's own predicate — never a second, drifting copy
  // of the rule. This is what keeps Joe's ruling in ONE place.
  for (const args of [{ acknowledged: true }, { humanMode: true }, {}, { acknowledged: false, humanMode: false }]) {
    assert.equal(
      resolveAppointmentReminderVariant(args) === "warm_note",
      shouldSuppressAppointmentConfirmationReminder(args),
      "the variant is C4.4's predicate re-read, not a second copy of the rule"
    );
    n += 1;
  }
}

// --- 2. The YES/NO copy is unchanged where an answer is genuinely needed ------------------------
{
  const ask = buildAppointmentReminderMessage("confirm_ask", "Mon, Jul 6, 11:00 AM", "Peter");
  assert.equal(
    ask,
    "Reminder: you’re scheduled for Mon, Jul 6, 11:00 AM. Please reply YES to confirm or NO to reschedule.",
    "the confirm ask is byte-for-byte today's live text — this change must not rewrite it"
  );
  n += 1;
}

// --- 3. The warm note asks for NOTHING ----------------------------------------------------------
// This is the whole fix. Peter Meredith got a machine demanding a keystroke two days after he wrote
// "Sounds good see you Monday"; a note that requests no reply cannot re-ask a settled question.
{
  const warm = buildAppointmentReminderMessage("warm_note", "Mon, Jul 6, 11:00 AM", "Peter");
  assert.ok(warm.includes("Mon, Jul 6, 11:00 AM"), "the warm note states when");
  assert.ok(warm.includes("Peter"), "…and greets them by name");
  assert.ok(!warm.includes("?"), `the warm note must ask no question: ${warm}`);
  assert.ok(!/\breply\s+(yes|no)\b/i.test(warm), "no YES/NO demand");
  assert.ok(!/\b(confirm|reschedule)\b/i.test(warm), "it does not re-ask a settled booking");
  assert.ok(/no need to reply/i.test(warm), "and it says so out loud, so nobody feels chased");
  n += 6;

  const noName = buildAppointmentReminderMessage("warm_note", "Sat, Aug 22, 11:00 AM", null);
  assert.ok(noName.startsWith("Hey there,"), "a missing first name degrades to a greeting, never 'Hey null'");
  assert.ok(!noName.includes("?"), "…and still asks nothing");
  n += 2;
}

// --- 4. No rep name, no re-introduction ---------------------------------------------------------
// "Whose name" is an OPEN question for Joe (thread rep vs brand voice). Naming nobody is correct
// under either answer, so this ships without waiting on that ruling. C1.2a bars the intro outright:
// 24h before a booked visit the customer has certainly heard from us.
{
  for (const name of ["Peter", null]) {
    const warm = buildAppointmentReminderMessage("warm_note", "Mon, Jul 6, 11:00 AM", name);
    assert.ok(!/\bit['’]s\s+[A-Z]/.test(warm), `no self-introduction (C1.2a): ${warm}`);
    assert.ok(!/\bthis is\s+[A-Z]/i.test(warm), "no 'this is <rep>' either");
    assert.ok(!/\b(at|from|with)\s+American\b/i.test(warm), "and no dealer-name intro clause");
    n += 3;
  }
}

// --- 5. WIRED, and the old inline template is gone ----------------------------------------------
{
  const api = fs.readFileSync("services/api/src/index.ts", "utf8");
  assert.ok(
    api.includes("const reminderVariant = resolveAppointmentReminderVariant({"),
    "the send path must choose a variant"
  );
  assert.ok(
    api.includes("buildAppointmentReminderMessage(reminderVariant, when,"),
    "…and build the message from it"
  );
  // The old code `continue`d on suppression, so the warm note could never be reached. If that
  // early-exit comes back beside the variant, this ships INERT — the exact trap-2 shape.
  assert.ok(
    !api.includes("if (\n      shouldSuppressAppointmentConfirmationReminder({"),
    "the suppression early-exit must NOT come back — it would make the warm note unreachable"
  );
  assert.ok(
    !api.includes("Please reply YES to confirm or NO to reschedule.`"),
    "the inline reminder template must be gone, or the copy has two sources that can drift"
  );
  n += 4;
}

console.log(`PASS appointment reminder variant eval (${n} assertions)`);
