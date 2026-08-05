/**
 * Voice CONDITIONAL-PROMISE fixture eval (LLM-backed).
 *
 * The miss it pins (James Bernsdorf +17167964264, live call 2026-07-25). The rep ended the call
 * with "So you got a 2017 Ultra Limited. If we're interested in buying it, I will call you." The
 * summarizer narrated that in reported speech — "Dealer MAY contact him if interested in
 * purchasing" — and the voice durable-facts parser read the hedge as uncertainty: it returned the
 * right owner ("staff") with next_step_confidence 0.60-0.75, straddling
 * VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT (0.7). Below the gate the plan collapses to
 * `breather_only`, so NO staff task was minted. Nobody ever decided on the bike, the generic
 * cadence kept running, and on 2026-08-04 the lead was taper-retired ("I'll pause my check-ins")
 * with the promise unkept. Detected by open-critic as `no_task_for_promised_buy_offer_followup`.
 *
 * Why the fixture goes end-to-end rather than asserting a confidence number: the defect only
 * exists at the seam between the parser and the gate. A confidence assertion would pass at 0.71
 * and tell us nothing about whether the store gets a task, which is the whole point.
 *
 * Both directions are pinned on purpose. Teaching the parser that a conditional dealership promise
 * is real is exactly the change that could start minting tasks off sign-off pleasantries, so the
 * over-trigger rows ("we'll be in touch"; a condition that is the CUSTOMER's to resolve) and the
 * untouched customer-visit arm are load-bearing, not padding.
 *
 * Nondeterminism: sampled 3x per row, majority rules (see the judge-reproducibility rule — vote
 * before you enforce). A single sample would make this eval flaky for every routine's gate.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}
if (process.env.LLM_ENABLED !== "1" || process.env.LLM_VOICE_DURABLE_FACTS_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_VOICE_DURABLE_FACTS_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

// Isolate the store import from any real conversations file.
const tmpDir = await mkdtemp(path.join(tmpdir(), "voice-next-step-promise-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tmpDir, "conversations.json");
await writeFile(
  process.env.CONVERSATIONS_DB_PATH,
  JSON.stringify({ version: 1, conversations: [], todos: [], questions: [] }),
  "utf8"
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "voice_next_step_promise_examples.json");

type Example = {
  id: string;
  note?: string;
  summary: string;
  expectOwner: "customer" | "staff" | "none";
  expectDecisionKind: "staff_task" | "customer_visit_task" | "hold_for_customer" | "breather_only";
};

const examples = JSON.parse(await fs.readFile(dataPath, "utf8")) as Example[];
assert.ok(examples.length > 0, "fixture file must carry at least one example");

const { parseVoiceDurableFactsWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
const { parseRequestedDateOnly } = await import("../services/api/src/domain/conversationStore.ts");
const { decideVoiceNextStep, VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT } = await import(
  "../services/api/src/domain/voiceNextStep.ts"
);

const TZ = "America/New_York";
const SAMPLES = 3;

type Sample = { owner: string; confidence: number; kind: string };

async function sampleOnce(summary: string): Promise<Sample> {
  const parsed = await parseVoiceDurableFactsWithLLM({ summary });
  const dueText = String(parsed?.nextStepDueText ?? "").trim();
  // Mirrors the live call site in index.ts (voice summary ingestion) exactly: same parser output,
  // same date resolution, same pure decision. If that wiring drifts, this eval stops proving the
  // production path — voice_cadence_facts:eval source-pins the call site itself.
  const decision = decideVoiceNextStep({
    isVoicemail: false,
    nowMs: Date.now(),
    timeZone: TZ,
    cadenceKind: "standard",
    followUpMode: "active",
    conversationStatus: "open",
    nextStepOwner: parsed?.nextStepOwner ?? "none",
    nextStepAction: parsed?.nextStepAction ?? "",
    nextStepConfidence: parsed?.nextStepConfidence ?? 0,
    customerVisitPlanned: parsed?.nextStepIsVisit === true,
    dueDate: dueText ? parseRequestedDateOnly(dueText, TZ) : null
  });
  return {
    owner: String(parsed?.nextStepOwner ?? "none"),
    confidence: Number(parsed?.nextStepConfidence ?? 0),
    kind: decision.kind
  };
}

const failures: string[] = [];

for (const ex of examples) {
  const samples: Sample[] = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await sampleOnce(ex.summary));

  const ownerHits = samples.filter(s => s.owner === ex.expectOwner).length;
  const kindHits = samples.filter(s => s.kind === ex.expectDecisionKind).length;
  const majority = Math.floor(SAMPLES / 2) + 1;
  const shown = samples.map(s => `${s.owner}@${s.confidence}->${s.kind}`).join(", ");

  if (ownerHits < majority) {
    failures.push(`${ex.id}: expected owner "${ex.expectOwner}" in a majority of ${SAMPLES} samples, got [${shown}]`);
  }
  if (kindHits < majority) {
    failures.push(
      `${ex.id}: expected decision "${ex.expectDecisionKind}" in a majority of ${SAMPLES} samples, got [${shown}]` +
        (ex.expectDecisionKind === "staff_task"
          ? ` (a staff-owed promise below the ${VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT} confidence gate collapses to breather_only and mints NO task — that is the James Bernsdorf defect)`
          : "")
    );
  }
  console.log(`${kindHits >= majority && ownerHits >= majority ? "PASS" : "FAIL"} ${ex.id}: [${shown}]`);
}

if (failures.length) {
  console.error("\nvoice_next_step_promise:eval failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\nvoice_next_step_promise:eval OK — ${examples.length} fixture(s), ${SAMPLES} samples each.`);
