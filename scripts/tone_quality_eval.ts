import fs from "node:fs";
import path from "node:path";
import { evaluateTurnToneQuality, normalizeText } from "./lib/toneQuality.ts";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  conversationsPath: string;
  outDir: string;
  sinceHours: number;
  responseWindowMin: number;
};

type EvalRow = {
  convId: string;
  leadRef: string | null;
  leadName: string | null;
  leadPhone: string | null;
  inboundAt: string;
  inboundProvider: string;
  inboundText: string;
  outboundAt: string | null;
  outboundProvider: string | null;
  outboundText: string | null;
  responseLatencySec: number | null;
  score: number;
  pass: boolean;
  band: "excellent" | "good" | "needs_work" | "poor";
  intent: string;
  issueCodes: string[];
  issueDetails: Array<{ code: string; detail: string }>;
  status: "responded" | "missing_response";
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
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    path.resolve(cwd, "data", "conversations.json");
  const outDir =
    args.get("--out-dir") ||
    process.env.TONE_QUALITY_OUT_DIR ||
    path.resolve(cwd, "reports", "tone_quality");
  const sinceHoursRaw = Number(args.get("--since-hours") || process.env.TONE_QUALITY_SINCE_HOURS || "24");
  const responseWindowMinRaw = Number(
    args.get("--response-window-min") || process.env.TONE_QUALITY_RESPONSE_WINDOW_MIN || "30"
  );

  return {
    conversationsPath,
    outDir,
    sinceHours: Number.isFinite(sinceHoursRaw) && sinceHoursRaw >= 0 ? sinceHoursRaw : 24,
    responseWindowMin: Number.isFinite(responseWindowMinRaw) && responseWindowMinRaw > 0 ? responseWindowMinRaw : 30
  };
}

function toMessages(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  return [];
}

function toMs(iso: string): number {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function computeMedian(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.conversationsPath)) {
    console.error(`Conversations file not found: ${parsed.conversationsPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(parsed.conversationsPath, "utf8"));
  const conversations = toMessages(raw);
  const windowStartMs =
    parsed.sinceHours > 0 ? Date.now() - parsed.sinceHours * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  const windowEndMs = Number.POSITIVE_INFINITY;

  const rows: EvalRow[] = [];
  for (const conv of conversations) {
    const convId = String(conv?.id ?? conv?.leadKey ?? "");
    if (!convId) continue;
    const leadRef = conv?.lead?.leadRef ? String(conv.lead.leadRef) : null;
    const leadName = [conv?.lead?.firstName, conv?.lead?.lastName].filter(Boolean).join(" ") || null;
    const leadPhone = conv?.lead?.phone ? String(conv.lead.phone) : null;
    const messages = Array.isArray(conv?.messages) ? [...conv.messages] : [];
    messages.sort((a, b) => toMs(String(a?.at ?? "")) - toMs(String(b?.at ?? "")));

    for (let i = 0; i < messages.length; i += 1) {
      const inbound = messages[i];
      if (inbound?.direction !== "in") continue;
      const inboundAtIso = String(inbound?.at ?? "");
      const inboundAtMs = toMs(inboundAtIso);
      if (!Number.isFinite(inboundAtMs)) continue;
      if (inboundAtMs < windowStartMs || inboundAtMs > windowEndMs) continue;

      const inboundText = normalizeText(inbound?.body);
      if (!inboundText) continue;

      const maxOutMs = inboundAtMs + parsed.responseWindowMin * 60 * 1000;
      let matchedOut: any | null = null;
      for (let j = i + 1; j < messages.length; j += 1) {
        const out = messages[j];
        const outAtMs = toMs(String(out?.at ?? ""));
        if (!Number.isFinite(outAtMs)) continue;
        if (outAtMs > maxOutMs) break;
        if (out?.direction !== "out") continue;
        const outText = normalizeText(out?.body);
        if (!outText) continue;
        matchedOut = out;
        break;
      }

      if (!matchedOut) {
        rows.push({
          convId,
          leadRef,
          leadName,
          leadPhone,
          inboundAt: inboundAtIso,
          inboundProvider: String(inbound?.provider ?? ""),
          inboundText,
          outboundAt: null,
          outboundProvider: null,
          outboundText: null,
          responseLatencySec: null,
          score: 0,
          pass: false,
          band: "poor",
          intent: "general",
          issueCodes: ["missing_response"],
          issueDetails: [{ code: "missing_response", detail: "no outbound reply in configured response window" }],
          status: "missing_response"
        });
        continue;
      }

      const outboundText = normalizeText(matchedOut?.body);
      const tone = evaluateTurnToneQuality({ inboundText, outboundText });
      const outAtIso = String(matchedOut?.at ?? "");
      const outAtMs = toMs(outAtIso);
      const latency = Number.isFinite(outAtMs) ? Math.max(0, Math.round((outAtMs - inboundAtMs) / 1000)) : null;

      rows.push({
        convId,
        leadRef,
        leadName,
        leadPhone,
        inboundAt: inboundAtIso,
        inboundProvider: String(inbound?.provider ?? ""),
        inboundText,
        outboundAt: outAtIso,
        outboundProvider: String(matchedOut?.provider ?? ""),
        outboundText,
        responseLatencySec: latency,
        score: tone.score,
        pass: tone.pass,
        band: tone.band,
        intent: tone.intent,
        issueCodes: tone.issues.map(x => x.code),
        issueDetails: tone.issues.map(x => ({ code: x.code, detail: x.detail })),
        status: "responded"
      });
    }
  }

  const responded = rows.filter(r => r.status === "responded");
  const missing = rows.filter(r => r.status === "missing_response");
  const passCount = responded.filter(r => r.pass).length;
  const failCount = responded.length - passCount;
  const scores = responded.map(r => r.score);
  const avgScore = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;
  const medianScore = Number(computeMedian(scores).toFixed(2));

  const issueMap = new Map<string, number>();
  for (const r of rows) {
    for (const code of r.issueCodes) issueMap.set(code, (issueMap.get(code) ?? 0) + 1);
  }
  const issueCounts = [...issueMap.entries()]
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count);

  const intentMap = new Map<
    string,
    { count: number; pass: number; totalScore: number; missing: number }
  >();
  for (const r of rows) {
    const cur = intentMap.get(r.intent) ?? { count: 0, pass: 0, totalScore: 0, missing: 0 };
    cur.count += 1;
    cur.totalScore += r.score;
    if (r.status === "missing_response") cur.missing += 1;
    if (r.pass) cur.pass += 1;
    intentMap.set(r.intent, cur);
  }
  const intentStats = [...intentMap.entries()]
    .map(([intent, v]) => ({
      intent,
      count: v.count,
      pass: v.pass,
      missing: v.missing,
      avgScore: Number((v.totalScore / Math.max(1, v.count)).toFixed(2))
    }))
    .sort((a, b) => b.count - a.count);

  const providerMap = new Map<string, number>();
  for (const r of responded) {
    const key = r.outboundProvider || "unknown";
    providerMap.set(key, (providerMap.get(key) ?? 0) + 1);
  }
  const providerStats = [...providerMap.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count);

  const bandMap = new Map<string, number>();
  for (const r of responded) bandMap.set(r.band, (bandMap.get(r.band) ?? 0) + 1);
  const bandCounts = [...bandMap.entries()]
    .map(([band, count]) => ({ band, count }))
    .sort((a, b) => b.count - a.count);

  const failures = rows
    .filter(r => !r.pass)
    .sort((a, b) => a.score - b.score || String(a.inboundAt).localeCompare(String(b.inboundAt)));

  fs.mkdirSync(parsed.outDir, { recursive: true });
  const rowsPath = path.join(parsed.outDir, "tone_quality_rows.json");
  const failuresPath = path.join(parsed.outDir, "tone_quality_failures.json");
  const summaryPath = path.join(parsed.outDir, "tone_quality_summary.json");

  fs.writeFileSync(rowsPath, JSON.stringify({ count: rows.length, rows }, null, 2));
  fs.writeFileSync(failuresPath, JSON.stringify({ count: failures.length, rows: failures }, null, 2));

  const summary = {
    generatedAt: new Date().toISOString(),
    source: parsed.conversationsPath,
    sinceHours: parsed.sinceHours,
    windowStart: Number.isFinite(windowStartMs) ? new Date(windowStartMs).toISOString() : null,
    responseWindowMin: parsed.responseWindowMin,
    totalInboundTurns: rows.length,
    respondedTurns: responded.length,
    missingResponseCount: missing.length,
    passCount,
    failCount,
    passRate: responded.length ? Number(((passCount / responded.length) * 100).toFixed(2)) : 0,
    avgScore,
    medianScore,
    issueCounts,
    bandCounts,
    intentStats,
    providerStats,
    outputs: {
      rowsPath,
      failuresPath,
      summaryPath
    }
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();

