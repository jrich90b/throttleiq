/**
 * Voice Charter audit — nightly enforcement of the "Agent Voice Charter"
 * section in AGENTS.md (Joe, 2026-06-11).
 *
 * Scans recent outbound messages (sent + drafts) for charter violations and
 * writes reports/voice_charter/voice_charter_{summary,violations}.json + .md
 * for the agent manager report to aggregate.
 *
 * Usage:
 *   npx tsx scripts/voice_charter_audit.ts [--since-hours N] [--out-dir DIR]
 *   npx tsx scripts/voice_charter_audit.ts --self-test
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isCampaignBroadcastSend, isShadowReplayMessage } from "../services/api/src/domain/scoringExclusions.ts";

type Violation = {
  check: string;
  convId: string;
  at: string;
  provider: string;
  draft: boolean;
  detail: string;
  body: string;
};

// Keep in sync with the "Agent Voice Charter" banned-filler list in AGENTS.md.
const BANNED_PHRASES = [
  "if helpful",
  "if it helps",
  "simple compare",
  "next-step options",
  "next step options",
  "quick walkaround",
  "payment snapshot",
  "narrow it down",
  "keep it dialed in",
  "i'm here if you need anything",
  "all good either way"
];

const CHECKIN_VALUE_RE =
  /\d|photo|pic|video|incentive|offer|price|quote|arrived|came in|just got|in stock|test ride|appraisal|what day|set a time|stop in|come in|trade|(?:we|i)\s+(?:spoke|talked|chatted|discussed|met)|spoke about|talked about|chatted about|last (?:time|week|we)|when we (?:spoke|talked|met)/i;

const SENT_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);
const SMS_PROVIDERS = new Set(["twilio", "draft_ai"]);

function norm(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function checkMessage(body: string, opts: {
  firstOutbound: boolean;
  smsLike: boolean;
  staffHasSent: boolean;
}): { check: string; detail: string }[] {
  const out: { check: string; detail: string }[] = [];
  const text = String(body ?? "");
  const lower = norm(text);
  if (!lower) return out;

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) out.push({ check: "banned_phrase", detail: phrase });
  }
  if (lower.includes("just checking in") && !CHECKIN_VALUE_RE.test(text)) {
    out.push({ check: "bare_check_in", detail: "just checking in with no concrete reason" });
  }
  const emdashes = (text.match(/—/g) ?? []).length;
  if (emdashes > 1) {
    out.push({ check: "em_dash_overuse", detail: `${emdashes} em-dashes (charter max 1)` });
  }
  if (lower.includes("the the")) {
    out.push({ check: "doubled_article", detail: "contains 'the the'" });
  }
  // A modal/auxiliary must be followed by a bare verb, never a bare determiner.
  // "I can a couple time options" (the verb dropped at runtime) is always broken.
  if (/\b(?:i|we|you|they)\s+(?:can|could|will|would|can't|cannot|won't)\s+(?:a|an|the|some|any|two|your|my)\b/i.test(text)) {
    out.push({ check: "dropped_verb", detail: "modal verb followed by a determiner (verb dropped)" });
  }
  const fullName = text.match(/^(?:[Hh]ey|[Hh]i|[Hh]ello)\s+([A-Z][a-z']+)\s+([A-Z][a-z']+)\s*[,—–-]/);
  if (fullName && !["Harley", "Davidson"].includes(fullName[2])) {
    out.push({ check: "full_name_greeting", detail: `${fullName[1]} ${fullName[2]}` });
  }
  if (
    opts.smsLike &&
    !opts.firstOutbound &&
    lower.includes("american harley-davidson") &&
    !/this is [a-z]+ (at|from|with)/.test(lower)
  ) {
    out.push({ check: "long_brand_repeat", detail: "full brand name outside first-touch intro" });
  }
  if (opts.staffHasSent && /this is alexandra/.test(lower)) {
    out.push({ check: "persona_reintro", detail: "Alexandra reintroduced after staff took over" });
  }
  return out;
}

function selfTest() {
  const assert = (cond: boolean, label: string) => {
    if (!cond) {
      console.error(`SELF-TEST FAIL: ${label}`);
      process.exit(1);
    }
  };
  const base = { firstOutbound: false, smsLike: true, staffHasSent: false };

  assert(
    checkMessage("If helpful, I can send a quick price and payment snapshot.", base)
      .filter(v => v.check === "banned_phrase").length >= 2,
    "banned phrases detected"
  );
  assert(
    checkMessage("Hey Mustafa, just checking in. Let me know what you're thinking.", base)
      .some(v => v.check === "bare_check_in"),
    "bare check-in detected"
  );
  assert(
    checkMessage("Just checking in — that 2021 Ultra Limited you liked dropped to $20,995.", base)
      .every(v => v.check !== "bare_check_in"),
    "check-in with concrete value passes"
  );
  assert(
    checkMessage(
      "Hey Peter, we spoke on Saturday about the Forty-Eight. Just checking in, let me know if you have any questions or concerns.",
      base
    ).every(v => v.check !== "bare_check_in"),
    "check-in that recalls a prior conversation about a named bike passes"
  );
  assert(
    checkMessage("Hey — got it — sending now — talk soon.", base)
      .some(v => v.check === "em_dash_overuse"),
    "em-dash overuse detected"
  );
  assert(
    checkMessage("Just checking back on the the Nightster. 100 in stock.", base)
      .some(v => v.check === "doubled_article"),
    "doubled article detected"
  );
  assert(
    checkMessage("If you want to come in, I can a couple time options.", base)
      .some(v => v.check === "dropped_verb"),
    "dropped verb after modal detected"
  );
  assert(
    checkMessage("If you want to come in, I can send a couple time options.", base)
      .every(v => v.check !== "dropped_verb"),
    "grammatical modal phrase passes (verb present)"
  );
  assert(
    checkMessage("If helpful, I can send a quick price and payment snapshot.", base)
      .every(v => v.check !== "dropped_verb"),
    "modal followed by a verb does not trip the dropped-verb check"
  );
  assert(
    checkMessage("No rush, Glenn. When you're ready, text me.", base)
      .every(v => v.check !== "full_name_greeting"),
    "first-name-only greeting passes"
  );
  assert(
    checkMessage("Hey Glenn Wakefield, want to set a time?", base)
      .some(v => v.check === "full_name_greeting"),
    "full-name greeting detected"
  );
  assert(
    checkMessage("We can get that done at American Harley-Davidson anytime.", base)
      .some(v => v.check === "long_brand_repeat"),
    "long brand repeat detected"
  );
  assert(
    checkMessage("Hi Sam — this is Alexandra at American Harley-Davidson. Thanks for reaching out.", {
      firstOutbound: true,
      smsLike: true,
      staffHasSent: false
    }).length === 0,
    "first-touch intro passes clean"
  );
  assert(
    checkMessage("Hi again, this is Alexandra at American H-D.", { ...base, staffHasSent: true })
      .some(v => v.check === "persona_reintro"),
    "persona reintro detected"
  );
  assert(
    checkMessage(
      "Gotcha, ya no problem. I can keep my eyes open for a pre owned Breakout, ill text you if one comes in!",
      base
    ).length === 0,
    "staff-style message passes clean"
  );
  console.log("PASS voice charter audit self-test");
}

function main() {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--self-test") {
      selfTest();
      return;
    }
    if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  }

  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const sinceHours = Number(args.get("--since-hours") || process.env.VOICE_CHARTER_SINCE_HOURS || "24");
  const outDir =
    args.get("--out-dir") ||
    process.env.VOICE_CHARTER_OUT_DIR ||
    path.resolve(process.cwd(), "reports", "voice_charter");

  if (!fs.existsSync(conversationsPath)) {
    console.error(`Conversations file not found: ${conversationsPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
  const windowStart = Date.now() - sinceHours * 60 * 60 * 1000;

  const violations: Violation[] = [];
  let outboundCount = 0;
  let repeatCount = 0;

  for (const conv of convs) {
    const msgs: any[] = Array.isArray(conv?.messages) ? conv.messages : [];
    let staffHasSent = false;
    let sawOutbound = false;
    const sentNorms = new Map<string, string>();
    const campaignThread = (conv as any)?.campaignThread;
    for (const m of msgs) {
      if (m?.direction !== "out") continue;
      if (isShadowReplayMessage(m)) continue;
      // A staff-composed Campaign Studio blast is not the agent's conversational
      // voice — leading with the full dealer brand is correct for a marketing
      // send, so it must not count against the Agent Voice Charter (report-only
      // exclusion; see scoringExclusions.isCampaignBroadcastSend).
      if (isCampaignBroadcastSend(m, campaignThread)) continue;
      const provider = String(m?.provider ?? "");
      const body = String(m?.body ?? "");
      const isDraft = provider === "draft_ai";
      const isSent = SENT_PROVIDERS.has(provider);
      if (!isDraft && !isSent) continue;
      const firstOutbound = !sawOutbound;
      sawOutbound = true;
      const atMs = Date.parse(String(m?.at ?? ""));
      const inWindow = Number.isFinite(atMs) && atMs >= windowStart;

      if (isSent && body.trim().length >= 40) {
        const nb = norm(body);
        if (sentNorms.has(nb)) {
          if (inWindow) {
            repeatCount++;
            violations.push({
              check: "verbatim_repeat",
              convId: String(conv?.id ?? ""),
              at: String(m?.at ?? ""),
              provider,
              draft: false,
              detail: `same message previously sent at ${sentNorms.get(nb)}`,
              body: body.slice(0, 200)
            });
          }
        } else {
          sentNorms.set(nb, String(m?.at ?? ""));
        }
      }

      if (inWindow && body.trim()) {
        outboundCount++;
        const found = checkMessage(body, {
          firstOutbound,
          smsLike: SMS_PROVIDERS.has(provider),
          staffHasSent
        });
        for (const v of found) {
          violations.push({
            check: v.check,
            convId: String(conv?.id ?? ""),
            at: String(m?.at ?? ""),
            provider,
            draft: isDraft && m?.draftStatus !== undefined,
            detail: v.detail,
            body: body.slice(0, 200)
          });
        }
      }
      if (isSent && String(m?.actorUserName ?? "").trim()) staffHasSent = true;
    }
  }

  const byCheck = new Map<string, number>();
  for (const v of violations) byCheck.set(v.check, (byCheck.get(v.check) ?? 0) + 1);
  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: { conversationsPath, sinceHours, windowStart: new Date(windowStart).toISOString() },
    summary: {
      outboundCount,
      violationCount: violations.length,
      violationRate: outboundCount ? Math.round((violations.length / outboundCount) * 1000) / 10 : 0,
      repeatCount,
      byCheck: [...byCheck.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([check, count]) => ({ check, count }))
    }
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "voice_charter_summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "voice_charter_violations.json"),
    JSON.stringify({ ...summary, violations }, null, 2)
  );
  const md = [
    "# Voice Charter Audit",
    "",
    `Generated: ${summary.generatedAt}`,
    `Window: last ${sinceHours}h | Outbound checked: ${outboundCount}`,
    `Violations: ${violations.length}`,
    "",
    ...summary.summary.byCheck.map(c => `- ${c.check}: ${c.count}`),
    "",
    "## Samples",
    ...violations.slice(0, 12).map(v => `- [${v.check}] ${v.convId} ${v.at}: ${v.detail} | "${v.body.slice(0, 110)}"`)
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "voice_charter_report.md"), md + "\n");

  console.log(
    `voice charter audit: ${violations.length} violation(s) across ${outboundCount} outbound message(s); report at ${outDir}`
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
