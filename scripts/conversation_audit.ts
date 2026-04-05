import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

function normPhone(input: unknown): string {
  return String(input ?? "").replace(/\D/g, "");
}

function toIso(input: unknown): string | null {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function ageMinutes(input: unknown): number | null {
  const iso = toIso(input);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Math.max(0, (Date.now() - ms) / 60000);
}

function isShortAckNoAction(text: unknown): boolean {
  const t = String(text ?? "")
    .trim()
    .toLowerCase();
  if (!t) return false;
  if (/^[\p{Emoji}\p{Extended_Pictographic}\s]+$/u.test(t)) return true;
  return /^(ok|okay|k|kk|got it|sounds good|thanks|thank you|thx|ty|perfect|awesome|cool|great)[.!?\s]*$/i.test(
    t
  );
}

function loadStore(filePath: string): { conversations: AnyObj[]; todos: AnyObj[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return { conversations: raw, todos: [] };
  const conversations = Array.isArray(raw?.conversations) ? raw.conversations : [];
  const todos = Array.isArray(raw?.todos) ? raw.todos : [];
  return { conversations, todos };
}

function lastMessageByDirection(messages: AnyObj[], direction: "in" | "out"): AnyObj | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.direction === direction) return m;
  }
  return null;
}

function hasOutboundAfter(messages: AnyObj[], at: unknown): boolean {
  const inboundMs = Date.parse(String(at ?? ""));
  if (!Number.isFinite(inboundMs)) return false;
  return messages.some(m => {
    if (m?.direction !== "out") return false;
    const outMs = Date.parse(String(m?.at ?? ""));
    return Number.isFinite(outMs) && outMs >= inboundMs;
  });
}

function issuePush(issues: string[], issue: string) {
  if (!issues.includes(issue)) issues.push(issue);
}

function run() {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
  const filePath = process.env.CONVERSATIONS_DB_PATH || path.join(dataDir, "conversations.json");
  const sinceHoursRaw = String(process.env.AUDIT_SINCE_HOURS ?? "").trim();
  const sinceHours = Number.isFinite(Number(sinceHoursRaw)) ? Number(sinceHoursRaw) : 0;
  const sinceMs = sinceHours > 0 ? Date.now() - sinceHours * 60 * 60 * 1000 : null;
  const windowStartIso = sinceMs != null ? new Date(sinceMs).toISOString() : null;
  if (!fs.existsSync(filePath)) {
    console.error(`conversations.json not found: ${filePath}`);
    process.exit(1);
  }

  const { conversations, todos } = loadStore(filePath);
  const nowIso = new Date().toISOString();
  const results: Array<AnyObj> = [];

  let scopedConversations = 0;
  for (const conv of conversations) {
    const issues: string[] = [];
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];
    const lastInbound = lastMessageByDirection(messages, "in");
    const lastOutbound = lastMessageByDirection(messages, "out");
    const activityCandidates = [
      Date.parse(String(conv?.updatedAt ?? "")),
      Date.parse(String(lastInbound?.at ?? "")),
      Date.parse(String(lastOutbound?.at ?? ""))
    ].filter(ms => Number.isFinite(ms)) as number[];
    const latestActivityMs = activityCandidates.length > 0 ? Math.max(...activityCandidates) : null;
    if (sinceMs != null && (latestActivityMs == null || latestActivityMs < sinceMs)) {
      continue;
    }
    scopedConversations += 1;

    const pendingDrafts = messages.filter(
      m => m?.direction === "out" && m?.provider === "draft_ai" && m?.draftStatus !== "stale"
    );
    if (pendingDrafts.length > 0) {
      issuePush(issues, "pending_draft");
      const newestDraft = pendingDrafts[pendingDrafts.length - 1];
      const draftAge = ageMinutes(newestDraft?.at);
      if (draftAge != null && draftAge > 30) issuePush(issues, "pending_draft_older_than_30m");
    }

    if (lastInbound && !hasOutboundAfter(messages, lastInbound?.at)) {
      const inboundAge = ageMinutes(lastInbound?.at);
      if (inboundAge != null && inboundAge > 2 && !isShortAckNoAction(lastInbound?.body)) {
        issuePush(issues, "inbound_unanswered");
      }
    }

    const followUpMode = String(conv?.followUp?.mode ?? "");
    const cadenceKind = String(conv?.followUpCadence?.kind ?? "");
    const cadenceStatus = String(conv?.followUpCadence?.status ?? "");
    const cadenceStopReason = String(conv?.followUpCadence?.stopReason ?? "");
    const dialogState = String(conv?.dialogState?.name ?? "none");

    if (
      followUpMode === "manual_handoff" &&
      cadenceStatus === "active" &&
      cadenceKind !== "post_sale" &&
      cadenceKind !== "long_term"
    ) {
      issuePush(issues, "manual_handoff_with_active_standard_cadence");
    }

    if (
      cadenceKind === "post_sale" &&
      cadenceStatus === "stopped" &&
      cadenceStopReason === "manual_handoff"
    ) {
      issuePush(issues, "post_sale_stopped_by_manual_handoff");
    }

    if (
      cadenceKind === "long_term" &&
      cadenceStatus === "stopped" &&
      cadenceStopReason === "manual_handoff"
    ) {
      issuePush(issues, "long_term_stopped_by_manual_handoff");
    }

    if (dialogState === "inventory_watch_prompted" && !conv?.inventoryWatchPending) {
      issuePush(issues, "watch_prompt_state_without_pending_payload");
    }

    const watchPendingAge = ageMinutes(conv?.inventoryWatchPending?.askedAt);
    if (conv?.inventoryWatchPending && watchPendingAge != null && watchPendingAge > 24 * 60) {
      issuePush(issues, "inventory_watch_pending_older_than_24h");
    }

    if (followUpMode === "manual_handoff" && pendingDrafts.length > 0) {
      issuePush(issues, "pending_draft_while_manual_handoff");
    }

    if (!conv?.lead?.phone && !normPhone(conv?.leadKey)) {
      issuePush(issues, "missing_phone_identity");
    }

    if (issues.length > 0) {
      const convTodos = todos.filter(t => t?.convId === conv?.id);
      const openTodos = convTodos.filter(t => String(t?.status ?? "open") === "open");
      results.push({
        id: conv?.id,
        leadKey: conv?.leadKey,
        leadRef: conv?.lead?.leadRef,
        phone: conv?.lead?.phone ?? null,
        name:
          conv?.lead?.name ||
          [conv?.lead?.firstName, conv?.lead?.lastName].filter(Boolean).join(" ") ||
          null,
        mode: conv?.mode ?? null,
        status: conv?.status ?? null,
        followUpMode: followUpMode || null,
        cadenceKind: cadenceKind || null,
        cadenceStatus: cadenceStatus || null,
        cadenceStopReason: cadenceStopReason || null,
        dialogState,
        lastInboundAt: toIso(lastInbound?.at),
        lastOutboundAt: toIso(lastOutbound?.at),
        pendingDraftCount: pendingDrafts.length,
        openTodoCount: openTodos.length,
        issues
      });
    }
  }

  const issueCounts = new Map<string, number>();
  for (const row of results) {
    for (const issue of row.issues as string[]) {
      issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
    }
  }

  const summary = {
    evaluatedAt: nowIso,
    filePath,
    sinceHours: sinceHours > 0 ? sinceHours : null,
    windowStart: windowStartIso,
    totalConversations: scopedConversations,
    totalConversationsAll: conversations.length,
    openConversations: conversations.filter(c => {
      const messages = Array.isArray(c?.messages) ? c.messages : [];
      const lastInbound = lastMessageByDirection(messages, "in");
      const lastOutbound = lastMessageByDirection(messages, "out");
      const activityCandidates = [
        Date.parse(String(c?.updatedAt ?? "")),
        Date.parse(String(lastInbound?.at ?? "")),
        Date.parse(String(lastOutbound?.at ?? ""))
      ].filter(ms => Number.isFinite(ms)) as number[];
      const latestActivityMs = activityCandidates.length > 0 ? Math.max(...activityCandidates) : null;
      if (sinceMs != null && (latestActivityMs == null || latestActivityMs < sinceMs)) return false;
      return String(c?.status ?? "open") !== "closed";
    }).length,
    closedConversations: conversations.filter(c => {
      const messages = Array.isArray(c?.messages) ? c.messages : [];
      const lastInbound = lastMessageByDirection(messages, "in");
      const lastOutbound = lastMessageByDirection(messages, "out");
      const activityCandidates = [
        Date.parse(String(c?.updatedAt ?? "")),
        Date.parse(String(lastInbound?.at ?? "")),
        Date.parse(String(lastOutbound?.at ?? ""))
      ].filter(ms => Number.isFinite(ms)) as number[];
      const latestActivityMs = activityCandidates.length > 0 ? Math.max(...activityCandidates) : null;
      if (sinceMs != null && (latestActivityMs == null || latestActivityMs < sinceMs)) return false;
      return String(c?.status ?? "") === "closed";
    }).length,
    totalTodos: todos.length,
    flaggedConversations: results.length,
    issueCounts: Array.from(issueCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([issue, count]) => ({ issue, count }))
  };

  console.log(JSON.stringify({ ok: true, summary, flagged: results }, null, 2));
}

run();
