/**
 * ONE caller for the Anthropic Messages API.
 *
 * WHY THIS EXISTS (2026-08-02). Joe asked for the most capable model on our judges. Pointing the
 * open critic and the pre-ship reviewer at `claude-opus-5` by config alone did **nothing** —
 * every call came back `400: "temperature is deprecated for this model."`, because both of our
 * hand-rolled request builders hardcode `temperature: 0`. Measured on the box:
 *
 *     claude-opus-5   + temperature:0  -> 400 in 251ms
 *     claude-opus-5   (no temperature) -> 200 in 2806ms, tool_use returned correctly
 *     claude-sonnet-4-6 + temperature:0 -> 200 (so the quirk is model-specific, not ours)
 *
 * **The dangerous part is the fail direction of that 400.** `requestStructuredJsonAnthropic`
 * returns null on any non-OK response and the open critic then quietly falls through to its
 * OpenAI arm — so the config change would have read as "we upgraded the critic to Opus" while
 * 100% of critiques kept coming from `gpt-5-mini`, with nothing in any log saying so. Same shape
 * as the wrongful-silence judge that watched 10 of 230 silences: the instrument reports fine
 * while measuring nothing. The pre-ship reviewer fails safer (a null review escalates instead of
 * merging) but would have silently switched auto-merge off for every routine.
 *
 * There were FOUR hand-maintained Anthropic request builders, which is why the fix is a module and
 * not a one-line patch: llmDraft's `requestStructuredJsonAnthropic` (the open critic), preShipReview's
 * inline fetch (the auto-merge gate), `generateDraftViaAnthropic` (the CUSTOMER-FACING draft A/B
 * arm) and claudeAgent's runner. Only the first two were on my list when I started; the eval's
 * repo-wide scan found the other two, and the draft arm carries the same latent bug — point
 * `ANTHROPIC_DRAFT_MODEL` at Opus and customer drafts would have silently fallen back to OpenAI.
 * They now share this module: one place where a model's request-shape quirk gets handled, per the
 * un-stack doctrine (give a contended thing one referee rather than an Nth writer).
 *
 * The OpenAI side already had this idea — `modelSupportsTemperature` in llmDraft.ts omits
 * temperature for gpt-5 models. This is the Anthropic sibling, deliberately learned rather than
 * listed; merging the two notions is a fair follow-up but would touch the OpenAI request path,
 * which this change has no reason to disturb.
 *
 * HOW THE QUIRK IS HANDLED — learned, not listed. A hardcoded table of "models that reject
 * temperature" is wrong the day the next model ships. Instead the first call to a given model
 * sends temperature as asked; if the API rejects it with exactly that complaint, the model is
 * recorded in-process and the call is retried once WITHOUT temperature. Every later call in that
 * process skips the parameter outright, so the cost is one extra ~250ms round trip per model per
 * boot. `ANTHROPIC_MODELS_WITHOUT_TEMPERATURE` can pre-seed the set to skip even that.
 *
 * FAIL DIRECTION: the retry only ever fires on a 400 that names temperature, and it only ever
 * REMOVES a parameter — it can never turn a refusal into a send, or a hold into an approve. Any
 * other error returns exactly what it returned before. Determinism note: on a model that
 * deprecates temperature there is no knob to set, so a judge there is inherently less repeatable
 * than one pinned at 0; that is the model's contract, not a choice we are making here.
 */

export type AnthropicMessagesResult = {
  ok: boolean;
  status: number;
  data: any | null;
  /** True when the first attempt was rejected for `temperature` and we retried without it. */
  retriedWithoutTemperature: boolean;
  /** Wall-clock ms across every attempt — the judges log this to compare model latency. */
  elapsedMs: number;
};

/** Models observed (or configured) to reject `temperature`. Learned at runtime, per process. */
const TEMPERATURE_UNSUPPORTED = new Set<string>(
  String(process.env.ANTHROPIC_MODELS_WITHOUT_TEMPERATURE ?? "")
    .split(",")
    .map(m => m.trim())
    .filter(Boolean)
);

export function anthropicModelRejectsTemperature(model: string): boolean {
  return TEMPERATURE_UNSUPPORTED.has(String(model ?? "").trim());
}

/** Exported for the eval; also how the retry records what it learned. */
export function noteAnthropicModelRejectsTemperature(model: string): void {
  const key = String(model ?? "").trim();
  if (key) TEMPERATURE_UNSUPPORTED.add(key);
}

/**
 * Is this specific 400 the "temperature is deprecated for this model" complaint?
 *
 * Deliberately NARROW — it must not swallow an unrelated 400 into a silent retry. It requires the
 * status to be 400 AND the message to name `temperature`; anything else is returned to the caller
 * untouched. This is a transport-shape check against a fixed API error string, not comprehension
 * of customer text, so a string test is the right tool here (AGENTS.md allows deterministic for
 * structured/transport concerns).
 */
export function isTemperatureRejection(status: number, message: string | null | undefined): boolean {
  if (status !== 400) return false;
  const text = String(message ?? "").toLowerCase();
  return text.includes("temperature") && (text.includes("deprecated") || text.includes("not supported") || text.includes("unsupported"));
}

export async function anthropicMessagesRequest(args: {
  apiKey: string;
  model: string;
  maxTokens: number;
  messages: { role: string; content: string }[];
  /** Anthropic system prompt (the draft arm and the agent runner both use one). */
  system?: string;
  /** Omitted automatically for models that reject it. */
  temperature?: number;
  toolName?: string;
  toolDescription?: string;
  inputSchema?: { [key: string]: unknown };
  timeoutMs?: number;
}): Promise<AnthropicMessagesResult> {
  const startedAt = Date.now();
  const apiKey = String(args.apiKey ?? "").trim();
  if (!apiKey) {
    return { ok: false, status: 0, data: null, retriedWithoutTemperature: false, elapsedMs: 0 };
  }

  const buildBody = (withTemperature: boolean): { [key: string]: unknown } => {
    const body: { [key: string]: unknown } = {
      model: args.model,
      max_tokens: args.maxTokens,
      messages: args.messages
    };
    if (args.system) body.system = args.system;
    if (withTemperature && typeof args.temperature === "number") body.temperature = args.temperature;
    if (args.toolName && args.inputSchema) {
      body.tool_choice = { type: "tool", name: args.toolName };
      body.tools = [
        {
          name: args.toolName,
          description: args.toolDescription ?? "Return the structured result for this judgment.",
          input_schema: args.inputSchema
        }
      ];
    }
    return body;
  };

  const attempt = async (withTemperature: boolean): Promise<{ status: number; data: any | null }> => {
    const controller = typeof args.timeoutMs === "number" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), args.timeoutMs) : null;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(buildBody(withTemperature)),
        ...(controller ? { signal: controller.signal } : {})
      });
      const data: any = await resp.json().catch(() => null);
      return { status: resp.status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const sendTemperature = !anthropicModelRejectsTemperature(args.model);
  let result = await attempt(sendTemperature);
  let retried = false;

  if (
    sendTemperature &&
    isTemperatureRejection(result.status, result.data?.error?.message ?? result.data?.message)
  ) {
    // Learn it once, so every later call in this process skips the wasted round trip.
    noteAnthropicModelRejectsTemperature(args.model);
    retried = true;
    result = await attempt(false);
  }

  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    data: result.data,
    retriedWithoutTemperature: retried,
    elapsedMs: Date.now() - startedAt
  };
}

/** Concatenated text blocks, tolerating leading thinking blocks. Empty string when there are none. */
export function extractAnthropicText(data: any): string {
  return Array.isArray(data?.content)
    ? data.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => String(b?.text ?? ""))
        .join("")
        .trim()
    : "";
}

/** Pull the structured payload out of a tool_use block, tolerating leading thinking/text blocks. */
export function extractAnthropicToolInput(data: any, toolName: string): any | null {
  const block = Array.isArray(data?.content)
    ? data.content.find((b: any) => b?.type === "tool_use" && b?.name === toolName)
    : null;
  const input = block?.input;
  return input && typeof input === "object" ? input : null;
}
