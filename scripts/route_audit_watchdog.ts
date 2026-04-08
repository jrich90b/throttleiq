import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  conversationsPath: string;
  routeAuditDir: string;
  sinceMin: number;
  stuckOlderSec: number;
  limit: number;
  outPath?: string;
  failOnStuckOver: number;
  failOnNoResponseOver: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }

  const cwd = process.cwd();
  const reportRoot = process.env.REPORT_ROOT || path.resolve(cwd, "reports");
  const dataDir = process.env.DATA_DIR || path.resolve(cwd, "data");
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    path.join(dataDir, "conversations.json");
  const routeAuditDir =
    args.get("--route-audit-dir") ||
    process.env.ROUTE_AUDIT_DIR ||
    path.join(reportRoot, "route_audit");
  const sinceMinRaw = Number(args.get("--since-min") || process.env.ROUTE_WATCHDOG_SINCE_MIN || "180");
  const stuckOlderSecRaw = Number(
    args.get("--stuck-older-sec") || process.env.ROUTE_WATCHDOG_STUCK_OLDER_SEC || "120"
  );
  const limitRaw = Number(args.get("--limit") || process.env.ROUTE_WATCHDOG_LIMIT || "50");
  const failOnStuckOverRaw = Number(
    args.get("--fail-on-stuck-over") || process.env.ROUTE_WATCHDOG_FAIL_ON_STUCK_OVER || "-1"
  );
  const failOnNoResponseOverRaw = Number(
    args.get("--fail-on-no-response-over") ||
      process.env.ROUTE_WATCHDOG_FAIL_ON_NO_RESPONSE_OVER ||
      "-1"
  );
  const outPath = args.get("--out") || process.env.ROUTE_WATCHDOG_OUT || undefined;

  return {
    conversationsPath,
    routeAuditDir,
    sinceMin: Number.isFinite(sinceMinRaw) && sinceMinRaw > 0 ? sinceMinRaw : 180,
    stuckOlderSec: Number.isFinite(stuckOlderSecRaw) && stuckOlderSecRaw > 0 ? stuckOlderSecRaw : 120,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50,
    outPath,
    failOnStuckOver: Number.isFinite(failOnStuckOverRaw) ? failOnStuckOverRaw : -1,
    failOnNoResponseOver: Number.isFinite(failOnNoResponseOverRaw) ? failOnNoResponseOverRaw : -1
  };
}

function toConversations(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  return [];
}

function toMs(iso: string): number {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function dateStampUtc(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function dateStampsSince(sinceMs: number, nowMs: number): string[] {
  const out: string[] = [];
  const cur = new Date(sinceMs);
  cur.setUTCHours(0, 0, 0, 0);
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 60) {
    out.push(dateStampUtc(cur.getTime()));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
  }
  if (!out.length) out.push(dateStampUtc(nowMs));
  return out;
}

function readJsonl(filePath: string): AnyObj[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);
  const rows: AnyObj[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed row
    }
  }
  return rows;
}

function collectStuckTurns(conversations: any[], olderThanSec: number, nowMs: number) {
  return conversations
    .map(conv => {
      const messages = Array.isArray(conv?.messages) ? [...conv.messages] : [];
      messages.sort((a, b) => toMs(String(a?.at ?? "")) - toMs(String(b?.at ?? "")));
      const lastInbound = [...messages].reverse().find((m: any) => {
        const provider = String(m?.provider ?? "");
        return (
          m?.direction === "in" &&
          (provider === "twilio" || provider === "sendgrid" || provider === "sendgrid_adf")
        );
      });
      if (!lastInbound?.at) return null;
      const inboundAtMs = toMs(String(lastInbound.at));
      if (!Number.isFinite(inboundAtMs)) return null;

      const hasOutboundAfter = messages.some((m: any) => {
        if (m?.direction !== "out") return false;
        const outAtMs = toMs(String(m?.at ?? ""));
        return Number.isFinite(outAtMs) && outAtMs >= inboundAtMs;
      });
      if (hasOutboundAfter) return null;

      const ageSec = Math.floor((nowMs - inboundAtMs) / 1000);
      if (ageSec < olderThanSec) return null;

      return {
        convId: String(conv?.id ?? ""),
        leadKey: String(conv?.leadKey ?? ""),
        followUp: conv?.followUp ?? null,
        dialogState: conv?.dialogState ?? null,
        classification: conv?.classification ?? null,
        lastInbound: {
          at: String(lastInbound.at),
          provider: String(lastInbound.provider ?? ""),
          body: String(lastInbound.body ?? "").slice(0, 220)
        },
        ageSec
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.ageSec - a.ageSec);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.conversationsPath)) {
    console.error(`Conversations file not found: ${parsed.conversationsPath}`);
    process.exit(1);
  }

  const nowMs = Date.now();
  const sinceMs = nowMs - parsed.sinceMin * 60 * 1000;
  const raw = JSON.parse(fs.readFileSync(parsed.conversationsPath, "utf8"));
  const conversations = toConversations(raw);

  const stuckRows = collectStuckTurns(conversations, parsed.stuckOlderSec, nowMs).slice(0, parsed.limit);

  const outcomeFiles = dateStampsSince(sinceMs, nowMs).map(stamp =>
    path.join(parsed.routeAuditDir, `route_outcomes_${stamp}.jsonl`)
  );
  const outcomeRows = outcomeFiles.flatMap(readJsonl).filter(r => {
    const tsMs = toMs(String(r?.ts ?? ""));
    return Number.isFinite(tsMs) && tsMs >= sinceMs;
  });

  const outcomeCountMap = new Map<string, number>();
  for (const row of outcomeRows) {
    const key = String(row?.outcome ?? "unknown").trim() || "unknown";
    outcomeCountMap.set(key, (outcomeCountMap.get(key) ?? 0) + 1);
  }
  const topOutcomes = [...outcomeCountMap.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const noResponseOutcomeCount = outcomeRows.filter(r =>
    String(r?.outcome ?? "").toLowerCase().includes("no_response")
  ).length;

  const failReasons: string[] = [];
  if (parsed.failOnStuckOver >= 0 && stuckRows.length > parsed.failOnStuckOver) {
    failReasons.push(
      `stuck_turns=${stuckRows.length} exceeds fail-on-stuck-over=${parsed.failOnStuckOver}`
    );
  }
  if (parsed.failOnNoResponseOver >= 0 && noResponseOutcomeCount > parsed.failOnNoResponseOver) {
    failReasons.push(
      `no_response_outcomes=${noResponseOutcomeCount} exceeds fail-on-no-response-over=${parsed.failOnNoResponseOver}`
    );
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: {
      conversationsPath: parsed.conversationsPath,
      routeAuditDir: parsed.routeAuditDir
    },
    window: {
      sinceMin: parsed.sinceMin,
      sinceIso: new Date(sinceMs).toISOString(),
      nowIso: new Date(nowMs).toISOString()
    },
    stuckTurns: {
      olderThanSec: parsed.stuckOlderSec,
      count: stuckRows.length,
      rows: stuckRows
    },
    routeOutcomes: {
      rowCount: outcomeRows.length,
      fileCount: outcomeFiles.filter(f => fs.existsSync(f)).length,
      noResponseOutcomeCount,
      topOutcomes
    },
    thresholds: {
      failOnStuckOver: parsed.failOnStuckOver,
      failOnNoResponseOver: parsed.failOnNoResponseOver
    },
    status: failReasons.length ? "fail" : "ok",
    failReasons
  };

  if (parsed.outPath) {
    fs.mkdirSync(path.dirname(parsed.outPath), { recursive: true });
    fs.writeFileSync(parsed.outPath, JSON.stringify(summary, null, 2));
  }

  console.log(JSON.stringify(summary, null, 2));

  if (failReasons.length) process.exit(2);
}

main();
