/**
 * ACT runner (PR-only) — the last step of the self-healing loop (docs/autonomous_coding_loop.md).
 *
 * DETECT writes reports/anomaly_loop/next.json and the digest surfaces it; this turns a chosen finding into
 * an approvable GitHub PR. It handles the DETERMINISTIC scaffolding — select the work order, assemble a
 * self-contained fix brief, enforce the gates, open a PR (NEVER merge). The PATCH itself is written by the
 * coding agent (Claude) between `prep` and `open-pr`, because a correct parser-first fix needs judgment a
 * script can't supply. Nothing auto-merges: you approve by reviewing + merging the PR; reject = close it.
 *
 * Subcommands:
 *   list                         — print the current work orders (id = convId::dimension)
 *   prep --id <key> | --top      — write reports/act/brief-<key>.md (finding + conv + actions + the
 *                                  parser-first contract + suggested branch/PR), for the coding agent to implement
 *   open-pr --title <t> [--eval-verified]
 *                                — on a feature branch with commits ahead of main, run the gates
 *                                  (tsc always; ci:eval unless --eval-verified) then `gh pr create` (no merge)
 *
 * Run: npx tsx scripts/act_runner.ts <subcommand> [flags]
 *   (prep can load the conversation for context via CONVERSATIONS_DB_PATH; optional.)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  findingKeyMarker,
  findMergedPrForFindingKey,
  findOpenPrForFindingKey,
  isMeaningfulFindingKey
} from "../services/api/src/domain/loopPrDedup.ts";
import { listOpenLoopPrs, listRecentlyMergedLoopPrs } from "./loopPrLedger.ts";

const argv = process.argv.slice(2);
const sub = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const nextPath = path.join(reportRoot, "anomaly_loop", "next.json");
const keyOf = (w: any) => `${w?.convId ?? ""}::${w?.dimension ?? ""}`;

function loadWorkOrders(): any[] {
  if (!fs.existsSync(nextPath)) {
    console.error(`No work order at ${nextPath} — run anomaly_loop_detect first.`);
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(nextPath, "utf8"));
  return Array.isArray(payload?.workOrders) ? payload.workOrders : [];
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Cross-routine dedup: the gh `pr list` readers live in scripts/loopPrLedger.ts
// (shared with anomaly_loop_detect + loop_pr_ledger_filter). Both fail toward
// building the PR on any gh error, never toward silently dropping a fix.

// If a finding key is supplied and an OPEN PR already carries it, this is a
// duplicate — skip (exit 3, distinct from success/usage/escalate) so the caller
// moves on instead of filing a second PR for the same finding.
function skipIfDuplicateOpenPr(findingKey: string | undefined): void {
  if (!findingKey || !isMeaningfulFindingKey(findingKey)) return;
  const existing =
    findOpenPrForFindingKey(listOpenLoopPrs(), findingKey) ??
    findMergedPrForFindingKey(listRecentlyMergedLoopPrs(), findingKey);
  if (existing) {
    console.log(`DUPLICATE: open PR #${existing.number} already covers "${findingKey}" — skipping (no new PR).`);
    process.exit(3);
  }
}

// Append the machine-readable finding-key marker so a later run (any routine) can
// detect this PR already covers the finding.
function withFindingKeyMarker(body: string, findingKey: string | undefined): string {
  if (!findingKey || !isMeaningfulFindingKey(findingKey)) return body;
  return `${body}\n${findingKeyMarker(findingKey)}\n`;
}

// Read-only triage helper: does an open PR already cover this finding key?
if (sub === "check-open-pr") {
  const key = flag("key");
  if (!key) {
    console.error("check-open-pr requires --key <convId::dimension>");
    process.exit(2);
  }
  const existing = findOpenPrForFindingKey(listOpenLoopPrs(), key);
  if (existing) {
    console.log(`EXISTS #${existing.number} — open PR already covers "${key}"`);
    process.exit(3);
  }
  // A recently-MERGED PR covering the key means the fix already landed and the finding is a
  // stale echo awaiting its report refresh — report as covered (exit 4) so routines stop
  // re-investigating fixes that shipped (the "double work in two routines" class).
  const merged = findMergedPrForFindingKey(listRecentlyMergedLoopPrs(), key);
  if (merged) {
    console.log(`MERGED #${merged.number} — fix already merged (${merged.mergedAt ?? "recent"}) for "${key}"; stale echo, do not rebuild`);
    process.exit(4);
  }
  console.log(`NONE — no open or recently-merged PR covers "${key}"`);
  process.exit(0);
}

if (sub === "list") {
  const orders = loadWorkOrders();
  if (!orders.length) {
    console.log("No work orders — the loop is healthy (stop:true).");
    process.exit(0);
  }
  console.log(`${orders.length} work order(s) (Tier 2 first):\n`);
  for (const w of orders) {
    console.log(`  [T${w.tier} ${w.action}] ${w.dimension}  (${w.severity})`);
    console.log(`     id: ${keyOf(w)}`);
    console.log(`     ${String(w.detail ?? "").trim()}\n`);
  }
  process.exit(0);
}

if (sub === "prep") {
  const orders = loadWorkOrders();
  const id = flag("id");
  const wo = id ? orders.find(w => keyOf(w) === id) : (has("top") ? orders[0] : undefined);
  if (!wo) {
    console.error(id ? `No work order with id ${id}` : "Pass --id <key> or --top. Run `list` to see ids.");
    process.exit(2);
  }
  // Optional conversation context (read-only). For box findings, point CONVERSATIONS_DB_PATH at a copy.
  let thread = "(conversation not available locally — pull it from the box store for full context)";
  let actions = "(unavailable)";
  try {
    const dbPath = process.env.CONVERSATIONS_DB_PATH;
    if (dbPath && fs.existsSync(dbPath)) {
      const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
      const conv = convs.find(c => String(c?.id ?? "") === String(wo.convId));
      if (conv) {
        const msgs = Array.isArray(conv.messages) ? conv.messages : [];
        thread = msgs
          .filter((m: any) => (m?.direction === "in" || m?.direction === "out") && String(m?.body ?? "").trim())
          .slice(-14)
          .map((m: any) => `${m.direction}: ${String(m.body).trim()}`)
          .join("\n");
        // summarizeTurnActions lives in the feed module.
        const mod: any = await import("../services/api/src/domain/conversationOutcomeAudit.ts");
        if (mod?.summarizeTurnActions) actions = JSON.stringify(mod.summarizeTurnActions(conv, []), null, 2);
      }
    }
  } catch {
    /* context is best-effort */
  }
  const key = keyOf(wo);
  const safe = key.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const branch = `fix/loop-${safe}`.slice(0, 60);
  const brief = `# Loop fix brief — ${wo.dimension} (${key})

**Tier ${wo.tier} · ${wo.action} · ${wo.severity}** — ${wo.category}

## Finding
${String(wo.detail ?? "").trim()}

## Lead
convId: ${wo.convId}   leadKey: ${wo.leadKey}

## Agent actions this turn
\`\`\`json
${actions}
\`\`\`

## Conversation (recent)
${thread}

## Fix contract (LAW — AGENTS.md / CLAUDE.md)
- COMPREHEND, never regex: customer intent → a typed LLM parser, not keywords.
- Centralize the decision in routeStateReducer (a decide*Turn), applied in BOTH /webhooks/twilio
  AND /conversations/:id/regenerate (route parity). No inline parser||regex precedence gates.
- Deterministic ONLY for safety/compliance gates, structured extraction, side-effects, invariant guards.
- Add a deterministic eval wired into ci:eval. Gates must be green (tsc + ci:eval).
- This is a loop-driven change → it ships as a PR you review + merge (PR-only; nothing auto-merges).

## Suggested workflow
\`\`\`
git checkout -b ${branch}
#  ... coding agent implements the parser-first fix + eval on this branch, commits ...
set -a; source .env; set +a && npm run ci:eval        # gates
npx tsx scripts/act_runner.ts open-pr --title "Loop fix: ${wo.dimension}" --eval-verified
\`\`\`
`;
  const outDir = path.join(reportRoot, "act");
  fs.mkdirSync(outDir, { recursive: true });
  const briefPath = path.join(outDir, `brief-${safe}.md`);
  fs.writeFileSync(briefPath, brief);
  console.log(`Fix brief written: ${briefPath}`);
  console.log(`Suggested branch: ${branch}`);
  console.log(`\n${brief}`);
  process.exit(0);
}

if (sub === "open-pr") {
  const title = flag("title");
  if (!title) {
    console.error("open-pr requires --title");
    process.exit(2);
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main") {
    console.error("Refusing to open a PR from main — do the fix on a feature branch.");
    process.exit(2);
  }
  const ahead = git(["rev-list", "--count", "main..HEAD"]);
  if (Number(ahead) <= 0) {
    console.error("No commits ahead of main on this branch — nothing to PR.");
    process.exit(2);
  }
  // Cross-routine dedup: if another routine already filed an open PR for this
  // finding, skip before spending the gates.
  skipIfDuplicateOpenPr(flag("finding-key"));
  // GATE: tsc always; ci:eval unless the caller asserts it just passed on this branch.
  console.log("Running tsc…");
  execFileSync("node", ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], {
    cwd: path.resolve("services/api"),
    stdio: "inherit"
  });
  if (!has("eval-verified")) {
    console.log("Running ci:eval (pass --eval-verified to skip if you just ran it)…");
    execFileSync("npm", ["run", "ci:eval"], { stdio: "inherit" });
  } else {
    console.log("Skipping ci:eval (--eval-verified asserted green on this branch).");
  }
  // Push the branch + open the PR (NO merge).
  git(["push", "-u", "origin", branch]);
  const briefDir = path.join(reportRoot, "act");
  const briefFile = fs.existsSync(briefDir)
    ? fs.readdirSync(briefDir).map(f => path.join(briefDir, f)).sort().pop()
    : undefined;
  const body = withFindingKeyMarker(
    (briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : `Loop-driven fix: ${title}`) +
      "\n\n— Opened by the self-healing loop ACT runner (PR-only; review + merge to approve).\n",
    flag("finding-key")
  );
  const url = execFileSync(
    "gh",
    ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body],
    { encoding: "utf8" }
  ).trim();
  console.log(`PR opened (NOT merged): ${url}`);
  process.exit(0);
}

if (sub === "review") {
  // Cross-model PRE-SHIP review: an INDEPENDENT model (Claude) reviews the branch diff against the finding
  // + the law BEFORE it ships. With --ship: open a PR, and merge it ONLY if the review approves (clean +
  // gates green); otherwise leave the PR open and ESCALATE. Without --ship: advisory (print the verdict).
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main") {
    console.error("Refusing to review/ship from main — work on a feature branch.");
    process.exit(2);
  }
  const ahead = git(["rev-list", "--count", "main..HEAD"]);
  if (Number(ahead) <= 0) {
    console.error("No commits ahead of main — nothing to review.");
    process.exit(2);
  }
  // Cross-routine dedup: skip if another routine already filed an open PR for this
  // finding (before spending the gates + the cross-model review).
  if (has("ship")) skipIfDuplicateOpenPr(flag("finding-key"));
  // Gates feed the gate decision (a review can't approve over red gates).
  let evalsGreen = false;
  try {
    console.log("Running tsc…");
    execFileSync("node", ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], { cwd: path.resolve("services/api"), stdio: "inherit" });
    if (has("eval-verified")) {
      console.log("ci:eval asserted green (--eval-verified).");
      evalsGreen = true;
    } else {
      console.log("Running ci:eval…");
      execFileSync("npm", ["run", "ci:eval"], { stdio: "inherit" });
      evalsGreen = true;
    }
  } catch {
    evalsGreen = false;
  }

  const diff = (() => {
    try {
      return execFileSync("git", ["diff", "main...HEAD"], { encoding: "utf8" });
    } catch {
      return "";
    }
  })();
  const title = flag("title") || git(["log", "-1", "--pretty=%s"]);
  const briefDir = path.join(reportRoot, "act");
  const briefFile = fs.existsSync(briefDir) ? fs.readdirSync(briefDir).map(f => path.join(briefDir, f)).sort().pop() : undefined;
  const finding = flag("finding") || (briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8").slice(0, 2000) : title);

  const { reviewLoopFixWithLLM, decidePreShipGate } = await import("../services/api/src/domain/preShipReview.ts");
  const review = await reviewLoopFixWithLLM({ title, finding, diff, evalsGreen });
  const gate = decidePreShipGate(review, { evalsGreen });

  console.log("\n=== CROSS-MODEL PRE-SHIP REVIEW ===");
  if (review) {
    console.log(`verdict=${review.verdict} risk=${review.risk} onTarget=${review.onTarget} lawOk=${review.lawOk} blocking=${review.blocking} customerFacing=${review.customerFacing}`);
    if (review.reasons) console.log(`reasons: ${review.reasons}`);
    if (review.concerns) console.log(`concerns: ${review.concerns}`);
  } else {
    console.log("no independent review available (no ANTHROPIC_API_KEY / disabled)");
  }
  console.log(`\nGATE: ${gate.ship ? "SHIP" : gate.escalate ? "ESCALATE" : "BLOCKED"} — ${gate.reason}`);

  if (!has("ship")) {
    console.log("\n(advisory only — pass --ship to open a PR and merge on a clean approve)");
    process.exit(gate.ship ? 0 : 1);
  }

  // --ship: always leave an auditable PR; merge only on a clean approve.
  if (!flag("title")) {
    console.error("--ship requires --title");
    process.exit(2);
  }
  git(["push", "-u", "origin", branch]);
  const body = withFindingKeyMarker(
    (briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : `Loop-driven fix: ${title}`) +
      `\n\n## Cross-model pre-ship review\n${review ? `verdict=**${review.verdict}** risk=${review.risk} onTarget=${review.onTarget} lawOk=${review.lawOk}\n${review.reasons ?? ""}${review.concerns ? `\nconcerns: ${review.concerns}` : ""}` : "no independent review available"}\n\nGate: **${gate.ship ? "SHIP" : "ESCALATE"}** — ${gate.reason}\n— self-healing loop ACT runner.\n`,
    flag("finding-key")
  );
  const url = execFileSync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", String(title), "--body", body], { encoding: "utf8" }).trim();
  console.log(`PR opened: ${url}`);
  if (gate.ship) {
    execFileSync("gh", ["pr", "merge", "--squash", "--delete-branch", url], { stdio: "inherit" });
    console.log(`MERGED (squash). Deploy next to take it live.`);
    process.exit(0);
  }
  // Escalation: the gate held this for a human → email the operator IMMEDIATELY (not just the daily digest)
  // with the PR + the reason. Best-effort: never let a notification failure change the escalation outcome.
  try {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (apiKey) {
      const { sendEmail } = await import("../services/api/src/domain/emailSender.ts");
      const to = (process.env.LOOP_DIGEST_EMAIL || "integrations@leadrider.ai").trim();
      const from = (process.env.SENDGRID_FROM_EMAIL || "support@leadrider.ai").trim();
      await sendEmail({
        to,
        from,
        subject: `agent-watch: a fix needs your review — ${title}`,
        text: `The self-healing loop opened a fix but the cross-model pre-ship gate did NOT auto-merge it — it needs your review.\n\nPR: ${url}\nGate: ${gate.reason}\n\nReview + merge to approve, or close to reject. (You're getting this immediately, on top of the daily digest.)`
      });
      console.log(`Emailed ${to} (immediate escalation notice).`);
    } else {
      console.log("SENDGRID_API_KEY not set — skipped the immediate escalation email (PR is still open).");
    }
  } catch (err: any) {
    console.log(`Escalation email failed (non-fatal): ${err?.message ?? String(err)}`);
  }
  console.log(`ESCALATED — PR left OPEN for a human: ${url}`);
  process.exit(1);
}

console.error("Usage: act_runner.ts <list | prep --id <key>|--top | check-open-pr --key <convId::dimension> | open-pr --title <t> [--finding-key <k>] [--eval-verified] | review [--ship --title <t>] [--finding-key <k>] [--eval-verified] [--finding <s>]>");
process.exit(2);
