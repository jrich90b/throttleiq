import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }
  return args;
}

function normalizeText(input: unknown): string {
  return String(input ?? "")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(input: unknown): string {
  return normalizeText(input)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toIso(input: unknown): string | null {
  const ms = Date.parse(String(input ?? ""));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function loadStore(filePath: string): { conversations: AnyObj[]; todos: AnyObj[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return { conversations: raw, todos: [] };
  return {
    conversations: Array.isArray(raw?.conversations) ? raw.conversations : [],
    todos: Array.isArray(raw?.todos) ? raw.todos : []
  };
}

function latestActivityMs(conv: AnyObj): number | null {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  const candidates = [
    Date.parse(String(conv?.updatedAt ?? "")),
    ...messages.map(m => Date.parse(String(m?.at ?? "")))
  ].filter(ms => Number.isFinite(ms)) as number[];
  return candidates.length ? Math.max(...candidates) : null;
}

function inferTaskClass(todo: AnyObj): string {
  const explicit = normalizeText(todo?.taskClass).toLowerCase();
  if (explicit) return explicit;
  const text = normalizeText(`${todo?.reason ?? ""} ${todo?.summary ?? ""}`).toLowerCase();
  if (/dealer ride outcome needed|appointment outcome|confirm attendance|record outcome/.test(text)) {
    return "appointment";
  }
  if (/follow[- ]?up|check in|circle back|reach out|touch base|call customer/.test(text)) {
    return "followup";
  }
  if (/finance|credit|approval|prequal|payment|docs?|insurance|co-?signer/.test(text)) {
    return "finance";
  }
  if (/appointment|schedule|test ride|demo ride/.test(text)) return "appointment";
  if (/service/.test(text)) return "service";
  if (/parts?/.test(text)) return "parts";
  if (/apparel|motor clothes/.test(text)) return "apparel";
  return normalizeText(todo?.reason).toLowerCase() || "other";
}

function isActiveCustomerCadence(conv: AnyObj): boolean {
  const status = normalizeText(conv?.followUpCadence?.status).toLowerCase();
  if (status !== "active") return false;
  return !!normalizeText(conv?.followUpCadence?.nextDueAt);
}

function cadenceKind(conv: AnyObj): string {
  return normalizeText(conv?.followUpCadence?.kind).toLowerCase() || "standard";
}

function hasFutureAppointment(conv: AnyObj): boolean {
  const status = normalizeText(conv?.appointment?.status).toLowerCase();
  if (status === "cancelled" || status === "canceled" || status === "completed") return false;
  const ms = Date.parse(String(conv?.appointment?.whenIso ?? ""));
  return Number.isFinite(ms) && ms > Date.now();
}

function isDealerRideOutcomeTask(todo: AnyObj): boolean {
  return /dealer ride outcome needed|dealer ride follow-up needed|dla confirms they rode/i.test(
    normalizeText(todo?.summary)
  );
}

function taskPreview(todo: AnyObj) {
  return {
    id: todo?.id ?? null,
    reason: todo?.reason ?? null,
    taskClass: inferTaskClass(todo),
    ownerName: todo?.ownerName ?? null,
    dueAt: toIso(todo?.dueAt),
    createdAt: toIso(todo?.createdAt),
    summary: normalizeText(todo?.summary).slice(0, 220)
  };
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    out.set(key, [...(out.get(key) ?? []), row]);
  }
  return out;
}

function issuePush(issues: string[], issue: string) {
  if (!issues.includes(issue)) issues.push(issue);
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
  const filePath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    path.join(dataDir, "conversations.json");
  const outPath = args.get("--out") || process.env.FOLLOWUP_TASK_AUDIT_PATH || "";
  const sinceRaw = args.get("--since-hours") || process.env.FOLLOWUP_TASK_AUDIT_SINCE_HOURS || "";
  const sinceHours = Number(sinceRaw);
  const sinceMs = Number.isFinite(sinceHours) && sinceHours > 0 ? Date.now() - sinceHours * 60 * 60 * 1000 : null;

  if (!fs.existsSync(filePath)) {
    console.error(`conversations store not found: ${filePath}`);
    process.exit(1);
  }

  const { conversations, todos } = loadStore(filePath);
  const flagged: AnyObj[] = [];

  for (const conv of conversations) {
    const activityMs = latestActivityMs(conv);
    if (sinceMs != null && (activityMs == null || activityMs < sinceMs)) continue;
    const openTodos = todos.filter(t => t?.convId === conv?.id && normalizeText(t?.status || "open").toLowerCase() === "open");
    const activeCadence = isActiveCustomerCadence(conv);
    const kind = cadenceKind(conv);
    const followUpMode = normalizeText(conv?.followUp?.mode).toLowerCase();
    const pendingDrafts = (Array.isArray(conv?.messages) ? conv.messages : []).filter(
      m => m?.direction === "out" && m?.provider === "draft_ai" && m?.draftStatus !== "stale"
    );
    const issues: string[] = [];
    const evidence: AnyObj = {};

    const byClass = groupBy(openTodos, inferTaskClass);
    const duplicateClassGroups = Array.from(byClass.entries()).filter(
      ([taskClass, rows]) => rows.length > 1 && taskClass !== "note"
    );
    if (duplicateClassGroups.length) {
      issuePush(issues, "duplicate_open_todos_same_class");
      evidence.duplicateTaskClasses = duplicateClassGroups.map(([taskClass, rows]) => ({
        taskClass,
        count: rows.length,
        tasks: rows.map(taskPreview)
      }));
    }

    const bySummary = groupBy(openTodos, todo => normalizeKey(todo?.summary));
    const duplicateSummaryGroups = Array.from(bySummary.entries()).filter(
      ([summaryKey, rows]) => summaryKey.length > 12 && rows.length > 1
    );
    if (duplicateSummaryGroups.length) {
      issuePush(issues, "duplicate_open_todos_same_summary");
      evidence.duplicateSummaries = duplicateSummaryGroups.map(([summaryKey, rows]) => ({
        summaryKey,
        count: rows.length,
        tasks: rows.map(taskPreview)
      }));
    }

    const openFollowUpTodos = openTodos.filter(todo => inferTaskClass(todo) === "followup");
    if (activeCadence && openFollowUpTodos.length > 0) {
      issuePush(issues, "active_cadence_with_open_followup_todo");
      evidence.openFollowUpTodos = openFollowUpTodos.map(taskPreview);
    }

    const openDealerRideTasks = openTodos.filter(isDealerRideOutcomeTask);
    if (activeCadence && openDealerRideTasks.length > 0) {
      issuePush(issues, "active_cadence_with_dealer_ride_outcome_task");
      evidence.openDealerRideTasks = openDealerRideTasks.map(taskPreview);
    }

    if (activeCadence && /manual_handoff|paused_indefinite|holding_inventory/.test(followUpMode) && kind !== "post_sale") {
      issuePush(issues, "manual_or_hold_mode_with_active_customer_cadence");
    }

    if (activeCadence && hasFutureAppointment(conv) && kind !== "post_sale") {
      issuePush(issues, "future_appointment_with_active_customer_cadence");
    }

    if (pendingDrafts.length > 1) {
      issuePush(issues, "multiple_pending_customer_drafts");
      evidence.pendingDrafts = pendingDrafts.slice(-5).map((draft: AnyObj) => ({
        id: draft?.id ?? null,
        at: toIso(draft?.at),
        body: normalizeText(draft?.body).slice(0, 220)
      }));
    }

    if (!issues.length) continue;
    flagged.push({
      id: conv?.id ?? null,
      leadKey: conv?.leadKey ?? null,
      leadRef: conv?.lead?.leadRef ?? null,
      name:
        normalizeText(conv?.lead?.name) ||
        [conv?.lead?.firstName, conv?.lead?.lastName].filter(Boolean).join(" ").trim() ||
        null,
      ownerName: conv?.leadOwner?.name ?? null,
      status: conv?.status ?? "open",
      mode: conv?.mode ?? null,
      followUpMode: followUpMode || null,
      cadenceStatus: conv?.followUpCadence?.status ?? null,
      cadenceKind: kind,
      nextDueAt: toIso(conv?.followUpCadence?.nextDueAt),
      openTodoCount: openTodos.length,
      pendingDraftCount: pendingDrafts.length,
      issues,
      evidence
    });
  }

  const issueCounts = new Map<string, number>();
  for (const row of flagged) {
    for (const issue of row.issues as string[]) {
      issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
    }
  }

  const report = {
    ok: true,
    summary: {
      evaluatedAt: new Date().toISOString(),
      filePath,
      sinceHours: sinceMs == null ? null : sinceHours,
      totalConversations: conversations.length,
      totalTodos: todos.length,
      flaggedConversations: flagged.length,
      issueCounts: Array.from(issueCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([issue, count]) => ({ issue, count }))
    },
    flagged: flagged.sort((a, b) => String(a.name ?? a.leadKey ?? "").localeCompare(String(b.name ?? b.leadKey ?? "")))
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`);
  }
  console.log(json);
}

run();
