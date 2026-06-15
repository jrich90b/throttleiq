/**
 * Appointment/stop-in invite A/B report (2026-06-14).
 *
 * Measures the cadence-invite experiment from the live conversation store. Because
 * `decideCadenceInviteArm` is a pure function of conversation id, the arm is
 * recomputed here per conversation — no runtime message tagging is needed. For
 * each SENT invite message (control OR challenger phrasing) we attribute a reply
 * (next customer inbound before the next outbound, within 14 days) and, when
 * present, a booked/appointment outcome, then compare the two arms.
 *
 * Usage:
 *   npx tsx scripts/cadence_ab_report.ts [--conversations PATH] [--out-dir DIR]
 * Env: CONVERSATIONS_DB_PATH or DATA_DIR (matches the other scorers).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decideCadenceInviteArm } from "../services/api/src/domain/routeStateReducer.ts";

const CUST_IN = new Set(["twilio", "web_widget", "sendgrid"]);
const SENT_OUT = new Set(["twilio", "sendgrid", "human"]);
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Appointment/stop-in invite fingerprint — matches BOTH control and challenger
// copy (the "come in / stop by / swing by + day/time" ask). Kept deliberately
// broad on the action verbs but anchored to an in-person + scheduling intent so
// it does not catch generic check-ins.
const INVITE_RE =
  /(come in|stop by|stop in|swing by|come see|come check|see it in person|in person|couple time options|time slots|hold (a )?(quick )?(time|window)|i can do .* or |i.?ve got .* or |i have .* or |set aside .* or)/i;
const SCHEDULING_RE =
  /(what day|what time|when.*available|schedule|appointment|come in|stop by|stop in|book|reserve|test ride|demo ride|which works best|what day.?s good)/i;

function isInviteMessage(body: string): boolean {
  const b = norm(body);
  if (!b) return false;
  return INVITE_RE.test(b) && SCHEDULING_RE.test(b);
}

function convBooked(conv: any): boolean {
  if (conv?.appointment?.bookedEventId) return true;
  const outcome = norm(conv?.appointmentOutcome?.status ?? conv?.appointment?.status);
  if (/show|booked|scheduled|confirmed|sold/.test(outcome)) return true;
  return false;
}

// Two-proportion z-test (one number, no libs).
function zTest(r1: number, n1: number, r2: number, n2: number): number {
  if (!n1 || !n2) return 0;
  const p1 = r1 / n1;
  const p2 = r2 / n2;
  const p = (r1 + r2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 0;
  return Math.round(((p1 - p2) / se) * 100) / 100;
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
  const outDir =
    args.get("--out-dir") ||
    process.env.CADENCE_AB_OUT_DIR ||
    path.resolve(process.cwd(), "reports", "cadence_ab");

  if (!fs.existsSync(conversationsPath)) {
    console.error(`Conversations file not found: ${conversationsPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];

  const arms: Record<string, { invitesSent: number; replied: number; convsWithInvite: Set<string>; bookedConvs: Set<string> }> = {
    control: { invitesSent: 0, replied: 0, convsWithInvite: new Set(), bookedConvs: new Set() },
    challenger: { invitesSent: 0, replied: 0, convsWithInvite: new Set(), bookedConvs: new Set() }
  };

  for (const conv of convs) {
    const arm = decideCadenceInviteArm(String(conv?.id ?? ""));
    const bucket = arms[arm];
    const msgs = (conv?.messages ?? [])
      .map((m: any) => ({ ...m, t: Date.parse(String(m?.at ?? "")) }))
      .filter((m: any) => Number.isFinite(m.t))
      .sort((a: any, b: any) => a.t - b.t);

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== "out" || !SENT_OUT.has(m.provider)) continue;
      if (!isInviteMessage(m.body)) continue;
      bucket.invitesSent++;
      bucket.convsWithInvite.add(String(conv?.id ?? ""));
      let replied = false;
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n.t - m.t > WINDOW_MS) break;
        if (n.direction === "in" && CUST_IN.has(n.provider) && String(n.body ?? "").trim()) {
          replied = true;
          break;
        }
        if (n.direction === "out" && SENT_OUT.has(n.provider)) break;
      }
      if (replied) bucket.replied++;
      if (convBooked(conv)) bucket.bookedConvs.add(String(conv?.id ?? ""));
    }
  }

  const pct = (r: number, n: number) => (n ? Math.round((r / n) * 1000) / 10 : 0);
  const summarize = (k: "control" | "challenger") => {
    const a = arms[k];
    const convN = a.convsWithInvite.size;
    return {
      arm: k,
      invitesSent: a.invitesSent,
      replied: a.replied,
      replyRatePct: pct(a.replied, a.invitesSent),
      convsWithInvite: convN,
      bookedConvs: a.bookedConvs.size,
      bookedRatePct: pct(a.bookedConvs.size, convN)
    };
  };
  const control = summarize("control");
  const challenger = summarize("challenger");
  const report = {
    generatedAt: new Date().toISOString(),
    source: { conversationsPath, conversations: convs.length },
    note:
      "Arm recomputed from conv id via decideCadenceInviteArm. Reply = next customer inbound before next outbound, within 14d. Significance is a 2-proportion z (|z|>=1.96 ~ p<0.05). Low n until the experiment accrues sends.",
    control,
    challenger,
    delta: {
      replyRatePct: Math.round((challenger.replyRatePct - control.replyRatePct) * 10) / 10,
      replyZ: zTest(challenger.replied, challenger.invitesSent, control.replied, control.invitesSent),
      bookedRatePct: Math.round((challenger.bookedRatePct - control.bookedRatePct) * 10) / 10
    }
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "cadence_ab_report.json"), JSON.stringify(report, null, 2));
  const fmt = (s: typeof control) =>
    `${s.arm.padEnd(10)} invites:${String(s.invitesSent).padStart(4)}  reply:${String(s.replyRatePct).padStart(5)}%  (${s.replied}/${s.invitesSent})   booked:${s.bookedRatePct}% (${s.bookedConvs}/${s.convsWithInvite})`;
  console.log("\n=== Appointment/stop-in invite A/B ===");
  console.log(fmt(control));
  console.log(fmt(challenger));
  console.log(
    `delta reply: ${report.delta.replyRatePct >= 0 ? "+" : ""}${report.delta.replyRatePct}pp  (z=${report.delta.replyZ}, |z|>=1.96 ~ significant)`
  );
  console.log(`report: ${path.join(outDir, "cadence_ab_report.json")}\n`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
