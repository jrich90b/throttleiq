/**
 * Route-parity drift guard (2026-07-13).
 *
 * THE LAW (CLAUDE.md/AGENTS.md): live (/webhooks/twilio) and regenerate
 * (/conversations/:id/regenerate) must run identical decision logic. Drift between the two
 * copies is the Kody bug class (#197: the live compliment gate missing the finance signal the
 * regen gate already had — a compliment+question collapsed to a pleasantry echo on live only).
 *
 * This guard makes that drift a BUILD FAILURE instead of a production incident:
 *
 *   1. DECISION PARITY — every `decide*` / `parse*WithLLM` symbol used inside one handler
 *      region must also be used in the other, unless it is in SINGLE_PATH_BASELINE with a
 *      reason. A NEW single-path decision fails the gate (wire it into both paths, or baseline
 *      it with a reason if it is single-path by design). A STALE baseline entry (now both-path
 *      or gone) also fails, so the baseline stays honest.
 *
 *   2. MIRRORED-LOCALS RATCHET — the regen handler still re-derives many signals by hand as
 *      `const regenFoo = ...` twins of live-path locals. Each is a drift point. The count can
 *      only go DOWN (migrate the pair into a shared reducer/helper, then LOWER the baseline).
 *      Never raise the baseline to land new mirrored logic — that's the whole point.
 *
 *   3. PUNCH-LIST — prints the mirrored locals that have a live twin (the true duplicates,
 *      ranked migration queue). Full list: ROUTE_PARITY_REPORT=1.
 *
 * Scope note: this pins the twilio↔regenerate parity law only. ADF/email intake
 * (routes/sendgridInbound.ts) is a different lane with its own decisions; symbols that live
 * there (e.g. survey/event-promo intake) legitimately appear single-path here and are
 * baselined below with that reason.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ── Ratchet: total `const regen*` mirrored locals in the regen handler. DOWN ONLY. ──
// 251 (2026-07-13): initial snapshot at guard introduction — 245 distinct, 151 with a
// live-path twin. Migrating a mirrored pair into a shared decide*/resolve* helper is the
// de-tangle program's unit of progress; lower this number with every such PR.
// 252 (2026-07-15): +1 for a NEW both-path customer route — the finance-hardship staff handoff
// (Joe ruling 2026-07-15). The DECISION is centralized (decideFinanceHardshipTurn) and the
// reply is a single shared resolver (resolveFinanceHardshipHandoffReply) both paths call, so
// this is the sanctioned shared-resolver pattern, NOT new hand-mirrored decision logic — but
// CLAUDE.md's both-paths parity law still requires one regen call-site local (regenFinanceHardshipReply)
// to branch on email/sms. A brand-new shared handoff is the ONLY sanctioned reason to raise this;
// it does NOT license hand-mirroring inline decision logic. Resume ratcheting DOWN from 252.
const MIRRORED_LOCALS_BASELINE = 252;

// ── Single-path decisions, each with a reason. New single-path symbols FAIL. ──
// Entries baselined 2026-07-13 at guard introduction. "verify on touch": the reason is a
// best-effort classification — re-verify (and either wire into both paths or re-justify)
// whenever the symbol's call site changes.
const SINGLE_PATH_BASELINE: Record<string, { path: "live" | "regen"; reason: string }> = {
  decideInProcessDealTurn: {
    path: "live",
    reason:
      "in-process-deal canary suppresses live auto-drafting; regen is a human-initiated draft action (verify on touch)"
  },
  decideOwnerThreadStepBack: {
    path: "live",
    reason:
      "step-back suppresses the live auto-draft when the customer greets their human owner; regen is staff-initiated so the step-back premise doesn't apply (verify on touch)"
  },
  parseDealProgressSignalWithLLM: {
    path: "live",
    reason: "feeds decideInProcessDealTurn (live canary pair) (verify on touch)"
  },
  parseDialogActWithLLM: {
    path: "live",
    reason: "legacy live-path dialog-act signal; not part of the regen flow (verify on touch)"
  },
  parseIntentWithLLM: {
    path: "live",
    reason: "legacy live-path intent signal; not part of the regen flow (verify on touch)"
  },
  decideDealerLeadSurveyTurn: {
    path: "regen",
    reason:
      "survey ADFs enter via ADF/sendgrid intake (separate lane), so the live twin lives outside the twilio handler; regen re-derives it for redraws (verify on touch)"
  },
  parseDealerLeadSurveyWithLLM: {
    path: "regen",
    reason: "pairs with decideDealerLeadSurveyTurn (ADF intake lane) (verify on touch)"
  },
  decideEventPromoTurn: {
    path: "regen",
    reason:
      "event-promo ADFs are handled at ADF intake (live lane outside the twilio handler); regen re-derives for redraws (verify on touch)"
  },
  decideNonBuyerSurveyTurn: {
    path: "regen",
    reason:
      "non-buyer survey acks are ADF-intake behavior (live lane outside the twilio handler) (verify on touch)"
  },
  parseCadenceRegenerateContextWithLLM: {
    path: "regen",
    reason: "regenerate-only by definition: rebuilds context for a cadence redraft (by design)"
  }
};

const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8").split(/\r?\n/);

function region(marker: string): [number, number] {
  const start = src.findIndex(l => l.includes(marker));
  assert.ok(start >= 0, `handler must exist: ${marker}`);
  let end = src.length;
  for (let i = start + 1; i < src.length; i += 1) {
    if (/^app\.(post|get|put|delete)\(/.test(src[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}

// Count only ACTIVE code references (comments stripped) — same convention as the
// comprehension-debt ratchet: a symbol surviving only in a comment is a ghost, not drift.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const [liveStart, liveEnd] = region('app.post("/webhooks/twilio"');
const [regenStart, regenEnd] = region('app.post("/conversations/:id/regenerate"');
const live = stripComments(src.slice(liveStart, liveEnd).join("\n"));
const regen = stripComments(src.slice(regenStart, regenEnd).join("\n"));

// ── 1) Decision parity ──
const SYMBOL_RE = /\b(decide[A-Z]\w+|parse[A-Z]\w+WithLLM)\s*\(/g;
const countSymbols = (s: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of s.matchAll(SYMBOL_RE)) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
  return m;
};
const liveSyms = countSymbols(live);
const regenSyms = countSymbols(regen);
const allSyms = [...new Set([...liveSyms.keys(), ...regenSyms.keys()])].sort();

const failures: string[] = [];
let bothCount = 0;
for (const sym of allSyms) {
  const l = liveSyms.get(sym) ?? 0;
  const r = regenSyms.get(sym) ?? 0;
  const baselined = SINGLE_PATH_BASELINE[sym];
  if (l > 0 && r > 0) {
    bothCount += 1;
    if (baselined) {
      failures.push(
        `STALE BASELINE: ${sym} now runs in BOTH paths — remove it from SINGLE_PATH_BASELINE (progress!)`
      );
    }
    continue;
  }
  const where = l > 0 ? "live" : "regen";
  if (!baselined) {
    failures.push(
      `NEW SINGLE-PATH DECISION: ${sym} runs only in the ${where.toUpperCase()} path. ` +
        `Wire it into BOTH /webhooks/twilio and /conversations/:id/regenerate (route-parity law), ` +
        `or add it to SINGLE_PATH_BASELINE with a reason if single-path is by design.`
    );
  } else if (baselined.path !== where) {
    failures.push(
      `BASELINE MISMATCH: ${sym} is baselined as ${baselined.path}-only but now runs only in ${where} — re-verify and fix the entry.`
    );
  }
}
for (const sym of Object.keys(SINGLE_PATH_BASELINE)) {
  if (!liveSyms.has(sym) && !regenSyms.has(sym)) {
    failures.push(
      `STALE BASELINE: ${sym} no longer appears in either handler — remove it from SINGLE_PATH_BASELINE.`
    );
  }
}

// ── 2) Mirrored-locals ratchet ──
const mirrored = [...regen.matchAll(/\bconst (regen[A-Z]\w+)\b/g)].map(m => m[1]);
const distinct = [...new Set(mirrored)];
if (mirrored.length > MIRRORED_LOCALS_BASELINE) {
  failures.push(
    `MIRRORED-LOCALS RATCHET: ${mirrored.length} \`const regen*\` locals in the regen handler ` +
      `(baseline ${MIRRORED_LOCALS_BASELINE}). New hand-mirrored logic is new drift surface — ` +
      `move the decision into a shared reducer/helper both paths call instead. NEVER raise the baseline.`
  );
}

// ── 3) Punch-list: mirrored locals with a live twin (the true duplicates) ──
const twins: string[] = [];
for (const m of distinct) {
  const base = m.slice("regen".length);
  const liveName = base[0].toLowerCase() + base.slice(1);
  if (new RegExp(`\\b(?:const|let)\\s+${liveName}\\b`).test(live)) twins.push(`${m} <-> ${liveName}`);
}

console.log(
  `route-parity: ${bothCount} decisions verified in BOTH paths; ` +
    `${Object.keys(SINGLE_PATH_BASELINE).length} baselined single-path; ` +
    `${mirrored.length}/${MIRRORED_LOCALS_BASELINE} mirrored locals (${distinct.length} distinct, ${twins.length} with live twins)`
);
if (mirrored.length < MIRRORED_LOCALS_BASELINE) {
  console.log(
    `NOTE: mirrored locals dropped below baseline (${mirrored.length} < ${MIRRORED_LOCALS_BASELINE}) — lower MIRRORED_LOCALS_BASELINE to lock in the progress.`
  );
}
if (process.env.ROUTE_PARITY_REPORT === "1") {
  console.log(`\nPUNCH-LIST — mirrored locals with a live twin (migrate these into shared code first):`);
  for (const t of twins.sort()) console.log(`  ${t}`);
} else {
  console.log(`(full migration punch-list: ROUTE_PARITY_REPORT=1 npm run route_parity_guard:eval)`);
}

assert.deepEqual(failures, [], `route-parity drift:\n${failures.join("\n")}`);
console.log("PASS route parity guard");
