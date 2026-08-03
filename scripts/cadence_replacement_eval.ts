/**
 * cadence_replacement:eval — ONE referee for "may this trigger REPLACE the chase already running,
 * and with what tempo?"
 *
 * WHAT WAS FIGHTING. `decideCadenceStart` guards the three exported entry points that lay a chase
 * (`startFollowUpCadence`, `startPostSaleCadence`, `scheduleLongTermFollowUp`), and its
 * `standard_ramp` lane REFUSES outright when any cadence record exists — active or stopped —
 * because quietly overwriting a chase somebody deliberately ended is the fail-unsafe direction.
 *
 * Four places never go through those entry points at all. Each MINTS the whole
 * `conv.followUpCadence` object itself, so that refusal never applies to it:
 *
 *   finance_declined              index.ts  applyFinanceOutcomeStatusFromSignal
 *   license_credit_pending        index.ts  applyActionStateFromContextNote
 *   seller_photo_details_request  index.ts  maybeStartCadence
 *   over_eager_engaged_realign    conversationStore.ts  realignOverEagerEngagedCadence
 *
 * Two philosophies in one field. This referee puts them side by side and NAMES the disagreement;
 * it does not settle it — that would be a behavior change, and this is a behavior-PRESERVING
 * un-stacking.
 *
 * THE THREE DIVERGENCES, PINNED AS-IS:
 *
 *   1. ADMISSION. Three of the four test the running chase not at all — they overwrite whatever is
 *      there, including a `stopped` cadence. Only `over_eager_engaged_realign` looks first, and it
 *      is the odd one out because it is a HEALER: it exists to downshift a chase, so it has to know
 *      which chase it is downshifting.
 *
 *   2. THE INVITE BUDGET. `finance_declined` alone leaves `scheduleInviteCount` / `scheduleMuted`
 *      off the minted record entirely, where the other three write 0 / false. Every reader
 *      coalesces (`cad.scheduleInviteCount ?? 0`; an absent `scheduleMuted` is falsy), so the two
 *      shapes behave the same today — but they are not the same STORED record, so the omission is
 *      preserved exactly rather than tidied into a uniform shape.
 *
 *   3. THE ANCHOR. `license_credit_pending` anchors the cadence at its own FUTURE due date; every
 *      other lane anchors at the clock read. `anchorAt` is what the ladder-age math reads, and a
 *      future anchor makes `ageDays` negative, which `decideBurnedCadenceLadderRealign` treats as
 *      "no_anchor" and declines to touch — so that lane is exempt from ladder realignment while its
 *      anchor is in the future. The fewer-corrections direction, so preserved.
 *
 * FAIL DIRECTION. Every `replace: true` throws away a chase and lays a new one, which can only ever
 * START proactive texting. So an unrecognized trigger is REFUSED rather than waved through: a
 * caller that forgets to register its lane loses a cadence, it never gains one.
 *
 * THE LOAD-BEARING SECTION is "the four original rules, re-encoded" below: it replays every
 * (trigger x stored cadence) pair through the hand-written rules exactly as they read before the
 * un-stacking, and asserts the referee answers identically. That is the behavior-preservation
 * claim, stated as an executable table rather than as a promise. `decision_equivalence` cannot
 * carry it — a brand-new referee has no baseline for the harness to compare against.
 *
 * Unwiring a CALL SITE is caught directly, not just by the total: the last section asks the
 * contention analyzer whether any unrefereed writer still mints a whole cadence record, and names
 * the offending file:line. The ratchet total alone is not enough — removing a write can un-collapse
 * a neighbouring one, so +1 and -1 can cancel and report green on a real re-stacking.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/cadence_replacement_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `cadence-replacement-eval-${Date.now()}.json`);

const { decideCadenceReplacement } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyCadenceReplacement, FOLLOW_UP_DAY_OFFSETS, LONG_TERM_DAY_OFFSETS, FINANCE_DECLINED_DAY_OFFSETS } =
  await import("../services/api/src/domain/conversationStore.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-03T15:00:00.000Z";
const DUE = "2026-08-24T13:00:00.000Z";
const TZ = "America/New_York";

const TRIGGERS = [
  "finance_declined",
  "license_credit_pending",
  "seller_photo_details_request",
  "over_eager_engaged_realign"
] as const;

/** Every cadence shape a lead can actually be carrying. `null` = no cadence record at all. */
const CADENCE_STATES: Array<{ label: string; cadence: any }> = [
  { label: "no cadence", cadence: null },
  { label: "active engaged", cadence: { status: "active", kind: "engaged", anchorAt: NOW, stepIndex: 2 } },
  { label: "active standard", cadence: { status: "active", kind: "standard", anchorAt: NOW, stepIndex: 4 } },
  { label: "active long_term", cadence: { status: "active", kind: "long_term", anchorAt: NOW, stepIndex: 1 } },
  { label: "stopped engaged", cadence: { status: "stopped", kind: "engaged", anchorAt: NOW, stepIndex: 5 } },
  { label: "completed engaged", cadence: { status: "completed", kind: "engaged", anchorAt: NOW, stepIndex: 9 } }
];

// --- the four original rules, re-encoded ---------------------------------------------------------
// This is the behavior-preservation proof. Each entry is the admission test and record shape that
// call site carried BEFORE the un-stacking, transcribed literally from the inline object.
type Shape = {
  replace: boolean;
  kind?: string;
  ladder?: string;
  anchor?: string;
  writeInviteBudget?: boolean;
  writeContextTag?: boolean;
};
type RealignFacts = {
  tempoCappedToLongTerm: boolean;
  conversationClosed: boolean;
  appointmentBooked: boolean;
  followUpMode: string | null;
  followUpReason: string | null;
  hasInventoryWatch: boolean;
};

const ORIGINAL_RULES: Record<(typeof TRIGGERS)[number], (cad: any, facts: RealignFacts) => Shape> = {
  // conv.followUpCadence = { status, anchorAt: now, nextDueAt: due(now, FINANCE_DECLINED[0]),
  //                          stepIndex: 0, kind: "long_term" };   — no test on the running chase,
  //                          and no scheduleInviteCount / scheduleMuted keys at all.
  finance_declined: () => ({
    replace: true,
    kind: "long_term",
    ladder: "finance_declined",
    anchor: "now",
    writeInviteBudget: false,
    writeContextTag: false
  }),
  // conv.followUpCadence = { status, anchorAt: dueAtIso, nextDueAt: dueAtIso, stepIndex: 0,
  //                          kind: "engaged", contextTag, contextTagUpdatedAt,
  //                          scheduleInviteCount: 0, scheduleMuted: false };
  license_credit_pending: () => ({
    replace: true,
    kind: "engaged",
    ladder: "standard",
    anchor: "due",
    writeInviteBudget: true,
    writeContextTag: true
  }),
  // conv.followUpCadence = { status, anchorAt: now, nextDueAt: due(now, FOLLOW_UP[0]), stepIndex: 0,
  //                          kind: "engaged", contextTag, contextTagUpdatedAt,
  //                          scheduleInviteCount: 0, scheduleMuted: false };
  seller_photo_details_request: () => ({
    replace: true,
    kind: "engaged",
    ladder: "standard",
    anchor: "now",
    writeInviteBudget: true,
    writeContextTag: true
  }),
  // if (!cad || cad.status !== "active" || cad.kind !== "engaged") return false;
  // if (!cadenceTempoCappedToLongTerm(conv.lead)) return false;
  // if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) return false;
  // if (conv.appointment?.bookedEventId) return false;
  // if (mode === manual_handoff | paused_indefinite | holding_inventory) return false;
  // if (conv.followUp?.reason === "inventory_watch" || conv.inventoryWatch) return false;
  // conv.followUpCadence = { status, anchorAt: now, nextDueAt: due(now, LONG_TERM[0]), stepIndex: 0,
  //                          kind: "long_term", scheduleInviteCount: 0, scheduleMuted: false };
  over_eager_engaged_realign: (cad, f) => {
    if (!cad || cad.status !== "active" || cad.kind !== "engaged") return { replace: false };
    if (!f.tempoCappedToLongTerm) return { replace: false };
    if (f.conversationClosed) return { replace: false };
    if (f.appointmentBooked) return { replace: false };
    const mode = String(f.followUpMode ?? "");
    if (mode === "manual_handoff" || mode === "paused_indefinite" || mode === "holding_inventory") {
      return { replace: false };
    }
    if (f.followUpReason === "inventory_watch" || f.hasInventoryWatch) return { replace: false };
    return {
      replace: true,
      kind: "long_term",
      ladder: "long_term",
      anchor: "now",
      writeInviteBudget: true,
      writeContextTag: false
    };
  }
};

const CLEAN_FACTS: RealignFacts = {
  tempoCappedToLongTerm: true,
  conversationClosed: false,
  appointmentBooked: false,
  followUpMode: null,
  followUpReason: null,
  hasInventoryWatch: false
};

/** Every way the healer's admission test can be defeated, one gate at a time. */
const REALIGN_FACT_CASES: Array<{ label: string; facts: RealignFacts }> = [
  { label: "clean", facts: CLEAN_FACTS },
  { label: "timeframe not capped", facts: { ...CLEAN_FACTS, tempoCappedToLongTerm: false } },
  { label: "closed or sold", facts: { ...CLEAN_FACTS, conversationClosed: true } },
  { label: "already booked in", facts: { ...CLEAN_FACTS, appointmentBooked: true } },
  { label: "manual_handoff", facts: { ...CLEAN_FACTS, followUpMode: "manual_handoff" } },
  { label: "paused_indefinite", facts: { ...CLEAN_FACTS, followUpMode: "paused_indefinite" } },
  { label: "holding_inventory", facts: { ...CLEAN_FACTS, followUpMode: "holding_inventory" } },
  { label: "active mode is fine", facts: { ...CLEAN_FACTS, followUpMode: "active" } },
  { label: "inventory_watch reason", facts: { ...CLEAN_FACTS, followUpReason: "inventory_watch" } },
  { label: "a stored watch", facts: { ...CLEAN_FACTS, hasInventoryWatch: true } }
];

/**
 * `computeFollowUpDueAt` jitters the send time inside a 10:30-12:30 local window with
 * `Math.random()`, so a due DATE is assertable and an exact timestamp is not. This reads the local
 * calendar day out of an instant, which is the part the ladder actually decides.
 */
const localDay = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));

/** The local day an offset off the ladder lands on — computed the way the ladder computes it. */
const expectedDueDay = (anchorIso: string, offsetDays: number): string => {
  const [y, m, d] = localDay(anchorIso).split("-").map(Number);
  const rolled = new Date(Date.UTC(y, m - 1, d));
  rolled.setUTCDate(rolled.getUTCDate() + offsetDays);
  return rolled.toISOString().slice(0, 10);
};

/** The minted record with the jittered due date lifted out, so the rest can be compared exactly. */
const recordWithoutDueAt = (cad: any) => {
  const { nextDueAt: _drop, ...rest } = cad ?? {};
  return rest;
};

const project = (d: any): Shape =>
  d.replace
    ? {
        replace: true,
        kind: d.kind,
        ladder: d.ladder,
        anchor: d.anchor,
        writeInviteBudget: d.writeInviteBudget,
        writeContextTag: d.writeContextTag
      }
    : { replace: false };

// The full cross-product: every trigger x every stored cadence x every realign fact set.
for (const trigger of TRIGGERS) {
  for (const { label, cadence } of CADENCE_STATES) {
    for (const { label: factLabel, facts } of REALIGN_FACT_CASES) {
      const expected = ORIGINAL_RULES[trigger](cadence, facts);
      const decision = decideCadenceReplacement({
        trigger,
        existing: cadence ? { status: cadence.status, kind: cadence.kind } : null,
        ...facts
      });
      eq(
        project(decision),
        expected,
        `${trigger} on a ${label} lead (${factLabel}) answers exactly what its own inline rule answered`
      );
    }
  }
}

// --- divergence 1: only the healer reads the running chase ---------------------------------------
{
  const stopped = { status: "stopped", kind: "engaged" };
  for (const trigger of ["finance_declined", "license_credit_pending", "seller_photo_details_request"] as const) {
    const d = decideCadenceReplacement({ trigger, existing: stopped });
    eq(d.replace, true, `${trigger} overwrites a deliberately stopped chase, as it does today`);
    eq(
      d.divergence,
      "replaces_a_deliberately_stopped_chase",
      `${trigger} NAMES that it is overwriting a chase somebody ended on purpose`
    );
  }
  const healer = decideCadenceReplacement({
    trigger: "over_eager_engaged_realign",
    existing: stopped,
    ...CLEAN_FACTS
  });
  eq(healer.replace, false, "the healer refuses a stopped chase — it only ever downshifts a live one");
  // ...and it does NOT claim the divergence, because refusing IS decideCadenceStart's philosophy.
  eq(healer.divergence, null, "a refusal names no divergence");
}

// --- the fail direction: an unregistered lane loses a cadence, it never gains one ------------------
for (const bogus of ["", "  ", "cadence_start", "finance_approved", "unknown_trigger"]) {
  const d = decideCadenceReplacement({ trigger: bogus });
  eq(d.replace, false, `an unrecognized trigger ("${bogus}") is refused, never waved through`);
}

// --- the applier writes the record each site used to write inline --------------------------------
{
  // finance_declined: no contextTag, and the invite-budget keys are ABSENT (divergence 2).
  const conv: any = { followUpCadence: { status: "active", kind: "engaged", stepIndex: 6 } };
  applyCadenceReplacement(conv, { trigger: "finance_declined", anchorAtIso: NOW, timeZone: TZ });
  eq(
    recordWithoutDueAt(conv.followUpCadence),
    { status: "active", anchorAt: NOW, stepIndex: 0, kind: "long_term" },
    "finance_declined mints exactly the record it used to build inline"
  );
  eq(
    localDay(conv.followUpCadence.nextDueAt),
    expectedDueDay(NOW, FINANCE_DECLINED_DAY_OFFSETS[0]),
    "finance_declined's first touch lands on the finance-declined ladder's first rung"
  );
  eq(
    Object.keys(conv.followUpCadence),
    ["status", "anchorAt", "nextDueAt", "stepIndex", "kind"],
    "divergence 2: the finance lane's record carries NO schedule-invite budget keys at all"
  );
}
{
  // license_credit_pending: anchored at the FUTURE due date (divergence 3), tag + budget written.
  const conv: any = { followUpCadence: { status: "stopped", kind: "standard", stepIndex: 3 } };
  applyCadenceReplacement(conv, {
    trigger: "license_credit_pending",
    anchorAtIso: NOW,
    timeZone: TZ,
    dueAtIso: DUE,
    contextTag: "license_credit_pending"
  });
  eq(
    conv.followUpCadence,
    {
      status: "active",
      anchorAt: DUE,
      nextDueAt: DUE,
      stepIndex: 0,
      kind: "engaged",
      contextTag: "license_credit_pending",
      contextTagUpdatedAt: NOW,
      scheduleInviteCount: 0,
      scheduleMuted: false
    },
    "license_credit_pending mints exactly the record it used to build inline"
  );
  eq(
    Date.parse(conv.followUpCadence.anchorAt) > Date.parse(NOW),
    true,
    "divergence 3: this lane's anchor sits in the FUTURE, unlike every other lane"
  );
}
{
  // seller_photo_details_request: anchored NOW, off the standard ladder.
  const conv: any = {};
  applyCadenceReplacement(conv, {
    trigger: "seller_photo_details_request",
    anchorAtIso: NOW,
    timeZone: TZ,
    contextTag: "seller_photo_details_request"
  });
  eq(
    recordWithoutDueAt(conv.followUpCadence),
    {
      status: "active",
      anchorAt: NOW,
      stepIndex: 0,
      kind: "engaged",
      contextTag: "seller_photo_details_request",
      contextTagUpdatedAt: NOW,
      scheduleInviteCount: 0,
      scheduleMuted: false
    },
    "seller_photo_details_request mints exactly the record it used to build inline"
  );
  eq(
    localDay(conv.followUpCadence.nextDueAt),
    expectedDueDay(NOW, FOLLOW_UP_DAY_OFFSETS[0]),
    "seller_photo_details_request's first touch lands on the STANDARD ladder's first rung"
  );
}
{
  // over_eager_engaged_realign: downshifts onto the long_term ladder, no contextTag.
  const conv: any = { followUpCadence: { status: "active", kind: "engaged", stepIndex: 4 } };
  const decision = applyCadenceReplacement(conv, {
    trigger: "over_eager_engaged_realign",
    anchorAtIso: NOW,
    timeZone: TZ,
    realign: {
      tempoCappedToLongTerm: true,
      conversationClosed: false,
      appointmentBooked: false,
      hasInventoryWatch: false
    }
  });
  eq(decision.replace, true, "a clean over-eager engaged chase is downshifted");
  eq(
    recordWithoutDueAt(conv.followUpCadence),
    {
      status: "active",
      anchorAt: NOW,
      stepIndex: 0,
      kind: "long_term",
      scheduleInviteCount: 0,
      scheduleMuted: false
    },
    "over_eager_engaged_realign mints exactly the record it used to build inline"
  );
  eq(
    localDay(conv.followUpCadence.nextDueAt),
    expectedDueDay(NOW, LONG_TERM_DAY_OFFSETS[0]),
    "the downshifted chase's next touch lands ~30 days out on the LONG_TERM ladder, not the standard one"
  );
}
{
  // ...and a refusal leaves the stored chase completely untouched.
  const stored = { status: "active", kind: "engaged", stepIndex: 4, nextDueAt: DUE };
  const conv: any = { followUpCadence: { ...stored }, followUp: { mode: "manual_handoff" } };
  const decision = applyCadenceReplacement(conv, {
    trigger: "over_eager_engaged_realign",
    anchorAtIso: NOW,
    timeZone: TZ,
    realign: {
      tempoCappedToLongTerm: true,
      conversationClosed: false,
      appointmentBooked: false,
      hasInventoryWatch: false
    }
  });
  eq(decision.replace, false, "a manual_handoff thread's chase is left for the human who owns it");
  eq(conv.followUpCadence, stored, "a refused replacement writes nothing at all");
}
{
  // The applier reads the mode/reason off the CONVERSATION, not from its input bag — an inventory
  // watch reason blocks the healer even when the caller passes a clean realign fact set.
  const stored = { status: "active", kind: "engaged", stepIndex: 4 };
  const conv: any = { followUpCadence: { ...stored }, followUp: { mode: "active", reason: "inventory_watch" } };
  const decision = applyCadenceReplacement(conv, {
    trigger: "over_eager_engaged_realign",
    anchorAtIso: NOW,
    timeZone: TZ,
    realign: {
      tempoCappedToLongTerm: true,
      conversationClosed: false,
      appointmentBooked: false,
      hasInventoryWatch: false
    }
  });
  eq(decision.replace, false, "an inventory-watch lead keeps the tempo the watch owns");
  eq(conv.followUpCadence, stored, "and its chase is untouched");
}

// --- no unrefereed writer may still mint a whole cadence record ----------------------------------
// The direct form of the un-wiring test. The ratchet TOTAL is not enough on its own: removing an
// inline write can un-collapse a neighbouring one, so a +1 and a -1 cancel and the total reports
// green on a genuine re-stacking (measured on #462).
{
  const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");
  const ROOT = path.resolve("services/api/src");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(ROOT);
  const row = rankContention(files as any, { minRawWrites: 1 }).find((r: any) => r.field === "followUpCadence");
  eq(Boolean(row), true, "the contention analyzer still sees the followUpCadence field");
  const minters = ((row as any).unrefereedWriterSites ?? []).filter((site: any) => site.wholesale === true);
  eq(
    minters.map((s: any) => `${s.file}:${s.line}`),
    [],
    `no unrefereed writer may mint a whole cadence record — found: ${minters
      .map((s: any) => `${s.file}:${s.line} (${s.fn})`)
      .join(", ")}`
  );
}

// --- the referee is registered with the equivalence harness ---------------------------------------
// An un-stacking whose referee is missing from buildDecisionRegistry ships with no evidence behind
// it: decision_equivalence would report IDENTICAL because it never looked.
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) =>
    (entry.covers ?? []).includes("decideCadenceReplacement")
  );
  eq(covered.length, TRIGGERS.length, "every replacement trigger is sampled by the equivalence harness");
  for (const trigger of TRIGGERS) {
    eq(
      covered.some((entry: any) => entry.name === `cadenceReplacement:${trigger}`),
      true,
      `the harness samples the ${trigger} lane specifically`
    );
  }
  // ...and the samples must actually project — a sampler that silently returns undefined for every
  // lead is the "compared nothing" failure the harness exists to refuse.
  const lead = { followUpCadence: { status: "active", kind: "engaged", anchorAt: NOW, stepIndex: 3 } } as any;
  for (const entry of covered) {
    eq(entry.sample(lead, { nowMs: Date.parse(NOW), timeZone: TZ }) !== undefined, true,
      `${entry.name} projects a real answer off a stored cadence`);
  }
}

console.log(`cadence_replacement:eval OK — ${checks} checks`);
