/**
 * cadence_lifecycle:eval — ONE referee for "may this caller stop / pause / resume the chase?"
 *
 * WHAT WAS FIGHTING. `followUpCadence` is the field that TEXTS people. Four places moved it between
 * active, paused and stopped, each with its own preconditions and its own idea of which companion
 * fields get cleared:
 *
 *   stop     stopFollowUpCadence(conv, reason)      the general "end this chase" verb
 *   pause    pauseFollowUpCadence(conv, until, r)   hush it until a date, keep it alive
 *   resume   resumeFollowUpCadence(conv, tz)        bring a STOPPED chase back
 *   close    closeConversation(conv, reason)        stopped the chase INLINE, bypassing `stop`
 *
 * All four now ask `decideCadenceLifecycle` through `applyCadenceLifecycle`.
 *
 * WHY IT IS TIER 1. Stopping a chase that should run drops a live lead; leaving one running after
 * the sale texts a customer about a bike they already bought. Both directions end at a customer.
 *
 * FAIL DIRECTION: fewer texts. Refusing a transition leaves the chase where it is, and the states
 * this referee can refuse into are quieter than the alternative. An unrecognized verb changes nothing.
 *
 * THE LOAD-BEARING SECTION is section 1: the four ORIGINAL inline rules are re-encoded as a lookup
 * table and the referee is asserted to match them for every (verb x stored state x reason) triple.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/cadence_lifecycle_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `cadence-lifecycle-eval-${Date.now()}.json`);

const { decideCadenceLifecycle } = await import("../services/api/src/domain/routeStateReducer.ts");
const {
  applyCadenceLifecycle,
  stopFollowUpCadence,
  pauseFollowUpCadence,
  closeConversation
} = await import("../services/api/src/domain/conversationStore.ts");
const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
const reducer: any = await import("../services/api/src/domain/routeStateReducer.ts");

let checks = 0;
const ok = (condition: boolean, message: string) => {
  checks += 1;
  assert.ok(condition, message);
};

const ALL_VERBS = ["stop", "pause", "resume", "close"] as const;

// ---------------------------------------------------------------------------------------------
// 1. THE LOAD-BEARING TABLE — the four ORIGINAL inline rules, re-encoded and asserted.
//
//    Deliberately verbose, deliberately NOT refactored: their only job is to be an independent
//    second opinion about what each verb did before the un-stacking.
// ---------------------------------------------------------------------------------------------
type Cad = { status?: string; kind?: string } | undefined;
/** What the original code WROTE. `null` = it returned without touching anything. */
type Wrote = {
  status: string | null;
  clearNextDue: boolean;
  clearPause: boolean;
  clearStopReason: boolean;
} | null;

/** stopFollowUpCadence, as it stood before this un-stacking. */
function originalStop(cad: Cad, reason: string): Wrote {
  if (!cad) return null;
  if (
    (reason === "manual_handoff" || reason === "purchase_delivery") &&
    (cad.kind === "post_sale" || cad.kind === "long_term")
  ) {
    return null;
  }
  return { status: "stopped", clearNextDue: true, clearPause: true, clearStopReason: false };
}

/** pauseFollowUpCadence, as it stood before this un-stacking. Never changes the status. */
function originalPause(cad: Cad): Wrote {
  if (!cad || cad.status !== "active") return null;
  return { status: null, clearNextDue: false, clearPause: false, clearStopReason: false };
}

/** resumeFollowUpCadence, as it stood before this un-stacking. */
function originalResume(cad: Cad): Wrote {
  if (!cad || cad.status !== "stopped") return null;
  return { status: "active", clearNextDue: false, clearPause: true, clearStopReason: true };
}

/** The inline cadence stop inside closeConversation, as it stood before this un-stacking. */
function originalClose(cad: Cad): Wrote {
  if (!cad?.status) return null;
  // NOTE: no post-sale protection, and it does NOT clear the pause fields. Both are divergences.
  return { status: "stopped", clearNextDue: true, clearPause: false, clearStopReason: false };
}

/**
 * THE ONE DELIBERATE DEPARTURE from the originals (2026-08-04, Charles Desalvo +17168614216).
 *
 * `originalClose` above is kept verbatim as the historical record. This is the single input shape
 * where the referee now REFUSES what the original wrote, on purpose: closing a lead BECAUSE IT
 * SOLD must not stop the post-sale owner sequence, which is the very thing the close hands off to.
 * Joe filed "No sold cadence" on a customer who bought a Street Glide on 2026-08-03; the walk-in
 * sold branch asked `stop` (correctly spared, divergence 1) and then `close`, which killed it.
 *
 * Scope is deliberately tight so the table keeps its teeth: post_sale only, sold reasons only.
 */
const SOLD_CLOSE_REASONS = new Set(["sold", "sold_walkin_note"]);
function closeSparesPostSale(cad: Cad, reason: string): boolean {
  return cad?.kind === "post_sale" && SOLD_CLOSE_REASONS.has(reason);
}

const STATUSES = [undefined, "", "active", "stopped", "paused"] as const;
const KINDS = [undefined, "engaged", "long_term", "post_sale"] as const;
const REASONS = [
  "manual_handoff",
  "purchase_delivery",
  "closed",
  "sold",
  "sold_walkin_note",
  "not_interested",
  "opt_out",
  ""
] as const;

let tableRows = 0;
for (const verb of ALL_VERBS) {
  for (const hasRecord of [false, true]) {
    for (const status of STATUSES) {
      for (const kind of KINDS) {
        for (const reason of REASONS) {
          const cad: Cad = hasRecord ? { status, kind } : undefined;
          const expected =
            verb === "stop"
              ? originalStop(cad, reason)
              : verb === "pause"
                ? originalPause(cad)
                : verb === "resume"
                  ? originalResume(cad)
                  : // The one intended departure — see closeSparesPostSale above.
                    closeSparesPostSale(cad, reason)
                    ? null
                    : originalClose(cad);
          const actual = decideCadenceLifecycle({
            verb,
            hasRecord,
            status: status ?? null,
            kind: kind ?? null,
            reason
          });
          tableRows += 1;
          const label =
            `verb=${verb} hasRecord=${hasRecord} status=${String(status)} kind=${String(kind)} ` +
            `reason=${JSON.stringify(reason)}`;
          if (expected === null) {
            ok(!actual.apply, `${label}: the original wrote nothing, the referee applied`);
            continue;
          }
          ok(actual.apply, `${label}: the original wrote, the referee refused`);
          ok(
            actual.nextStatus === expected.status &&
              actual.clearNextDue === expected.clearNextDue &&
              actual.clearPause === expected.clearPause &&
              actual.clearStopReason === expected.clearStopReason,
            `${label}: field writes changed — original ${JSON.stringify(expected)} vs referee ` +
              JSON.stringify({
                status: actual.nextStatus,
                clearNextDue: actual.clearNextDue,
                clearPause: actual.clearPause,
                clearStopReason: actual.clearStopReason
              })
          );
        }
      }
    }
  }
}
ok(tableRows > 400, `the equivalence table must actually cover the space (covered ${tableRows} rows)`);

// ---------------------------------------------------------------------------------------------
// 2. FAIL DIRECTION — an unrecognized verb changes NOTHING.
// ---------------------------------------------------------------------------------------------
for (const verb of ["", "  ", "start", "restart", "cancel", "hold"]) {
  const d = decideCadenceLifecycle({ verb, hasRecord: true, status: "active", kind: "engaged" });
  ok(
    !d.apply && d.nextStatus === null,
    `an unrecognized cadence-lifecycle verb ("${verb}") must change nothing — got apply=${d.apply}`
  );
}

// ---------------------------------------------------------------------------------------------
// 3. DIVERGENCE 1 — only `stop` protects a post-sale / long-term chase.
// ---------------------------------------------------------------------------------------------
for (const kind of ["post_sale", "long_term"] as const) {
  for (const reason of ["manual_handoff", "purchase_delivery"] as const) {
    const stopped = decideCadenceLifecycle({ verb: "stop", hasRecord: true, status: "active", kind, reason });
    ok(
      !stopped.apply,
      `stop must SPARE a ${kind} chase on "${reason}" — that is expected post-sale traffic`
    );
    ok(
      stopped.divergence === "only_the_stop_verb_protects_a_post_sale_or_long_term_chase",
      `the spared stop must name its divergence — got ${String(stopped.divergence)}`
    );
    const closed = decideCadenceLifecycle({ verb: "close", hasRecord: true, status: "active", kind, reason });
    ok(closed.apply, `close must still stop a ${kind} chase — it has no such protection`);
    const paused = decideCadenceLifecycle({ verb: "pause", hasRecord: true, status: "active", kind, reason });
    ok(paused.apply, `pause must still hush a ${kind} chase — pausing is reversible and quieter`);
  }
  // An ORDINARY stop reason kills a protected chase exactly as before — the protection is on the
  // REASON, not on the kind.
  ok(
    decideCadenceLifecycle({ verb: "stop", hasRecord: true, status: "active", kind, reason: "opt_out" }).apply,
    `stop must still end a ${kind} chase for an ordinary reason like opt_out`
  );
}

// ---------------------------------------------------------------------------------------------
// 3b. A SOLD CLOSE SPARES THE POST-SALE CHASE (Charles Desalvo +17168614216, Joe 2026-08-03).
//
//     The customer bought a Street Glide and got NO owner follow-up at all. The walk-in sold
//     branch (sendgridInbound.ts) does two things twelve lines apart: `stop` with "manual_handoff",
//     which this referee correctly spares, and then `close` with "sold_walkin_note", which used to
//     kill the very chase the sale had just armed. Replayed here as a sequence, because neither
//     call is wrong on its own — only the pair is.
// ---------------------------------------------------------------------------------------------
for (const soldReason of ["sold", "sold_walkin_note"] as const) {
  const d = decideCadenceLifecycle({
    verb: "close",
    hasRecord: true,
    status: "active",
    kind: "post_sale",
    reason: soldReason
  });
  ok(!d.apply, `close("${soldReason}") must SPARE the post-sale chase — that is the owner sequence`);
  ok(
    d.divergence === "a_sold_close_spares_the_post_sale_chase_it_hands_off_to",
    `the spared sold close must name its divergence — got ${String(d.divergence)}`
  );

  // Narrow on purpose, both ways.
  ok(
    decideCadenceLifecycle({ verb: "close", hasRecord: true, status: "active", kind: "long_term", reason: soldReason })
      .apply,
    `close("${soldReason}") must still end a LONG_TERM chase — only the post-sale lane is spared`
  );
  ok(
    decideCadenceLifecycle({ verb: "close", hasRecord: true, status: "active", kind: "engaged", reason: soldReason })
      .apply,
    `close("${soldReason}") must still end an ordinary chase`
  );
}
for (const lostReason of ["opt_out", "not_interested", "wrong_number", "manual_archive"] as const) {
  ok(
    decideCadenceLifecycle({ verb: "close", hasRecord: true, status: "active", kind: "post_sale", reason: lostReason })
      .apply,
    `close("${lostReason}") must still end a post-sale chase — the lead did not close because it sold`
  );
}
{
  // The live sequence, end to end through the real store helpers, exactly as the walk-in branch
  // runs it. BEFORE the fix this ended "stopped"/"sold_walkin_note" — Charles's stored record.
  const walkInSold: any = {
    id: "c-walkin-sold",
    messages: [],
    followUpCadence: {
      status: "active",
      kind: "post_sale",
      anchorAt: "2026-08-03T11:21:47.479Z",
      nextDueAt: "2026-10-02T14:30:00.000Z",
      stepIndex: 0
    }
  };
  stopFollowUpCadence(walkInSold, "manual_handoff");
  closeConversation(walkInSold, "sold_walkin_note");
  ok(
    walkInSold.followUpCadence.status === "active" &&
      walkInSold.followUpCadence.nextDueAt === "2026-10-02T14:30:00.000Z" &&
      walkInSold.followUpCadence.stopReason === undefined,
    "a walk-in SOLD note must leave the owner sequence running — got " +
      JSON.stringify(walkInSold.followUpCadence)
  );
  ok(walkInSold.status === "closed", "the lead itself must still close");
}

// ---------------------------------------------------------------------------------------------
// 4. DIVERGENCE 2 — `close` leaves the pause fields standing where `stop` clears them.
// ---------------------------------------------------------------------------------------------
{
  const stopD = decideCadenceLifecycle({ verb: "stop", hasRecord: true, status: "active", kind: "engaged", reason: "opt_out" });
  const closeD = decideCadenceLifecycle({ verb: "close", hasRecord: true, status: "active", kind: "engaged", reason: "opt_out" });
  ok(stopD.clearPause, "stop must clear pausedUntil/pauseReason");
  ok(!closeD.clearPause, "close must NOT clear pausedUntil/pauseReason — preserved as it was");
  ok(stopD.nextStatus === "stopped" && closeD.nextStatus === "stopped", "both must stop the chase");
}

// ---------------------------------------------------------------------------------------------
// 5. THE VERBS WRITE WHAT THE REFEREE DECIDED — end to end through the real store helpers.
// ---------------------------------------------------------------------------------------------
{
  const spared: any = {
    id: "c1",
    followUpCadence: { status: "active", kind: "post_sale", nextDueAt: "2026-09-01T00:00:00.000Z" }
  };
  stopFollowUpCadence(spared, "manual_handoff");
  ok(
    spared.followUpCadence.status === "active" && spared.followUpCadence.nextDueAt,
    "a service handoff must not kill the post-sale chase the sale started"
  );

  const ended: any = {
    id: "c2",
    followUpCadence: {
      status: "active",
      kind: "engaged",
      nextDueAt: "2026-09-01T00:00:00.000Z",
      pausedUntil: "2026-08-20T00:00:00.000Z",
      pauseReason: "manual_outbound"
    }
  };
  stopFollowUpCadence(ended, "opt_out");
  ok(
    ended.followUpCadence.status === "stopped" &&
      ended.followUpCadence.stopReason === "opt_out" &&
      ended.followUpCadence.nextDueAt === undefined &&
      ended.followUpCadence.pausedUntil === undefined &&
      ended.followUpCadence.pauseReason === undefined,
    "stop must end the chase and clear the due date AND the pause stamps"
  );

  const notActive: any = { id: "c3", followUpCadence: { status: "stopped", kind: "engaged" } };
  pauseFollowUpCadence(notActive, "2026-09-01T00:00:00.000Z", "manual_outbound");
  ok(
    notActive.followUpCadence.pausedUntil === undefined,
    "pause must refuse a chase that is not active"
  );

  const noRecord: any = { id: "c4" };
  ok(
    !applyCadenceLifecycle(noRecord, { verb: "stop", reason: "opt_out" }).apply &&
      noRecord.followUpCadence === undefined,
    "a lead with no chase must be left alone"
  );

  const closedConv: any = {
    id: "c5",
    messages: [],
    followUpCadence: {
      status: "active",
      kind: "engaged",
      nextDueAt: "2026-09-01T00:00:00.000Z",
      pausedUntil: "2026-08-20T00:00:00.000Z"
    }
  };
  closeConversation(closedConv, "not_interested");
  ok(
    closedConv.followUpCadence.status === "stopped" &&
      closedConv.followUpCadence.stopReason === "not_interested" &&
      closedConv.followUpCadence.nextDueAt === undefined &&
      closedConv.followUpCadence.pausedUntil === "2026-08-20T00:00:00.000Z",
    "closing the lead must stop the chase but leave the pause stamp exactly as it did before"
  );

  const closedNoReason: any = { id: "c6", messages: [], followUpCadence: { status: "active", kind: "engaged" } };
  closeConversation(closedNoReason);
  ok(
    closedNoReason.followUpCadence.stopReason === "closed",
    'closing with no reason must stamp the chase "closed", as before'
  );
}

// ---------------------------------------------------------------------------------------------
// 6. THE DECISION REGISTRY SAMPLES EVERY VERB.
// ---------------------------------------------------------------------------------------------
{
  const registry = buildDecisionRegistry(reducer);
  const names = new Set(
    (Array.isArray(registry) ? registry : Object.values(registry ?? {})).map((entry: any) =>
      String(entry?.name ?? entry?.key ?? entry)
    )
  );
  for (const verb of ALL_VERBS) {
    ok(
      [...names].some(n => n.startsWith("cadenceLifecycle:") && n.includes(verb)),
      `the decision registry must sample cadenceLifecycle for ${verb} — otherwise a change to that ` +
        "verb is invisible to decision-equivalence"
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 7. NOBODY MOVES THE CHASE'S STATUS BEHIND THE REFEREE'S BACK.
//
// Asserted through the same analyzer the ratchet uses rather than by matching source text — a
// +1/-1 write-collapse can make `state_writer_contention:eval` report green on a genuine
// re-stacking (the trap #462 recorded). Minting a FRESH cadence is the sibling question and is
// deliberately still allowed to appear here; only moving an existing chase's STATUS is ours.
//
// Scoped to the status machine on purpose. A fifth writer stamps the pause fields inline without
// touching the status — the health-recovery pause extension at index.ts ~9347, which hushes a chase
// whatever its status, where `pause` requires "active". That is a real sibling question and is
// queued, not silently covered here. Unwiring `pauseFollowUpCadence` itself is still caught: it
// raises `state_writer_contention:eval` above its baseline (verified by sabotage).
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

  const entry: any = unstackingQueue(rankContention(files as any, { minWrites: 1 }), {
    minUnguarded: 1
  }).find((f: any) => f.field === "followUpCadence");
  const offenders = (entry?.unrefereedWriterSites ?? []).filter((site: any) =>
    // A status move on an EXISTING chase: `…status = "stopped"` / `= "active"`, or a stop stamp.
    /\.status\s*=\s*"(stopped|active)"|\.stopReason\s*=/.test(String(site.snippet ?? ""))
  );
  ok(
    offenders.length === 0,
    "a place outside applyCadenceLifecycle moves the chase's status without asking the referee — " +
      "route it through applyCadenceLifecycle instead. Offending site(s): " +
      offenders.map((s: any) => `${s.file}:${s.line} — ${s.snippet}`).join(" | ")
  );
}

console.log(
  `PASS cadence lifecycle — one referee for stop/pause/resume/close across 4 callers ` +
    `(${checks} checks, ${tableRows} equivalence-table rows; 3 divergences preserved and named)`
);
