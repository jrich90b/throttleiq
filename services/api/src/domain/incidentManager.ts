import type express from "express";
import * as Sentry from "@sentry/node";
import { initializeSentry, isSentryEnabled } from "./sentryInit.js";

type IncidentSeverity = "info" | "warning" | "error" | "fatal";

type IncidentContext = {
  source?: string;
  route?: string;
  method?: string;
  requestId?: string;
  conversationId?: string | null;
  leadKey?: string | null;
  campaignId?: string | null;
  provider?: string | null;
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
};

type IncidentInput = IncidentContext & {
  title: string;
  error?: unknown;
  severity?: IncidentSeverity;
  captureSentry?: boolean;
};

type IncidentResult = {
  sentryEventId?: string;
  slackSent: boolean;
  linearIssueId?: string;
  deduped: boolean;
};

const INCIDENT_ALERTS_ENABLED = String(process.env.INCIDENT_ALERTS_ENABLED ?? "1") !== "0";
const SLACK_WEBHOOK_URL = String(process.env.SLACK_INCIDENT_WEBHOOK_URL ?? "").trim();
const LINEAR_API_KEY = String(process.env.LINEAR_API_KEY ?? "").trim();
const LINEAR_TEAM_ID = String(process.env.LINEAR_TEAM_ID ?? "").trim();
const LINEAR_PROJECT_ID = String(process.env.LINEAR_PROJECT_ID ?? "").trim();
const LINEAR_ASSIGNEE_ID = String(process.env.LINEAR_ASSIGNEE_ID ?? "").trim();
const LINEAR_LABEL_IDS = String(process.env.LINEAR_LABEL_IDS ?? "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);
const LINEAR_CREATE_ISSUES =
  String(process.env.LINEAR_CREATE_ISSUES ?? (LINEAR_API_KEY && LINEAR_TEAM_ID ? "1" : "0")) === "1";
const LINEAR_ISSUE_PRIORITY = Number(process.env.LINEAR_ISSUE_PRIORITY ?? "2");
const INCIDENT_DEDUPE_MINUTES = Number(process.env.INCIDENT_DEDUPE_MINUTES ?? "30");
const INCIDENT_DEDUPE_MAX = Number(process.env.INCIDENT_DEDUPE_MAX ?? "500");

const incidentDedupe = new Map<string, number>();

export function initializeIncidentMonitoring() {
  initializeSentry();
}

export function installIncidentRequestContext(app: express.Express) {
  app.use((req, res, next) => {
    const requestId =
      req.header("x-request-id") ||
      req.header("x-correlation-id") ||
      req.header("x-amzn-trace-id") ||
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    (req as any).requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });
}

export function installIncidentErrorHandlers(app: express.Express) {
  if (isSentryEnabled()) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void reportIncident({
      title: `Unhandled API error: ${req.method} ${req.path}`,
      error: err,
      severity: "error",
      captureSentry: false,
      source: "express",
      route: req.path,
      method: req.method,
      requestId: String((req as any).requestId ?? ""),
      provider: providerFromPath(req.path),
      extra: {
        url: req.originalUrl,
        query: sanitizeValue(req.query),
        body: sanitizeValue(req.body)
      }
    });

    if (res.headersSent) return;
    res.status(500).json({
      ok: false,
      error: "internal_error",
      requestId: String((req as any).requestId ?? "")
    });
  });
}

export function installProcessIncidentHandlers() {
  process.on("unhandledRejection", reason => {
    void reportIncident({
      title: "Unhandled promise rejection",
      error: reason,
      severity: "fatal",
      source: "process"
    });
  });
  process.on("uncaughtException", err => {
    const forceExit = setTimeout(() => process.exit(1), 2500);
    forceExit.unref?.();
    void reportIncident({
      title: "Uncaught exception",
      error: err,
      severity: "fatal",
      source: "process"
    }).finally(() => process.exit(1));
  });
}

export async function reportIncident(input: IncidentInput): Promise<IncidentResult> {
  const severity = input.severity ?? "error";
  const normalized = normalizeError(input.error);
  const tags = normalizeTags({
    source: input.source,
    route: input.route,
    method: input.method,
    provider: input.provider,
    conversationId: input.conversationId,
    campaignId: input.campaignId,
    ...input.tags
  });
  const extra = sanitizeValue({
    ...input.extra,
    leadKey: input.leadKey,
    requestId: input.requestId,
    stack: normalized.stack
  }) as Record<string, unknown>;

  let sentryEventId: string | undefined;
  if (isSentryEnabled() && input.captureSentry !== false) {
    Sentry.withScope(scope => {
      scope.setLevel(severity === "fatal" ? "fatal" : severity);
      for (const [key, value] of Object.entries(tags)) scope.setTag(key, String(value));
      scope.setContext("incident", extra);
      sentryEventId = input.error
        ? Sentry.captureException(input.error)
        : Sentry.captureMessage(input.title, severity === "fatal" ? "fatal" : severity);
    });
  }

  const dedupeKey = buildDedupeKey(input.title, normalized.message, tags);
  const deduped = isDeduped(dedupeKey);
  if (deduped || !INCIDENT_ALERTS_ENABLED) {
    return { sentryEventId, slackSent: false, deduped };
  }

  const summary = {
    title: input.title,
    severity,
    message: normalized.message,
    sentryEventId,
    requestId: input.requestId,
    tags,
    extra
  };

  const [slackSent, linearIssueId] = await Promise.all([
    sendSlackIncident(summary),
    createLinearIncident(summary)
  ]);

  return { sentryEventId, slackSent, linearIssueId, deduped: false };
}

async function sendSlackIncident(summary: Record<string, any>): Promise<boolean> {
  if (!SLACK_WEBHOOK_URL) return false;
  const fields = [
    `*Severity:* ${summary.severity}`,
    summary.requestId ? `*Request:* ${summary.requestId}` : "",
    summary.sentryEventId ? `*Sentry:* ${summary.sentryEventId}` : "",
    summary.tags?.route ? `*Route:* ${summary.tags.route}` : "",
    summary.tags?.provider ? `*Provider:* ${summary.tags.provider}` : ""
  ].filter(Boolean);
  const text = [`*${summary.title}*`, summary.message, ...fields].filter(Boolean).join("\n");
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    return res.ok;
  } catch (err: any) {
    console.warn("[incident] slack alert failed:", err?.message ?? err);
    return false;
  }
}

async function createLinearIncident(summary: Record<string, any>): Promise<string | undefined> {
  if (!LINEAR_CREATE_ISSUES || !LINEAR_API_KEY || !LINEAR_TEAM_ID) return undefined;
  const mutation = `
    mutation IncidentIssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }
  `;
  const bodyLines = [
    summary.message,
    "",
    "## Context",
    `- Severity: ${summary.severity}`,
    summary.requestId ? `- Request ID: ${summary.requestId}` : "",
    summary.sentryEventId ? `- Sentry event: ${summary.sentryEventId}` : "",
    summary.tags?.route ? `- Route: ${summary.tags.route}` : "",
    summary.tags?.provider ? `- Provider: ${summary.tags.provider}` : "",
    summary.tags?.conversationId ? `- Conversation: ${summary.tags.conversationId}` : "",
    summary.tags?.campaignId ? `- Campaign: ${summary.tags.campaignId}` : "",
    "",
    "## Sanitized Extra",
    "```json",
    JSON.stringify(summary.extra ?? {}, null, 2).slice(0, 6000),
    "```"
  ].filter(line => line !== "");
  const input: Record<string, unknown> = {
    teamId: LINEAR_TEAM_ID,
    title: `[${String(summary.severity).toUpperCase()}] ${summary.title}`.slice(0, 240),
    description: bodyLines.join("\n"),
    priority: Number.isFinite(LINEAR_ISSUE_PRIORITY) ? LINEAR_ISSUE_PRIORITY : 2
  };
  if (LINEAR_PROJECT_ID) input.projectId = LINEAR_PROJECT_ID;
  if (LINEAR_ASSIGNEE_ID) input.assigneeId = LINEAR_ASSIGNEE_ID;
  if (LINEAR_LABEL_IDS.length) input.labelIds = LINEAR_LABEL_IDS;

  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: LINEAR_API_KEY
      },
      body: JSON.stringify({ query: mutation, variables: { input } })
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || json?.errors?.length || !json?.data?.issueCreate?.success) {
      console.warn("[incident] linear issue create failed:", json?.errors?.[0]?.message ?? res.statusText);
      return undefined;
    }
    return String(json.data.issueCreate.issue?.identifier ?? json.data.issueCreate.issue?.id ?? "");
  } catch (err: any) {
    console.warn("[incident] linear issue create failed:", err?.message ?? err);
    return undefined;
  }
}

function isDeduped(key: string): boolean {
  const now = Date.now();
  const ttlMs =
    Number.isFinite(INCIDENT_DEDUPE_MINUTES) && INCIDENT_DEDUPE_MINUTES > 0
      ? INCIDENT_DEDUPE_MINUTES * 60 * 1000
      : 30 * 60 * 1000;
  for (const [existingKey, ts] of incidentDedupe.entries()) {
    if (now - ts > ttlMs || incidentDedupe.size > INCIDENT_DEDUPE_MAX) {
      incidentDedupe.delete(existingKey);
    }
  }
  const last = incidentDedupe.get(key);
  if (last && now - last < ttlMs) return true;
  incidentDedupe.set(key, now);
  return false;
}

function buildDedupeKey(title: string, message: string, tags: Record<string, string | number | boolean>): string {
  return [
    title,
    message,
    tags.route ?? "",
    tags.provider ?? "",
    tags.source ?? ""
  ]
    .join("|")
    .slice(0, 500);
}

function normalizeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      stack: error.stack
    };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error).slice(0, 1000) };
  } catch {
    return { message: String(error) };
  }
}

function normalizeTags(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

function providerFromPath(pathname: string): string | undefined {
  if (/twilio/i.test(pathname)) return "twilio";
  if (/sendgrid/i.test(pathname)) return "sendgrid";
  if (/meta/i.test(pathname)) return "meta";
  if (/campaign/i.test(pathname)) return "campaign";
  if (/google/i.test(pathname)) return "google";
  return undefined;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 25).map(sanitizeValue);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key|signature/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitizeValue(raw);
    }
  }
  return out;
}
