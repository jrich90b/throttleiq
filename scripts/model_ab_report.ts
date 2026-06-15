/**
 * Draft-model A/B report (2026-06-15): gpt-5 (challenger) vs gpt-5-mini (control)
 * on the customer-facing reply draft.
 *
 * The arm is a pure function of the lead, so it's recomputed here per conversation
 * — no message tagging. The model only changes drafts going FORWARD, so pass
 * --since <experiment-launch ISO>: only outbound replies sent at/after that moment
 * are counted (earlier replies were all control-model regardless of arm and would
 * dilute the comparison).
 *
 * Usage:
 *   npx tsx scripts/model_ab_report.ts --since 2026-06-15T15:16:00Z [--conversations PATH]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decideDraftModelArm } from "../services/api/src/domain/routeStateReducer.ts";

const CUST_IN = new Set(["twilio", "web_widget", "sendgrid"]);
const SENT_OUT = new Set(["twilio", "sendgrid", "human"]);
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const ARM_MODEL: Record<string, string> = { control: "gpt-5-mini", challenger: "gpt-5" };

function convBooked(conv: any): boolean {
  if (conv?.appointment?.bookedEventId) return true;
  const outcome = norm(conv?.appointmentOutcome?.status ?? conv?.appointment?.status);
  return /show|booked|scheduled|confirmed|sold/.test(outcome);
}

function zTest(r1: number, n1: number, r2: number, n2: number): number {
  if (!n1 || !n2) return 0;
  const p1 = r1 / n1, p2 = r2 / n2, p = (r1 + r2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? Math.round(((p1 - p2) / se) * 100) / 100 : 0;
}

function main() {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");

  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const sinceIso = args.get("--since") || process.env.MODEL_AB_SINCE || "";
  const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
  const outDir = args.get("--out-dir") || process.env.MODEL_AB_OUT_DIR || path.resolve(process.cwd(), "reports", "model_ab");

  if (!fs.existsSync(conversationsPath)) {
    console.error(`Conversations file not found: ${conversationsPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];

  const arms: Record<string, { sentReplies: number; replied: number; convs: Set<string>; booked: Set<string> }> = {
    control: { sentReplies: 0, replied: 0, convs: new Set(), booked: new Set() },
    challenger: { sentReplies: 0, replied: 0, convs: new Set(), booked: new Set() }
  };

  for (const conv of convs) {
    const arm = decideDraftModelArm(String(conv?.leadKey ?? ""));
    const bucket = arms[arm];
    const msgs = (conv?.messages ?? [])
      .map((m: any) => ({ ...m, t: Date.parse(String(m?.at ?? "")) }))
      .filter((m: any) => Number.isFinite(m.t))
      .sort((a: any, b: any) => a.t - b.t);

    let countedConv = false;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== "out" || !SENT_OUT.has(m.provider)) continue;
      if (!String(m.body ?? "").trim()) continue;
      if (sinceMs && m.t < sinceMs) continue; // only post-launch sends
      bucket.sentReplies++;
      if (!countedConv) {
        bucket.convs.add(String(conv?.id ?? ""));
        if (convBooked(conv)) bucket.booked.add(String(conv?.id ?? ""));
        countedConv = true;
      }
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n.t - m.t > WINDOW_MS) break;
        if (n.direction === "in" && CUST_IN.has(n.provider) && String(n.body ?? "").trim()) { bucket.replied++; break; }
        if (n.direction === "out" && SENT_OUT.has(n.provider)) break;
      }
    }
  }

  const pct = (r: number, n: number) => (n ? Math.round((r / n) * 1000) / 10 : 0);
  const row = (k: "control" | "challenger") => {
    const a = arms[k];
    return {
      arm: k,
      model: ARM_MODEL[k],
      sentReplies: a.sentReplies,
      replyRatePct: pct(a.replied, a.sentReplies),
      convs: a.convs.size,
      bookedRatePct: pct(a.booked.size, a.convs.size)
    };
  };
  const control = row("control"), challenger = row("challenger");
  const report = {
    generatedAt: new Date().toISOString(),
    source: { conversationsPath, since: sinceIso || "(none — includes pre-launch control-model sends; pass --since)" },
    control,
    challenger,
    delta: {
      replyRatePct: Math.round((challenger.replyRatePct - control.replyRatePct) * 10) / 10,
      replyZ: zTest(arms.challenger.replied, arms.challenger.sentReplies, arms.control.replied, arms.control.sentReplies),
      bookedRatePct: Math.round((challenger.bookedRatePct - control.bookedRatePct) * 10) / 10
    }
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "model_ab_report.json"), JSON.stringify(report, null, 2));
  const fmt = (s: typeof control) =>
    `${s.arm.padEnd(10)} (${s.model.padEnd(10)}) replies:${String(s.sentReplies).padStart(4)}  replyRate:${String(s.replyRatePct).padStart(5)}%  booked:${s.bookedRatePct}% (${s.convs} convs)`;
  console.log("\n=== Draft-model A/B (gpt-5 vs gpt-5-mini) ===");
  if (!sinceMs) console.log("WARNING: no --since cutoff; pre-launch sends were all control-model regardless of arm and dilute this. Pass --since <launch ISO>.");
  console.log(fmt(control));
  console.log(fmt(challenger));
  console.log(`delta reply: ${report.delta.replyRatePct >= 0 ? "+" : ""}${report.delta.replyRatePct}pp (z=${report.delta.replyZ}, |z|>=1.96 ~ significant) | booked: ${report.delta.bookedRatePct >= 0 ? "+" : ""}${report.delta.bookedRatePct}pp`);
  console.log(`report: ${path.join(outDir, "model_ab_report.json")}\n`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
