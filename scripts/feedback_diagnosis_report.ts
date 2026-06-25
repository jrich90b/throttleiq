/**
 * Feedback diagnosis report — closed-loop Phase 2 (2026-06-24). REPORT-ONLY (shadow).
 *
 * Scans the store for staff thumbs-DOWN on AI replies, classifies each failure mode with a typed
 * LLM parser (parseFeedbackFailureModeWithLLM), maps it to an action via the pure policy
 * (decideFeedbackDiagnosisAction), and aggregates by failure mode + fix LAYER. Surfaces the
 * recurring COMPREHENSION classes that WOULD become parser-first fix candidates (Phase 3) — but this
 * script NEVER opens a PR, edits code, or writes the store. It only prints what it sees, so we can
 * calibrate the classifier's precision before wiring any auto-PRs.
 *
 * A thumbs-down is a WEAK signal (~43% of human takeovers were real errors), so a class is only a
 * fix candidate when it is SYSTEMIC, confident, AND recurs at/above the cluster threshold — n=1 never
 * proposes code (the de-tangle program: comprehension cutovers are approve-first).
 *
 * Usage: [LLM_ENABLED=1] npx tsx scripts/feedback_diagnosis_report.ts [path/to/conversations.json]
 *        (defaults to ./data/conversations.json; point it at a pulled box store to see prod 👎)
 */
import fs from "node:fs";
// Type-only import (erased) so the deterministic SILENCE section runs without OPENAI_API_KEY — the
// parser (which builds an OpenAI client at module load) is dynamically imported only when LLM is on.
import type { FeedbackFailureModeParse } from "../services/api/src/domain/llmDraft.ts";
import { decideFeedbackDiagnosisAction } from "../services/api/src/domain/routeStateReducer.ts";
import { isUnansweredInboundConversation } from "../services/api/src/domain/conversationStore.ts";

const CLUSTER_THRESHOLD = Number(process.env.FEEDBACK_DIAGNOSIS_CLUSTER_MIN ?? 3);
const CONFIDENCE_MIN = Number(process.env.FEEDBACK_DIAGNOSIS_CONFIDENCE_MIN ?? 0.7);

const storePath = process.argv[2] || "data/conversations.json";
const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
const convs: any[] = Array.isArray(raw) ? raw : raw.conversations ?? [];

type Down = { convId: string; bucket: string; cta: string; inbound: string; draft: string; reason: string };
const downs: Down[] = [];
for (const c of convs) {
  const msgs: any[] = Array.isArray(c?.messages) ? c.messages : [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.direction !== "out" || m?.feedback?.rating !== "down") continue;
    let inbound = "";
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j]?.direction === "in" && String(msgs[j]?.body ?? "").trim()) {
        inbound = String(msgs[j].body).trim();
        break;
      }
    }
    downs.push({
      convId: c.id,
      bucket: String(c?.classification?.bucket ?? "unknown"),
      cta: String(c?.classification?.cta ?? "unknown"),
      inbound,
      draft: String(m?.body ?? "").trim(),
      reason: [m.feedback.reason, m.feedback.note].map((s: any) => String(s ?? "").trim()).filter(Boolean).join(" — ")
    });
  }
}

// Silence / no-reply: the failure mode the thumbs-down loop is blind to (no draft to rate).
// Deterministic — runs even when the LLM is off. Two buckets: HELD (agent drafted, a gate blocked it
// → conv.draftHeld) and UNANSWERED (customer spoke last, nothing waiting for the rep).
const held: { convId: string; reason: string }[] = [];
const unanswered: string[] = [];
for (const c of convs) {
  if (c?.draftHeld) {
    held.push({ convId: c.id, reason: String(c.draftHeld?.reason ?? c.draftHeld?.heldKind ?? "held") });
  } else if (isUnansweredInboundConversation(c)) {
    unanswered.push(c.id);
  }
}

console.log(`store: ${storePath}`);
console.log("=== SILENCE / NO-REPLY (no draft to thumbs-down — the loop's blind spot) ===");
console.log(`  held drafts (agent drafted, a gate blocked it): ${held.length}`);
const heldByReason = new Map<string, number>();
for (const h of held) heldByReason.set(h.reason, (heldByReason.get(h.reason) ?? 0) + 1);
for (const [r, n] of [...heldByReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`    - ${r}: ${n}`);
console.log(`  unanswered inbound (customer spoke last, nothing waiting): ${unanswered.length}`);
for (const id of unanswered.slice(0, 10)) console.log(`    - ${id}`);
if (unanswered.length > 10) console.log(`    … and ${unanswered.length - 10} more`);
console.log("");
console.log(`thumbs-down found: ${downs.length}`);
if (!downs.length) {
  console.log("Nothing to classify.");
  process.exit(0);
}
if (process.env.LLM_ENABLED !== "1") {
  console.log("LLM_ENABLED != 1 — thumbs-down classification skipped (the silence section above still ran). Re-run with LLM_ENABLED=1.");
  process.exit(0);
}

// Lazy-load the parser only now (its module builds an OpenAI client) so the silence section above
// never needs the key.
const { parseFeedbackFailureModeWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

const byMode = new Map<string, number>();
const byLayer = new Map<string, number>();
const byAction = new Map<string, number>();
const fixClusters = new Map<string, { count: number; samples: string[] }>(); // parser_fix_candidate by mode|bucket
let classified = 0;

for (const d of downs) {
  const parse: FeedbackFailureModeParse | null = await parseFeedbackFailureModeWithLLM({
    reason: d.reason,
    inbound: d.inbound,
    draft: d.draft,
    bucket: d.bucket,
    cta: d.cta
  });
  if (!parse) continue;
  classified += 1;
  const action = decideFeedbackDiagnosisAction({
    parserAccepted: true,
    layer: parse.layer,
    systemic: parse.systemic,
    confidence: parse.confidence,
    confidenceMin: CONFIDENCE_MIN
  });
  byMode.set(parse.failureMode, (byMode.get(parse.failureMode) ?? 0) + 1);
  byLayer.set(parse.layer, (byLayer.get(parse.layer) ?? 0) + 1);
  byAction.set(action, (byAction.get(action) ?? 0) + 1);
  if (action === "parser_fix_candidate") {
    const key = `${parse.failureMode} | ${d.bucket}`;
    const entry = fixClusters.get(key) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 3 && d.reason) entry.samples.push(d.reason.slice(0, 70));
    fixClusters.set(key, entry);
  }
}

const fmt = (m: Map<string, number>) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k}: ${v}`).join("\n") || "    (none)";

console.log(`classified: ${classified}/${downs.length}\n`);
console.log("by failure mode:\n" + fmt(byMode));
console.log("by fix layer:\n" + fmt(byLayer));
console.log("by proposed action:\n" + fmt(byAction));
console.log(`\nparser-fix CANDIDATE clusters (>= ${CLUSTER_THRESHOLD} → Phase-3 PR candidates; report-only, no PRs opened):`);
const candidates = [...fixClusters.entries()].filter(([, v]) => v.count >= CLUSTER_THRESHOLD).sort((a, b) => b[1].count - a[1].count);
if (!candidates.length) {
  console.log(`  (none reach the threshold yet — below-threshold comprehension misses are tracked, not proposed)`);
} else {
  for (const [key, v] of candidates) {
    console.log(`  - ${key}  (${v.count})  e.g. ${v.samples.join(" / ")}`);
  }
}
console.log("\nNOTE: shadow report only. Phase 3 (auto-authored parser-first fix PRs via agent-watch, human-merged) is not wired.");
