/**
 * Console Copilot endpoints (Phase 1, docs/console_copilot_phase1.md) — READ-ONLY manager
 * insights. GET is fully deterministic (no LLM); POST /copilot/ask sends the manager's
 * question plus the deterministic snapshot to the LLM, capped per day so a stuck client
 * can't run up spend. Lives here (not index.ts) per the source-size ratchet.
 */
import type { Express, Request, Response } from "express";
import { buildCopilotSnapshot, renderCopilotSnapshotForLLM } from "../domain/copilotInsights.js";
import { answerCopilotQuestionWithLLM, parseMarketingListRequestWithLLM } from "../domain/copilotLLM.js";
import { getAllConversations, listOpenTodos } from "../domain/conversationStore.js";
import { buildMarketingList } from "../domain/marketingLists.js";
import { isSuppressed } from "../domain/suppressionStore.js";

function requireManagerUser(req: Request, res: Response): boolean {
  const user = (req as any).user ?? null;
  if (String(user?.role ?? "").toLowerCase() !== "manager") {
    res.status(403).json({ ok: false, error: "manager access required" });
    return false;
  }
  return true;
}

export function copilotInsightsHandler(req: Request, res: Response) {
  if (!requireManagerUser(req, res)) return;
  const snapshot = buildCopilotSnapshot(getAllConversations(), listOpenTodos(), Date.now());
  res.json({ ok: true, snapshot });
}

const copilotAskBudget = { day: "", used: 0 };

export async function copilotAskHandler(req: Request, res: Response) {
  if (!requireManagerUser(req, res)) return;
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ ok: false, error: "question required" });
  if (question.length > 500) {
    return res.status(400).json({ ok: false, error: "question too long (500 chars max)" });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (copilotAskBudget.day !== today) {
    copilotAskBudget.day = today;
    copilotAskBudget.used = 0;
  }
  const dailyCap = Number(process.env.COPILOT_ASK_DAILY_CAP ?? "200");
  if (copilotAskBudget.used >= dailyCap) {
    return res.status(429).json({ ok: false, error: "copilot daily budget reached" });
  }
  copilotAskBudget.used += 1;
  const snapshot = buildCopilotSnapshot(getAllConversations(), listOpenTodos(), Date.now());
  const parsed = await answerCopilotQuestionWithLLM({
    question,
    snapshotText: renderCopilotSnapshotForLLM(snapshot)
  });
  if (!parsed) return res.status(503).json({ ok: false, error: "copilot llm unavailable" });
  res.json({
    ok: true,
    answer: parsed.answer,
    leadRefs: parsed.leadRefs,
    generatedAt: snapshot.generatedAt
  });
}

/**
 * Phase 2: marketing-list builder (docs/console_copilot_phase2.md). PRODUCES a list —
 * never sends. Body: {filters} (typed) or {describe} (plain English → LLM → typed filters;
 * shares the ask daily budget). Compliance exclusions live in domain/marketingLists.ts and
 * cannot be bypassed from here: the handler always passes the live STOP-list predicate.
 */
export async function copilotMarketingListHandler(req: Request, res: Response) {
  if (!requireManagerUser(req, res)) return;
  const describe = String(req.body?.describe ?? "").trim();
  let filters = req.body?.filters ?? null;
  if (!filters && describe) {
    if (describe.length > 500) {
      return res.status(400).json({ ok: false, error: "description too long (500 chars max)" });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (copilotAskBudget.day !== today) {
      copilotAskBudget.day = today;
      copilotAskBudget.used = 0;
    }
    const dailyCap = Number(process.env.COPILOT_ASK_DAILY_CAP ?? "200");
    if (copilotAskBudget.used >= dailyCap) {
      return res.status(429).json({ ok: false, error: "copilot daily budget reached" });
    }
    copilotAskBudget.used += 1;
    filters = await parseMarketingListRequestWithLLM({ request: describe });
    if (!filters) return res.status(503).json({ ok: false, error: "copilot llm unavailable" });
  }
  if (!filters || (filters.channel !== "sms" && filters.channel !== "email")) {
    return res.status(400).json({ ok: false, error: "filters.channel must be sms or email" });
  }
  const result = buildMarketingList(getAllConversations(), {
    filters,
    isPhoneSuppressed: isSuppressed,
    nowMs: Date.now()
  });
  res.json({ ok: true, filters, result });
}

/** One-line registration for index.ts (which sits at its size-ratchet ceiling). */
export function registerCopilotRoutes(app: Pick<Express, "get" | "post">) {
  app.get("/copilot/insights", copilotInsightsHandler);
  app.post("/copilot/ask", copilotAskHandler);
  app.post("/copilot/marketing-list", copilotMarketingListHandler);
}
