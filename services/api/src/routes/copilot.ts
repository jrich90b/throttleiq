/**
 * Console Copilot endpoints (Phase 1, docs/console_copilot_phase1.md) — READ-ONLY manager
 * insights. GET is fully deterministic (no LLM); POST /copilot/ask sends the manager's
 * question plus the deterministic snapshot to the LLM, capped per day so a stuck client
 * can't run up spend. Lives here (not index.ts) per the source-size ratchet.
 */
import type { Request, Response } from "express";
import { buildCopilotSnapshot, renderCopilotSnapshotForLLM } from "../domain/copilotInsights.js";
import { answerCopilotQuestionWithLLM } from "../domain/llmDraft.js";
import { getAllConversations, listOpenTodos } from "../domain/conversationStore.js";

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
