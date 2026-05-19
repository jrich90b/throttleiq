import type { AgentTask } from "./agentTaskStore.js";

export type ClaudeAgentResult =
  | {
      ok: true;
      summary: string;
      model: string;
    }
  | {
      ok: false;
      reason: "not_configured" | "api_error";
      error: string;
    };

function parseClaudeText(data: any): string {
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .join("\n")
    .trim();
}

export async function runClaudeAgentTask(task: AgentTask): Promise<ClaudeAgentResult> {
  const apiKey = String(process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    return {
      ok: false,
      reason: "not_configured",
      error: "ANTHROPIC_API_KEY is not set."
    };
  }

  const model = String(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514").trim();
  const maxTokensRaw = Number(process.env.ANTHROPIC_AGENT_MAX_TOKENS ?? "1200");
  const max_tokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 100 ? Math.floor(maxTokensRaw) : 1200;
  const system = [
    "You are LeadRider's Support Agent.",
    "You prepare internal support work for approval. Never claim you sent an email, closed a ticket, changed code, approved a run, billed a customer, or touched production.",
    "Return a concise operator-ready output with these sections:",
    "Summary, Recommended action, Draft reply if applicable, Approval needed, Codex/code task needed.",
    "If a customer-facing reply is requested, draft it but make clear it is not sent."
  ].join(" ");
  const user = [
    `Task title: ${task.title}`,
    `Task kind: ${task.kind}`,
    `Client: ${task.clientName || "LeadRider"}`,
    `Priority: ${task.priority}`,
    task.approval?.reason ? `Approval policy: ${task.approval.reason}` : "",
    "",
    "Instructions:",
    task.instructions
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok) {
      return {
        ok: false,
        reason: "api_error",
        error: String(data?.error?.message ?? data?.message ?? `Anthropic request failed with ${resp.status}`)
      };
    }
    const summary = parseClaudeText(data);
    if (!summary) {
      return {
        ok: false,
        reason: "api_error",
        error: "Claude returned an empty response."
      };
    }
    return { ok: true, summary, model };
  } catch (err: any) {
    return {
      ok: false,
      reason: "api_error",
      error: err?.message ?? String(err)
    };
  }
}
