/**
 * human_mode_visit_commitment:eval — pins the soft appointment a REP-OWNED thread was never able
 * to record.
 *
 * ORIGIN. Operator report on Mohamed Ahmed `+17164258647`: *"should there have been a soft
 * appointment made for this with an outcome?"* On 2026-08-12 21:33Z he answered "the Deadwood just
 * arrived ... if you want to stop by and take a look at it" with **"Ok. Friday. Afternoon"**, and
 * `conv.appointment` stayed null with no task and no window. Two independent causes, both pinned
 * below:
 *   1. `/webhooks/twilio` handles a `mode === "human"` turn in its own block and returns long
 *      before every scheduling arm, so nothing on a rep-owned thread could record a visit at all.
 *   2. The visit-commitment parser read the turn `unclear` at 0.45 (4 runs in 4) because the
 *      commitment verb is in OUR question, not in the customer's reply. Asking the parser for the
 *      DAY it saw (the new `day` field) is what flipped that; the bare-day rule and few-shots that
 *      shipped alongside are a stability measure on the same shape (2/5 -> 5/5, ablated 2026-08-15)
 *      and the decision vote below CANNOT reliably detect their removal at 2/5 — the source pins in
 *      section 3 are the structural guard. Sabotage-measured, not assumed.
 *
 * MEASURED on the live store 2026-08-15: 178 of 860 conversations are human-mode and carry 66
 * inbound turns in 90 days naming a day without a clock time — NOT ONE produced a soft-appointment
 * task.
 *
 * WHAT IS ASSERTED. The DECISION (does a task get minted, and for which day), never the parser's
 * label — `unclear` and `no` both resolve to the same no-task outcome, so pinning a spelling would
 * make this a coin flip. The LLM section asserts a MAJORITY OF 3; every case below was measured at
 * **5/5 in the asserted direction** on 2026-08-15, and four of the six are deliberately NOT in the
 * parser's few-shots, so this cannot pass by reciting its own prompt.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  decideHumanModeVisitCommitmentTask,
  hasVisitDayHintText,
  parseVisitCommitmentWithLLM
} from "../services/api/src/domain/visitCommitmentParser.ts";

const CONFIDENT_YES = { visit_commitment: "yes" as const, day: "friday", confidence: 0.9 };
const base = {
  humanMode: true,
  threadClosed: false,
  dayHint: true,
  alreadyTasked: false,
  visitCommitment: CONFIDENT_YES
};

// ── 1) The pure decision table (no LLM) ──────────────────────────────────────────────────────
assert.deepEqual(
  decideHumanModeVisitCommitmentTask(base),
  { task: true, dayLabel: "friday", reason: "task" },
  "confident yes + a day on an open human-mode thread => the soft appointment task"
);

const declines: Array<[string, Parameters<typeof decideHumanModeVisitCommitmentTask>[0], string]> = [
  ["agent-owned thread", { ...base, humanMode: false }, "not_human_mode"],
  ["closed thread", { ...base, threadClosed: true }, "thread_closed"],
  ["no day mentioned at all", { ...base, dayHint: false }, "no_day_hint"],
  ["parser unavailable (LLM off / no key / error)", { ...base, visitCommitment: null }, "commitment_not_confirmed"],
  [
    "parser says no",
    { ...base, visitCommitment: { visit_commitment: "no", day: "", confidence: 0.95 } },
    "commitment_not_confirmed"
  ],
  [
    "parser is unsure",
    { ...base, visitCommitment: { visit_commitment: "unclear", day: "monday", confidence: 0.6 } },
    "commitment_not_confirmed"
  ],
  [
    "yes but under the confidence floor",
    { ...base, visitCommitment: { visit_commitment: "yes", day: "friday", confidence: 0.5 } },
    "commitment_not_confirmed"
  ],
  [
    "yes but named no day",
    { ...base, visitCommitment: { visit_commitment: "yes", day: "", confidence: 0.95 } },
    "no_day_named"
  ],
  ["the rep already has one open", { ...base, alreadyTasked: true }, "already_tasked"]
];
for (const [label, input, reason] of declines) {
  const d = decideHumanModeVisitCommitmentTask(input);
  assert.equal(d.task, false, `${label} => no task`);
  assert.equal(d.reason, reason, `${label} => reason ${reason}`);
}

// Every failure mode of the parser must land on today's behaviour, never on a task. This is the
// fail-direction assertion: the arm can only ever ADD a staff task, never a message.
for (const bad of [null, undefined, { visit_commitment: "unclear" as const, day: "friday", confidence: 0.99 }]) {
  assert.equal(
    decideHumanModeVisitCommitmentTask({ ...base, visitCommitment: bad }).task,
    false,
    "a parser that did not confidently say yes never mints a task"
  );
}

// The daypart must never reach the day label — "Friday. Afternoon" is a FRIDAY task.
assert.equal(
  decideHumanModeVisitCommitmentTask({
    ...base,
    visitCommitment: { visit_commitment: "yes", day: "  Friday  ", confidence: 0.9 }
  }).dayLabel,
  "friday",
  "the day label is normalised for resolveUpcomingDateFromDayLabel"
);

// ── 2) The hint gate — ELIGIBILITY only, verbatim live-store turns ────────────────────────────
for (const t of [
  "Ok. Friday. Afternoon",
  "See you Monday. ",
  "I will by Saturday",
  "Let's do Tuesday and I'll ride it a bit see if it's me or the bike.",
  "Thursday is fine",
  "Ok..Hopefully get lucky and they come tomorrow "
]) {
  assert.equal(hasVisitDayHintText(t), true, `day hint must fire on ${JSON.stringify(t)}`);
}
for (const t of ["", "how much is it out the door?", "Thanks a lot!", "Do you also have sportser S. ?"]) {
  assert.equal(hasVisitDayHintText(t), false, `day hint must NOT fire on ${JSON.stringify(t)}`);
}

// ── 3) Both-path wiring — the arm is actually reachable in the human-mode block ───────────────
const indexSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "services", "api", "src", "index.ts"),
  "utf8"
);
assert.ok(
  indexSrc.includes("resolveHumanModeVisitCommitmentTask({"),
  "the human-mode block must call the shared referee"
);
assert.ok(
  indexSrc.includes("human_mode_visit_commitment_task"),
  "every fire must record a route outcome (every exit records WHY)"
);
// It must mint the SAME task the agent lane mints, and must not compose a reply: a rep owns the
// thread. A publish/draft call inside this arm is the regression this line exists to catch.
const armStart = indexSrc.indexOf("resolveHumanModeVisitCommitmentTask({");
const arm = indexSrc.slice(armStart, armStart + 1200);
assert.ok(arm.includes("addSoftVisitStaffTask"), "the arm mints the shared soft-visit staff task");
assert.ok(!arm.includes("publishLiveTwilioReply"), "the arm must never send or draft a reply");
assert.ok(!arm.includes("applySoftVisitCadenceWindow"), "the arm must never touch the rep's cadence");

// ── 4) The comprehension the whole slice rests on (LLM; majority of 3) ────────────────────────
const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}
if (process.env.LLM_ENABLED !== "1" || process.env.LLM_VISIT_COMMITMENT_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_VISIT_COMMITMENT_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

type Case = {
  label: string;
  text: string;
  history: { direction: "in" | "out"; body: string }[];
  wantTask: boolean;
  inPrompt: boolean;
};
// Every message and every history line is a VERBATIM live-store row.
const cases: Case[] = [
  {
    label: "Mohamed — bare day + daypart accepting our own invite (+17164258647, the report)",
    text: "Ok. Friday. Afternoon",
    history: [
      {
        direction: "out",
        body: "Hey Mohamed, just wanted to let you know the Deadwood just arrived here at the dealership if you want to stop by and take a look at it."
      }
    ],
    wantTask: true,
    inPrompt: true
  },
  {
    label: "See you Monday (+17163168664)",
    text: "See you Monday. ",
    history: [
      { direction: "in", body: "Awesome     love it.  Don't be selling it to someone this time" },
      { direction: "out", body: "It's yours unless you tell me otherwise lol" }
    ],
    wantTask: true,
    inPrompt: false
  },
  {
    label: "Let's do Tuesday (+17162380781)",
    text: "Let's do Tuesday and I'll ride it a bit see if it's me or the bike.",
    history: [{ direction: "in", body: "Friday or Tuesday next" }],
    wantTask: true,
    inPrompt: false
  },
  {
    label: "NEGATIVE — a service question that names a day (+17163741119)",
    text: "Are you guys going to replace the ignition switch Monday",
    history: [],
    wantTask: false,
    inPrompt: false
  },
  {
    label: "NEGATIVE — their own travel, not a visit (Michelle Hyjek +17163164854)",
    text: "No I am out of town for my nieces wedding I come back Monday",
    history: [{ direction: "out", body: "Are you with Dave today?" }],
    wantTask: false,
    inPrompt: false
  },
  {
    label: "NEGATIVE — a PART arriving, not the customer (+17164233848)",
    text: "Ok..Hopefully get lucky and they come tomorrow ",
    history: [{ direction: "out", body: "your parts are on order" }],
    wantTask: false,
    inPrompt: false
  }
];

const RUNS = 3; // measured 5/5 in the asserted direction on every case (2026-08-15)
let checked = 0;
for (const c of cases) {
  assert.equal(hasVisitDayHintText(c.text), true, `${c.label}: must clear the hint gate`);
  let tasks = 0;
  const seen: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const parse = await parseVisitCommitmentWithLLM({ text: c.text, history: c.history });
    const d = decideHumanModeVisitCommitmentTask({
      humanMode: true,
      threadClosed: false,
      dayHint: true,
      alreadyTasked: false,
      visitCommitment: parse
    });
    if (d.task) tasks++;
    seen.push(`${parse?.visit_commitment ?? "null"}@${parse?.confidence ?? "-"}->${d.task ? d.dayLabel : d.reason}`);
  }
  const majority = tasks >= 2;
  assert.equal(
    majority,
    c.wantTask,
    `${c.label}: expected task=${c.wantTask}, got ${tasks}/${RUNS} [${seen.join(" ")}]`
  );
  checked++;
}
assert.ok(
  cases.filter(c => !c.inPrompt).length >= 4,
  "at least four cases must be absent from the parser's few-shots (no reciting its own prompt)"
);

console.log(
  `human_mode_visit_commitment:eval PASSED (${declines.length + 1} decision rows, ${checked} live-store turns x ${RUNS} runs)`
);
