/**
 * closeout_reversal:eval — ONE referee for "something wants this closed lead back in the working
 * inbox; may it reopen, and does that erase the closeout?"
 *
 * WHAT WAS FIGHTING. Four places un-did a closeout inline, each writing `status`, `closedAt` and
 * `closedReason` on its own reading of the same stored state:
 *
 *   customer_inbound    a customer texted/emailed a closed thread (appendInbound, conversationStore)
 *   staff_reopen        staff pressed Reopen (POST /conversations/:id/reopen, index.ts)
 *   walkin_hold_note    a CRM walk-in note says a bike is being held (sendgridInbound)
 *   walkin_hold_clear   a CRM walk-in note says the hold is over (sendgridInbound)
 *
 * `decideInventoryAvailabilityReopen` (PR #463) already owned the FIFTH cause — an inventory record
 * disappearing. These four are the rest of the question.
 *
 * WHY IT IS TIER 1. Reopening puts a lead back in the working inbox, where the agent will chase it;
 * refusing leaves a live buyer buried. Both directions end at a customer.
 *
 * FAIL DIRECTION — the unusual one, shared with the inventory referee. The irreversible thing
 * (closing a live lead) already happened, so REOPENING is the safe answer. What stays conservative
 * is the refusal arm and the cause test: an unrecognized cause changes nothing at all.
 *
 * THE LOAD-BEARING SECTION is section 1: the four ORIGINAL inline rules are re-encoded here verbatim
 * as a lookup table, and the referee is asserted to match them for every (cause x stored state)
 * combination. That is what turns "behavior-preserving" from a claim into an executable table, and
 * it is the section that goes red first when the referee drifts.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/closeout_reversal_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `closeout-reversal-eval-${Date.now()}.json`);

const { decideCloseoutReversal } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyCloseoutReversal, isBareAckInboundText, isDeclineCloseoutReason } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
const reducer: any = await import("../services/api/src/domain/routeStateReducer.ts");

let checks = 0;
const ok = (condition: boolean, message: string) => {
  checks += 1;
  assert.ok(condition, message);
};

const ALL_CAUSES = [
  "customer_inbound",
  "staff_reopen",
  "walkin_hold_note",
  "walkin_hold_clear"
] as const;

// ---------------------------------------------------------------------------------------------
// 1. THE LOAD-BEARING TABLE — the four ORIGINAL inline rules, re-encoded, asserted against the
//    referee for every (cause x stored state) pair.
//
//    These four functions are transcriptions of the code that USED to sit at the four write sites.
//    They are deliberately verbose and deliberately NOT refactored: their only job is to be an
//    independent second opinion about what the system did before the un-stacking.
// ---------------------------------------------------------------------------------------------
type Verdict = { reopen: boolean; clearCloseout: boolean };
type Conv = {
  status: string;
  closedReason?: string;
  closedAt?: string;
  sale?: { soldAt?: string };
  hold?: Record<string, unknown>;
  followUp?: { reason?: string };
};
type Inbound = { body?: string; mediaUrls?: string[] };

/** conversationStore.appendInbound, as it stood before this un-stacking. */
function originalCustomerInbound(conv: Conv, evt: Inbound): Verdict {
  if (conv.status === "closed") {
    const closedReason = String(conv.closedReason ?? "").toLowerCase();
    const soldSticky =
      closedReason === "sold" ||
      !!conv.sale?.soldAt ||
      /\bpost_sale\b/.test(String(conv.followUp?.reason ?? "").toLowerCase());
    const holdSticky =
      !soldSticky &&
      (/\bhold\b/.test(closedReason) ||
        !!conv.hold ||
        /\b(unit_hold|order_hold|manual_hold)\b/.test(
          String(conv.followUp?.reason ?? "").toLowerCase()
        ));
    const bareAck = !(evt.mediaUrls && evt.mediaUrls.length) && isBareAckInboundText(evt.body);
    const stickyClosed = soldSticky || (holdSticky && bareAck);
    const archivedAckHold =
      (/archive/.test(closedReason) || isDeclineCloseoutReason(closedReason)) && bareAck;
    if (!stickyClosed && !archivedAckHold) {
      return { reopen: true, clearCloseout: true };
    }
  }
  return { reopen: false, clearCloseout: false };
}

/** POST /conversations/:id/reopen, as it stood before this un-stacking. Unconditional. */
function originalStaffReopen(_conv: Conv): Verdict {
  return { reopen: true, clearCloseout: true };
}

/** Both walk-in hold arms in sendgridInbound, as they stood before this un-stacking. */
function originalWalkInHold(conv: Conv): Verdict {
  const clears = !!conv.closedReason && /\bhold\b/i.test(String(conv.closedReason));
  return { reopen: true, clearCloseout: clears };
}

const STATUSES = ["open", "closed"] as const;
const CLOSED_REASONS = [
  undefined,
  "sold",
  "Sold Elsewhere",
  "not_interested",
  "customer_deferred",
  "unit_hold",
  "hold_for_customer",
  // NOT the same as the two above, and the difference is load-bearing: `_` is a word character, so
  // `/\bhold\b/` does NOT match inside "unit_hold" or "hold_for_customer". Only a reason with the
  // word standing on its own trips the hold matchers. Both shapes are in the table on purpose.
  "bike on hold",
  "archived_by_staff",
  "no_response"
] as const;
const FOLLOWUP_REASONS = [
  undefined,
  "post_sale",
  "unit_hold",
  "order_hold",
  "manual_hold",
  "active"
] as const;
// One bare ack, one emoji-only ack, one real message — the bare-ack test is the switch every
// sticky rule turns on, so it has to be exercised in both directions with real bodies.
const BODIES = ["ok", "👍", "I am on my way to pick it up"] as const;

let tableRows = 0;
for (const cause of ALL_CAUSES) {
  for (const status of STATUSES) {
    for (const closedReason of CLOSED_REASONS) {
      for (const followUpReason of FOLLOWUP_REASONS) {
        for (const hasSale of [false, true]) {
          for (const hasHold of [false, true]) {
            for (const body of BODIES) {
              for (const hasMedia of [false, true]) {
                const conv: Conv = {
                  status,
                  closedReason,
                  closedAt: status === "closed" ? "2026-07-01T00:00:00.000Z" : undefined,
                  sale: hasSale ? { soldAt: "2026-06-01T00:00:00.000Z" } : undefined,
                  hold: hasHold ? { reason: "manual_hold" } : undefined,
                  followUp: followUpReason ? { reason: followUpReason } : undefined
                };
                const evt: Inbound = {
                  body,
                  mediaUrls: hasMedia ? ["https://example.test/a.jpg"] : undefined
                };
                const expected =
                  cause === "customer_inbound"
                    ? originalCustomerInbound(conv, evt)
                    : cause === "staff_reopen"
                      ? originalStaffReopen(conv)
                      : originalWalkInHold(conv);

                const bareAck =
                  cause === "customer_inbound" && status === "closed"
                    ? !hasMedia && isBareAckInboundText(body)
                    : false;
                const actual = decideCloseoutReversal({
                  cause,
                  isClosed: status === "closed",
                  closedReason: conv.closedReason ?? null,
                  followUpReason: conv.followUp?.reason ?? null,
                  hasSoldSale: !!conv.sale?.soldAt,
                  hasHoldRecord: !!conv.hold,
                  bareAck,
                  declineCloseoutReason:
                    cause === "customer_inbound"
                      ? isDeclineCloseoutReason(conv.closedReason ?? null)
                      : false
                });
                tableRows += 1;
                ok(
                  actual.reopen === expected.reopen && actual.clearCloseout === expected.clearCloseout,
                  `the referee changed behavior for cause=${cause} status=${status} ` +
                    `closedReason=${String(closedReason)} followUpReason=${String(followUpReason)} ` +
                    `sale=${hasSale} hold=${hasHold} body=${JSON.stringify(body)} media=${hasMedia}: ` +
                    `original {reopen:${expected.reopen},clearCloseout:${expected.clearCloseout}} vs ` +
                    `referee {reopen:${actual.reopen},clearCloseout:${actual.clearCloseout}}`
                );
              }
            }
          }
        }
      }
    }
  }
}
ok(tableRows > 3000, `the equivalence table must actually cover the space (covered ${tableRows} rows)`);

// ---------------------------------------------------------------------------------------------
// 2. FAIL DIRECTION — an unrecognized cause changes NOTHING.
// ---------------------------------------------------------------------------------------------
for (const cause of ["", "  ", "reopened", "manual", "hold_released"]) {
  const d = decideCloseoutReversal({ cause, isClosed: true, closedReason: "no_response" });
  ok(
    d.reopen === false && d.clearCloseout === false,
    `an unrecognized closeout-reversal cause ("${cause}") must change nothing — got ` +
      `reopen=${d.reopen} clearCloseout=${d.clearCloseout}`
  );
}
// `hold_released` belongs to the INVENTORY referee, not this one. Two referees answering the same
// cause is the fight this whole program removes, so this one must refuse it.
ok(
  decideCloseoutReversal({ cause: "hold_released", isClosed: true }).reopen === false,
  "an inventory-availability cause must be refused here — decideInventoryAvailabilityReopen owns it"
);

// ---------------------------------------------------------------------------------------------
// 3. DIVERGENCE 1 — only the CUSTOMER arm may be refused.
// ---------------------------------------------------------------------------------------------
{
  const sold = { isClosed: true, closedReason: "sold", hasSoldSale: true };
  const customer = decideCloseoutReversal({ cause: "customer_inbound", ...sold, bareAck: true });
  ok(!customer.reopen, "a bare ack on a SOLD thread must not reopen it");
  ok(
    customer.divergence === "only_the_customer_arm_may_be_refused_a_reopen",
    `the refusal must name its divergence — got ${String(customer.divergence)}`
  );
  for (const cause of ["staff_reopen", "walkin_hold_note", "walkin_hold_clear"] as const) {
    ok(
      decideCloseoutReversal({ cause, ...sold, bareAck: true }).reopen,
      `${cause} is an explicit human instruction and must reopen unconditionally — it is not ` +
        "filtered by the sold/hold sticky rules the customer arm applies"
    );
  }
  // The customer arm on an ALREADY-OPEN thread is a no-op, exactly as the old `if (closed)` gate was.
  ok(
    !decideCloseoutReversal({ cause: "customer_inbound", isClosed: false }).reopen,
    "customer_inbound on an already-open thread must do nothing"
  );
}

// ---------------------------------------------------------------------------------------------
// 4. DIVERGENCE 2 — a walk-in note reopens but keeps a NON-hold closeout reason.
// ---------------------------------------------------------------------------------------------
for (const cause of ["walkin_hold_note", "walkin_hold_clear"] as const) {
  const nonHold = decideCloseoutReversal({ cause, isClosed: true, closedReason: "not_interested" });
  ok(
    nonHold.reopen && !nonHold.clearCloseout,
    `${cause} on a non-hold closeout must reopen WITHOUT erasing the reason staff recorded`
  );
  ok(
    nonHold.divergence === "walkin_note_reopens_but_keeps_a_non_hold_closeout_reason",
    `${cause} must name that divergence — got ${String(nonHold.divergence)}`
  );
  const holdish = decideCloseoutReversal({ cause, isClosed: true, closedReason: "bike on hold" });
  ok(
    holdish.reopen && holdish.clearCloseout,
    `${cause} on a hold closeout must reopen AND clear it`
  );
  // The word-boundary quirk, pinned deliberately: `_` is a word character, so an underscore-joined
  // reason like "unit_hold" does NOT read as a hold closeout here and the reason survives the
  // reopen. Preserved from the original inline test; changing it would silently erase closeouts.
  const underscored = decideCloseoutReversal({ cause, isClosed: true, closedReason: "unit_hold" });
  ok(
    underscored.reopen && !underscored.clearCloseout,
    `${cause} must treat "unit_hold" as a NON-hold closeout reason, exactly as the original did`
  );
  // Staff Reopen always erases the whole closeout — that is the half of the divergence that matters.
  ok(
    decideCloseoutReversal({ cause: "staff_reopen", isClosed: true, closedReason: "not_interested" })
      .clearCloseout,
    "staff_reopen must always erase the whole closeout, unlike the walk-in arms"
  );
}

// ---------------------------------------------------------------------------------------------
// 5. THE APPLIER WRITES WHAT THE REFEREE DECIDED — and nothing more.
// ---------------------------------------------------------------------------------------------
{
  const reopened: any = {
    status: "closed",
    closedAt: "2026-07-01T00:00:00.000Z",
    closedReason: "no_response"
  };
  applyCloseoutReversal(reopened, { cause: "customer_inbound", inboundBody: "when can I come by?" });
  ok(
    reopened.status === "open" &&
      reopened.closedAt === undefined &&
      reopened.closedReason === undefined,
    "a real customer message on a no-response closeout must reopen it and clear the closeout"
  );

  const stayedSold: any = {
    status: "closed",
    closedAt: "2026-07-01T00:00:00.000Z",
    closedReason: "sold",
    sale: { soldAt: "2026-06-01T00:00:00.000Z" }
  };
  applyCloseoutReversal(stayedSold, { cause: "customer_inbound", inboundBody: "thanks!" });
  ok(
    stayedSold.status === "closed" && stayedSold.closedReason === "sold",
    "a bare thanks on a sold deal must leave the thread closed and the closeout intact"
  );

  const mediaWins: any = { status: "closed", closedReason: "archived_by_staff" };
  applyCloseoutReversal(mediaWins, {
    cause: "customer_inbound",
    inboundBody: "ok",
    inboundHasMedia: true
  });
  ok(
    mediaWins.status === "open",
    "an attachment is never a bare ack — an archived thread with media must reopen"
  );

  const walkIn: any = { status: "closed", closedAt: "x", closedReason: "not_interested" };
  applyCloseoutReversal(walkIn, { cause: "walkin_hold_note" });
  ok(
    walkIn.status === "open" && walkIn.closedReason === "not_interested" && walkIn.closedAt === "x",
    "a walk-in hold note must reopen without erasing a non-hold closeout"
  );

  const untouched: any = { status: "closed", closedAt: "x", closedReason: "no_response" };
  applyCloseoutReversal(untouched, { cause: "not_a_real_cause" });
  ok(
    untouched.status === "closed" && untouched.closedReason === "no_response",
    "an unrecognized cause must not write anything"
  );
}

// ---------------------------------------------------------------------------------------------
// 6. THE DECISION REGISTRY SAMPLES EVERY ARM — or decision-equivalence cannot see the divergences.
// ---------------------------------------------------------------------------------------------
{
  const registry = buildDecisionRegistry(reducer);
  const names = new Set(
    (Array.isArray(registry) ? registry : Object.values(registry ?? {})).map((entry: any) =>
      String(entry?.name ?? entry?.key ?? entry)
    )
  );
  const sampled = [...names].filter(n => n.startsWith("closeoutReversal:"));
  for (const cause of ALL_CAUSES) {
    ok(
      sampled.some(n => n.includes(cause)),
      `the decision registry must sample closeoutReversal for ${cause} — otherwise a change to that ` +
        "arm is invisible to decision-equivalence"
    );
  }
  // The customer arm needs BOTH bare-ack probes; it is the only arm whose answer turns on it.
  ok(
    sampled.filter(n => n.startsWith("closeoutReversal:customer_inbound")).length >= 2,
    "the customer arm must be sampled with bareAck both true and false"
  );
}

// ---------------------------------------------------------------------------------------------
// 7. NOBODY REOPENS A LEAD BEHIND THE REFEREE'S BACK.
//
// Asserted through the same analyzer the ratchet uses rather than by matching source text, and for
// the same reason `reschedule_pending_latch:eval` does it this way: a +1/-1 write-collapse can make
// `state_writer_contention:eval` report green on a genuine re-stacking. Outside the two store
// helpers (this referee and the inventory one), no unrefereed writer of `status` may set it back to
// "open". Closing is the sibling question and is deliberately still allowed to appear here.
// ---------------------------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { rankContention, unstackingQueue } = await import(
    "../services/api/src/domain/stateWriterContention.ts"
  );

  const root = nodePath.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({
          path: nodePath.relative(process.cwd(), full),
          text: fs.readFileSync(full, "utf8")
        });
      }
    }
  };
  walk(root);

  const ranked = rankContention(files as any, { minWrites: 1 });
  const offenders: string[] = [];
  for (const field of ["status", "closedReason", "closedAt"]) {
    const entry: any = unstackingQueue(ranked as any, { minUnguarded: 1 }).find(
      (f: any) => f.field === field
    );
    for (const site of entry?.unrefereedWriterSites ?? []) {
      // `status = "open"` is the reopen write. `closedReason`/`closedAt` cleared to undefined is the
      // closeout erase. Both belong to a referee now.
      const snippet = String(site.snippet ?? "");
      const reopens = /status\s*=\s*"open"/.test(snippet);
      const erases = /(closedReason|closedAt)\s*=\s*undefined/.test(snippet);
      if (reopens || erases) offenders.push(`${site.file}:${site.line} — ${snippet}`);
    }
  }
  ok(
    offenders.length === 0,
    "a place outside applyCloseoutReversal / applyInventoryAvailabilityReopen un-closes a lead " +
      "without asking a referee — route it through applyCloseoutReversal instead. Offending " +
      `site(s): ${offenders.join(" | ")}`
  );
}

console.log(
  `PASS closeout reversal — one referee for un-closing a lead across 4 causes ` +
    `(${checks} checks, ${tableRows} equivalence-table rows; 2 divergences preserved and named)`
);
