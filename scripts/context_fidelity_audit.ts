/**
 * context-fidelity audit — the "answering out of context" detector (v1: offline; runtime
 * enforce is a separate approve-first cutover). See docs/context_fidelity_spec.md.
 *
 * Two modes:
 *   --self-test            run the scorer on golden fixtures and assert verdicts (this is
 *                          context_fidelity:eval, wired into ci:eval; LLM-backed).
 *   (default / batch)      score the freshest inbound->reply per conversation in a recent window,
 *                          bucket by `frame`, and write a report under REPORT_ROOT/context_fidelity
 *                          (or reports/context_fidelity) — an agent-watch DETECTION input. Each
 *                          out_of_context row is a ready replay fixture for a parser-first fix.
 *
 * Usage:
 *   npx tsx scripts/context_fidelity_audit.ts --self-test
 *   CONVERSATIONS_DB_PATH=... LLM_ENABLED=1 npx tsx scripts/context_fidelity_audit.ts [--since-hours=48] [--out-dir=DIR]
 */
import fs from "node:fs";
import path from "node:path";

import { scoreContextFidelityWithLLM } from "../services/api/src/domain/llmDraft.ts";

const SELF_TEST = process.argv.includes("--self-test");

// --- Golden fixtures (= context_fidelity:eval). DIFFERENT from the scorer's few-shots on purpose
//     (tests generalization, not memorization). Verdict is the robust signal we assert. ---
const FIXTURES: Array<{ name: string; expectVerdict: "faithful" | "out_of_context"; args: any }> = [
  {
    name: "sweepstakes_wrong_lead_type",
    expectVerdict: "out_of_context",
    args: {
      channel: "sms",
      anchor: { leadType: "event_promo/sweepstakes" },
      inbound: "(national sweepstakes entry — customer signed up for the sweeps)",
      draft: "Hey David, thanks for your interest in the 2026 Street Glide. Want to come take a look this week?"
    }
  },
  {
    name: "over_attached_model",
    expectVerdict: "out_of_context",
    args: {
      channel: "sms",
      anchor: { modelOfRecord: "Fat Boy" },
      inbound: "still leaning toward the fat boy",
      draft: "We've got a great deal on a Road King right now — want the details?"
    }
  },
  {
    name: "day_reask_stale_intent",
    expectVerdict: "out_of_context",
    args: {
      channel: "sms",
      inbound: "see you tomorrow then!",
      draft: "Sounds good — what day works for you to come by?"
    }
  },
  {
    name: "faithful_price_on_referenced_model",
    expectVerdict: "faithful",
    args: {
      channel: "sms",
      anchor: { modelOfRecord: "Sportster" },
      inbound: "is the sportster still available?",
      draft: "Yes, the Sportster is still here. Want to come take it for a ride?"
    }
  }
];

async function selfTest(): Promise<void> {
  let fail = 0;
  for (const f of FIXTURES) {
    const r = await scoreContextFidelityWithLLM(f.args);
    if (!r) {
      console.error(`FAIL ${f.name}: scorer returned null (needs LLM_ENABLED=1 + OPENAI_API_KEY)`);
      fail++;
      continue;
    }
    const ok = r.verdict === f.expectVerdict;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${f.name} verdict=${r.verdict} frame=${r.frame} sev=${r.severity} conf=${r.confidence ?? "-"}`
    );
    if (!ok) {
      console.error(`   expected verdict=${f.expectVerdict}; reason="${r.reason ?? ""}"`);
      fail++;
    }
  }
  if (fail) {
    console.error(`context_fidelity self-test: ${fail} failure(s)`);
    process.exit(1);
  }
  console.log(`context_fidelity self-test passed (${FIXTURES.length} fixtures)`);
}

type Msg = { direction?: string | null; body?: string | null; at?: string | null; createdAt?: string | null };

function lastInboundReplyPair(messages: Msg[]): { inbound: string; draft: string; history: Array<{ direction: "in" | "out"; body: string }>; at: string | null } | null {
  // freshest agent reply ("out") and the customer turn ("in") immediately before it
  for (let i = messages.length - 1; i >= 1; i--) {
    const out = messages[i];
    if (String(out?.direction ?? "").toLowerCase() !== "out" || !out?.body) continue;
    for (let j = i - 1; j >= 0; j--) {
      const inb = messages[j];
      if (String(inb?.direction ?? "").toLowerCase() !== "in" || !inb?.body) continue;
      const history = messages
        .slice(0, j)
        .filter(m => (m?.direction === "in" || m?.direction === "out") && m?.body)
        .map(m => ({ direction: m.direction as "in" | "out", body: String(m.body) }));
      return { inbound: String(inb.body), draft: String(out.body), history, at: String(out.at ?? out.createdAt ?? "") || null };
    }
    return null;
  }
  return null;
}

async function batch(): Promise<void> {
  const sinceHoursArg = process.argv.find(a => a.startsWith("--since-hours="));
  const sinceHours = sinceHoursArg ? Number(sinceHoursArg.split("=")[1]) : 48;
  const storePath = process.env.CONVERSATIONS_DB_PATH || "services/api/data/conversations.json";
  const outDirArg = process.argv.find(a => a.startsWith("--out-dir="));
  const outDir =
    (outDirArg && outDirArg.split("=")[1]) ||
    (process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "context_fidelity") : "reports/context_fidelity");

  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const cutoffMs = Date.now() - sinceHours * 3600 * 1000;

  const findings: any[] = [];
  const byFrame: Record<string, number> = {};
  let scored = 0;

  for (const conv of conversations) {
    const messages: Msg[] = Array.isArray(conv?.messages) ? conv.messages : [];
    const pair = lastInboundReplyPair(messages);
    if (!pair) continue;
    const atMs = pair.at ? Date.parse(pair.at) : NaN;
    if (Number.isFinite(atMs) && atMs < cutoffMs) continue;

    const anchor = {
      modelOfRecord: conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null,
      leadType: [conv?.classification?.bucket, conv?.classification?.cta].filter(Boolean).join("/") || null,
      appointmentBooked: !!conv?.appointment?.bookedEventId,
      dialogState: conv?.dialogState?.name ?? null
    };
    const r = await scoreContextFidelityWithLLM({
      draft: pair.draft,
      inbound: pair.inbound,
      history: pair.history,
      anchor,
      channel: conv?.channel === "email" ? "email" : "sms"
    });
    if (!r) continue;
    scored++;
    byFrame[r.frame] = (byFrame[r.frame] ?? 0) + 1;
    if (r.verdict === "out_of_context") {
      findings.push({
        convId: conv?.id ?? conv?.leadKey ?? null,
        frame: r.frame,
        severity: r.severity,
        confidence: r.confidence ?? null,
        inbound: pair.inbound.slice(0, 200),
        draft: pair.draft.slice(0, 240),
        unsupportedAssertion: r.unsupportedAssertion ?? null,
        steering: r.steering ?? null,
        anchor
      });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const major = findings.filter(f => f.severity === "major");
  const summary = { generatedAt: new Date().toISOString(), sinceHours, scored, outOfContext: findings.length, major: major.length, byFrame };
  fs.writeFileSync(path.join(outDir, "context_fidelity_summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "context_fidelity_findings.json"), JSON.stringify(findings, null, 2));
  const md = [
    `# Context Fidelity — out-of-context replies`,
    ``,
    `Generated ${summary.generatedAt} — scored ${scored}, out_of_context ${findings.length} (major ${major.length}). Window ${sinceHours}h.`,
    ``,
    `By frame: ${JSON.stringify(byFrame)}`,
    ``,
    ...major.slice(0, 40).map(f =>
      `- [${f.frame}] ${f.convId}\n  IN:  ${f.inbound}\n  OUT: ${f.draft}\n  why: ${f.unsupportedAssertion ?? ""}`
    )
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "context_fidelity_report.md"), md);
  console.log(`context_fidelity audit: scored ${scored}, out_of_context ${findings.length} (major ${major.length}) -> ${outDir}`);
}

if (SELF_TEST) {
  await selfTest();
} else {
  await batch();
}
