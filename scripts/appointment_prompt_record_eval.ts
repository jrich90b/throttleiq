/**
 * appointment_prompt_record:eval — the "we already asked about this appointment" marks.
 *
 * Two prompts hang off a booked appointment, and each leaves a mark that is what stops it
 * repeating: the 24-hour YES/NO confirmation text (`appointment.confirmation`) and the internal
 * "did the customer show?" question put to staff afterwards (`attendanceQuestionedAt`). EIGHT
 * places used to write those marks by hand — six byte-identical copies of the same five-line
 * "pending" block inside `processAppointmentConfirmations` (one per delivery branch), the
 * customer's YES/NO reply, and the attendance ask. They now all ask
 * `decideAppointmentPromptRecord` and write through `applyAppointmentPromptRecord`.
 *
 * The un-stacking is BEHAVIOR-PRESERVING and the load-bearing table below is what proves it: the
 * three ORIGINAL inline shapes are re-encoded here and the referee must reproduce every one.
 * `decision_equivalence` cannot carry that proof — a brand-new referee has no baseline.
 *
 * WHY THE MARK IS LOAD-BEARING: `processAppointmentConfirmations` skips any appointment whose
 * `confirmation.sentAt` is already set, so a lane that stopped stamping it would re-text the same
 * customer every pass. That is the assertion this file exists to keep.
 *
 * TWO DIVERGENCES preserved on purpose and pinned here:
 *   D1 — three of the six reminder copies stamp "sent" WITHOUT sending: each delivery mode checks
 *        `isRecentDuplicateOutbound` first and, on a hit, marks the record and continues. Correct
 *        (the same text went out another way inside 10 minutes) and named so it is not "fixed"
 *        into re-texting a customer who has already been asked.
 *   D2 — the answer lane SPREADS the existing record where the sender REPLACES it. That is what
 *        keeps `sentAt` and the trigger metadata alive next to the answer; a replace would erase
 *        the ask and leave "answered at Y" with no "asked at X".
 *
 * NOT a divergence, pinned as such: the attendance mark is a bare clock with no status, because
 * that question goes to STAFF — no YES/NO comes back down this channel to record.
 */
import assert from "node:assert/strict";

const { decideAppointmentPromptRecord } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyAppointmentPromptRecord } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

const NOW = "2026-08-04T18:00:00.000Z";
const TRIGGER = {
  trigger: "auto_24h_confirmation_sms",
  triggeredAt: "2026-08-04T17:59:00.000Z",
  scheduledFor: "2026-08-05T18:00:00.000Z"
};

// ---------------------------------------------------------------------------
// LOAD-BEARING: the three ORIGINAL inline shapes, re-encoded.
//   reminder  `appt.confirmation = { sentAt: now, status: "pending", ...triggerMeta }`   (x6)
//   answer    `appt.confirmation = { ...appt.confirmation, status: yes?confirmed:declined,
//                                    respondedAt: now }`
//   attendance`appt.attendanceQuestionedAt = now`
// ---------------------------------------------------------------------------
{
  const conv: any = { id: "c1", appointment: { bookedEventId: "ev1", whenIso: NOW } };
  applyAppointmentPromptRecord(conv, {
    lane: "confirmation_reminder_sent",
    nowIso: NOW,
    triggerMeta: TRIGGER
  });
  assert.deepEqual(
    conv.appointment.confirmation,
    { sentAt: NOW, status: "pending", ...TRIGGER },
    "reminder lane must reproduce the original record exactly"
  );
  checks += 1;
  ok(
    conv.appointment.attendanceQuestionedAt === undefined,
    "the reminder lane must not touch the attendance mark"
  );
}

for (const [answer, status] of [
  ["yes", "confirmed"],
  ["no", "declined"]
] as const) {
  const conv: any = {
    id: "c1",
    appointment: {
      confirmation: { sentAt: "2026-08-03T18:00:00.000Z", status: "pending", ...TRIGGER }
    }
  };
  applyAppointmentPromptRecord(conv, { lane: "confirmation_answer", nowIso: NOW, answer });
  assert.deepEqual(
    conv.appointment.confirmation,
    {
      sentAt: "2026-08-03T18:00:00.000Z",
      ...TRIGGER,
      status,
      respondedAt: NOW
    },
    `answer=${answer} must keep the ask (D2) and record ${status}`
  );
  checks += 1;
}

{
  const conv: any = { id: "c1", appointment: { bookedEventId: "ev1" } };
  applyAppointmentPromptRecord(conv, { lane: "attendance_question_asked", nowIso: NOW });
  ok(
    conv.appointment.attendanceQuestionedAt === NOW,
    "the attendance lane must stamp attendanceQuestionedAt"
  );
  ok(
    conv.appointment.confirmation === undefined,
    "NOT a divergence, pinned: the attendance mark carries no confirmation status — that question goes to STAFF"
  );
}

// ---------------------------------------------------------------------------
// THE "ONLY ASK ONCE" RULE. `processAppointmentConfirmations` skips any appointment whose
// `confirmation.sentAt` is set, so the reminder lane MUST stamp it. This is the assertion that
// goes red if a delivery branch is unwired or the referee stops stamping.
// ---------------------------------------------------------------------------
ok(
  decideAppointmentPromptRecord({ lane: "confirmation_reminder_sent" }).stampSentAt === true,
  "the reminder lane must stamp sentAt — that mark IS the only-ask-once rule"
);
ok(
  decideAppointmentPromptRecord({ lane: "confirmation_reminder_sent" }).confirmationStatus ===
    "pending",
  "the reminder lane must leave the record pending so the YES/NO handler can accept an answer"
);
ok(
  decideAppointmentPromptRecord({ lane: "confirmation_reminder_sent" }).divergence ===
    "confirmation_reminder_marks_sent_even_when_a_duplicate_suppressed_the_send",
  "D1 must stay NAMED on the reminder decision"
);
ok(
  decideAppointmentPromptRecord({ lane: "confirmation_answer", answer: "yes" })
    .preserveExistingConfirmation === true,
  "D2: the answer lane must preserve the ask rather than replacing the record"
);
ok(
  decideAppointmentPromptRecord({ lane: "confirmation_reminder_sent" })
    .preserveExistingConfirmation === false,
  "D2: the sender replaces the record — it only ever runs when sentAt is blank"
);

// JUNK / SHAPE INPUT — targets the referee's shape, not its rules. An answer lane with no answer
// must fall to DECLINED, the original's `isYes ? confirmed : declined` else-branch: reading a
// missing answer as CONFIRMED would tell a customer we are still on when they said no.
ok(
  decideAppointmentPromptRecord({ lane: "confirmation_answer" }).confirmationStatus === "declined",
  "a missing answer must fall to declined, the original's else-branch — never to confirmed"
);
// An appointment-less conversation must be a no-op, not a crash: two of the lanes run inside
// corpus-wide sweeps.
{
  const bare: any = { id: "c1" };
  applyAppointmentPromptRecord(bare, { lane: "attendance_question_asked", nowIso: NOW });
  ok(bare.appointment === undefined, "a conversation with no appointment must be left alone");
}
for (const lane of [
  "confirmation_reminder_sent",
  "confirmation_answer",
  "attendance_question_asked"
] as const) {
  const d = decideAppointmentPromptRecord({ lane });
  ok(typeof d.why === "string" && d.why.includes(lane), `${lane}: why must name the lane`);
}

// ---------------------------------------------------------------------------
// WIRING: every raw write of these marks must live in the applier. `unrefereedWriterSites` alone
// has a blind spot — a site within 40 lines of ANOTHER applier call reads as refereed — so the
// invariant is asserted on the full write-site list instead.
// ---------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  const entry = rankContention(files, { minWrites: 1 }).find(f => f.field === "appointment");
  const marks = (entry?.writeSites ?? []).filter(s =>
    /\.(confirmation|attendanceQuestionedAt)\b/.test(s.snippet)
  );
  const strays = marks.filter(s => !s.file.endsWith("domain/conversationStore.ts"));
  ok(
    marks.length > 0,
    "the analyzer must still see these marks at all — a zero count would make this check vacuous"
  );
  ok(
    strays.length === 0,
    "confirmation / attendanceQuestionedAt may only be written inside applyAppointmentPromptRecord — strays: " +
      strays.map(s => `${s.file}:${s.line}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// The referee must be REGISTERED, or the next un-stacking ships with no evidence for it.
// ---------------------------------------------------------------------------
{
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer as any);
  ok(
    registry.some(e => (e.covers ?? []).includes("decideAppointmentPromptRecord")),
    "decideAppointmentPromptRecord must be sampled in buildDecisionRegistry"
  );
  const sampled = registry.filter(e => e.name.startsWith("appointmentPromptRecord:")).length;
  ok(sampled === 4, `all three lanes (answer twice) must be sampled separately, found ${sampled}`);
}

console.log(`appointment_prompt_record:eval OK (${checks} checks)`);
