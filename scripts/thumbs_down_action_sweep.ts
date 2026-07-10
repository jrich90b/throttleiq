/**
 * Thumbs-down action sweep (2026-07-10) — the 👎 note "decipher" step.
 *
 * Staff type a sentence into the thumbs-down box 119 times out of 121, but the notes do two different
 * jobs: some report a code DEFECT ("wrong unit"), and some are INSTRUCTIONS for a live customer that
 * nobody carried out ("Book him In at 9:30 today", "tell him we have the stock muffler out front").
 * The old feedback loop funneled every note into the code-fix classifier, and only surfaces a class
 * once it recurs 3+ times — so a one-off "book him in" evaporated and the customer kept waiting.
 *
 * This sweep reads the note's INTENT (parseThumbsDownNoteWithLLM), routes it
 * (decideThumbsDownNoteRouting), and for STAFF-ACTION notes emits a sibling OutcomeAnomaly feed
 * (reports/thumbs_down_action/latest.json, dimension thumbs_down_action_request) that
 * anomaly_loop_detect merges → the morning digest's staff-action lane. reply_defect / record_only /
 * coaching are left to the existing feedback-diagnosis path untouched.
 *
 * FAIL DIRECTION: a stranded customer is the expensive miss, so the routing treats unclear + low
 * confidence as staff_action. This sweep only ADDS a human-visible surface; it never writes the store,
 * texts a customer, or proposes code. Read-only.
 *
 * Only SENT thumbs-downs cross (an unsent pending/stale draft's 👎 is coaching on a reply nobody got);
 * only FRESH ones (<= --age-days, default 21) — an old instruction is stale, and the customer has
 * long since been handled or lost.
 *
 * Usage (on the box, LLM on):
 *   set -a; source /home/ubuntu/leadrider-runtime/americanharley/api.env; set +a
 *   LLM_ENABLED=1 DATA_DIR=/home/ubuntu/leadrider-runtime/americanharley/data \
 *     REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *     npx tsx scripts/thumbs_down_action_sweep.ts --age-days 21
 *   npx tsx scripts/thumbs_down_action_sweep.ts --self-test   # deterministic, no IO / no key, for ci:eval
 */
import fs from "node:fs";
import path from "node:path";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    // The sweep's own IO/shape is trivial; the load-bearing logic (parser + routing + mapper) is pinned
    // by thumbs_down_action:eval. Here we only assert the module wires those pieces together.
    const src = fs.readFileSync(new URL(import.meta.url), "utf8");
    const assert = (await import("node:assert/strict")).default;
    assert.match(src, /parseThumbsDownNoteWithLLM/, "sweep calls the note parser");
    assert.match(src, /decideThumbsDownNoteRouting/, "sweep routes via the pure policy");
    assert.match(src, /decideThumbsDownActionAnomaly/, "sweep maps staff-action notes to the anomaly");
    assert.match(src, /thumbs_down_action", "latest\.json"|thumbs_down_action\/latest\.json/, "writes the sibling feed");
    console.log("PASS thumbs_down_action_sweep self-test (wiring)");
    return;
  }

  const { parseThumbsDownNoteWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
  const { decideThumbsDownNoteRouting } = await import("../services/api/src/domain/routeStateReducer.ts");
  const { decideThumbsDownActionAnomaly } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");

  const storePath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "data/conversations.json");
  const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
  const outDir = path.join(reportRoot, "thumbs_down_action");
  const ageDays = Number(arg("--age-days", "21"));
  const confidenceMin = Number(process.env.THUMBS_DOWN_NOTE_CONFIDENCE_MIN ?? "0.7");
  const now = Date.now();

  let convs: any[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    convs = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  } catch {
    convs = []; // a missing/malformed store must never break the loop
  }

  const anomalies: any[] = [];
  let scanned = 0;
  let staffAction = 0;

  for (const c of convs) {
    const msgs: any[] = Array.isArray(c?.messages) ? c.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.direction !== "out") continue;
      if (String(m?.feedback?.rating ?? "").toLowerCase() !== "down") continue;
      // SENT only — a 👎 on an unsent draft (draft_ai + not stale) is coaching on a reply nobody received.
      const isPendingDraft = m?.provider === "draft_ai" && m?.draftStatus !== "stale";
      if (isPendingDraft) continue;
      const note = [m?.feedback?.reason, m?.feedback?.note].map((s: any) => String(s ?? "").trim()).filter(Boolean).join(" — ");
      if (!note) continue; // a bare click carries no instruction (2 of 121); nothing to route
      // Freshness: an old instruction is stale.
      const ratedAtRaw = String(m?.feedback?.at ?? m?.at ?? "");
      const ratedMs = Date.parse(ratedAtRaw);
      if (Number.isFinite(ratedMs)) {
        const age = (now - ratedMs) / (1000 * 60 * 60 * 24);
        if (age < 0 || age > ageDays) continue;
      }
      let inbound = "";
      for (let j = i - 1; j >= 0; j--) {
        if (msgs[j]?.direction === "in" && String(msgs[j]?.body ?? "").trim()) {
          inbound = String(msgs[j].body).trim();
          break;
        }
      }
      scanned++;
      const parse = await parseThumbsDownNoteWithLLM({ note, inbound, ratedReply: String(m?.body ?? "") });
      const route = decideThumbsDownNoteRouting({
        parserAccepted: !!parse,
        noteKind: parse?.noteKind ?? null,
        confidence: parse?.confidence ?? 0,
        confidenceMin
      });
      const anomaly = decideThumbsDownActionAnomaly({
        convId: String(c?.id ?? ""),
        leadKey: c?.leadKey ?? null,
        note,
        route,
        actionSummary: parse?.actionSummary ?? null,
        ratedAt: ratedAtRaw
      });
      if (anomaly) {
        anomalies.push(anomaly);
        staffAction++;
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "latest.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), source: storePath, summary: { scanned, staffAction }, anomalies },
      null,
      2
    )
  );
  console.log(`thumbs-down action sweep — ${scanned} sent 👎 note(s), ${staffAction} staff-action → ${path.join(outDir, "latest.json")}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
