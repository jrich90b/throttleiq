/**
 * already_shipped_guard — "was this already shipped?" check for the morning routine.
 *
 * WHY (2026-07-09): two morning-digest false alarms in one run. The appointment
 * "I'll check that time and follow up" punts were already fixed by #170 (deployed
 * 7/8 6:01pm), and Ryan Tower's on-hold Street Glide non-disclosure was already
 * fixed by #161 (Ryan is literally that PR's named fixture). Both re-fired in
 * next.json because the operator-reported / open-critic / replay detectors judge
 * the STORED transcript — the pre-fix reply still sits in the record, so the
 * finding re-fires every night even though the code that produced it is gone
 * ([[open-critic-replay-staleness-gap]]).
 *
 * The existing act_runner check-open-pr dedup only catches items whose
 * convId::dimension matches an open/merged loop finding-key. Direct-to-main
 * numbered PRs (#161, #170) that NAMED a reproduced case but left no matching
 * finding-key slip past it. This guard closes that gap with a deploy-time +
 * named-case check: it is a COMPLEMENT to check-open-pr, not a replacement.
 *
 * Read-only. No customer impact, no mutation. Core classifier is a pure function
 * (classifyEcho) pinned by --self-test; the IO wrapper reads the conversation,
 * greps origin/main commit messages for the case, and prints a verdict.
 *
 * Usage (per next.json item, from a repo checkout that has the conversations store):
 *   CONVERSATIONS_DB_PATH=/path/conversations.json \
 *     npx tsx scripts/already_shipped_guard.ts \
 *       --conv +15857278545 [--name "Ryan Tower"] [--deploy-ts 2026-07-08T22:01:04Z] [--at <iso>]
 *
 *   # Fetch the live deploy time once (routine does this) and pass it in:
 *   #   DEPLOY_TS=$(ssh lightsail 'pm2 jlist' | ... throttleiq-api pm_uptime -> ISO)
 *
 *   npx tsx scripts/already_shipped_guard.ts --self-test   # deterministic, no IO, for ci:eval
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

export type FixCommit = { hash: string; subject: string; dateMs: number };
export type EchoVerdict = "stale_echo" | "live" | "review";
export type EchoResult = { verdict: EchoVerdict; reason: string; namingCommit?: FixCommit };

export type EchoInput = {
  /** epoch ms of the flagged outbound reply the detector graded */
  flaggedAtMs: number;
  /** epoch ms the currently-running code went live (pm2 uptime of the API); NaN if unknown */
  deployTsMs: number;
  /** draftStatus of the flagged reply ("stale" = superseded/dismissed, never reached the customer) */
  draftStatus: string;
  /** origin/main commits whose message NAMES this case (phone / customer / ticket), any date */
  fixCommits: FixCommit[];
};

/**
 * Pure verdict. A finding is a STALE ECHO (already shipped — no action) when the
 * flagged reply predates a fix, established either by:
 *   (a) a commit that NAMES the case and lands AFTER the flagged reply, or
 *   (b) the flagged reply predating the live deploy AND being a superseded stale
 *       draft OR having ≥1 commit naming the case.
 * It is LIVE (a real miss) when the flagged reply is at/after the live deploy.
 * Otherwise REVIEW (predates deploy, no naming fix — verify by hand).
 */
export function classifyEcho(input: EchoInput): EchoResult {
  const { flaggedAtMs, deployTsMs, draftStatus, fixCommits } = input;
  const isStaleDraft = String(draftStatus ?? "") === "stale";

  // (a) a fix commit that postdates the flagged reply and names the case.
  const namingCommit = [...fixCommits]
    .filter(c => Number.isFinite(c.dateMs) && c.dateMs > flaggedAtMs)
    .sort((a, b) => a.dateMs - b.dateMs)[0];
  if (namingCommit) {
    return {
      verdict: "stale_echo",
      reason: `fixed by ${namingCommit.hash} "${namingCommit.subject}" (${new Date(namingCommit.dateMs).toISOString()}) — the flagged reply predates that commit`,
      namingCommit
    };
  }

  // (b) predates the live deploy + a corroborating signal (stale draft or a named commit).
  if (Number.isFinite(deployTsMs) && flaggedAtMs < deployTsMs) {
    if (isStaleDraft || fixCommits.length > 0) {
      const bits = [
        `flagged reply predates the live deploy (${new Date(deployTsMs).toISOString()})`,
        isStaleDraft ? "and is a superseded stale draft (never reached the customer)" : "",
        fixCommits.length ? `and ${fixCommits.length} commit(s) name this case` : ""
      ].filter(Boolean);
      return { verdict: "stale_echo", reason: bits.join(" ") };
    }
    return {
      verdict: "review",
      reason: `predates the live deploy (${new Date(deployTsMs).toISOString()}) but no naming fix commit and not a stale draft — verify by hand before surfacing`
    };
  }

  // At/after the live deploy (or deploy time unknown and no fix): treat as a real live miss.
  if (!Number.isFinite(deployTsMs)) {
    return {
      verdict: "review",
      reason: `deploy time unknown and no naming fix commit — verify by hand`
    };
  }
  return {
    verdict: "live",
    reason: `flagged reply is at/after the live deploy (${new Date(deployTsMs).toISOString()}) — treat as a real live miss`
  };
}

const OUT = (m: any) =>
  m?.direction === "out" &&
  ["draft_ai", "twilio", "sendgrid", "human"].includes(String(m?.provider ?? "")) &&
  String(m?.text ?? m?.body ?? "").trim();

function digits(s: string): string {
  return String(s ?? "").replace(/\D/g, "").slice(-10);
}

/** Find the flagged conversation by phone/convId; return its latest flagged outbound at/before `atIso`. */
function loadFlaggedReply(conversationsPath: string, conv: string, atIso: string) {
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const want = digits(conv);
  const c = conversations.find(x => digits(String(x?.id ?? x?.leadKey ?? "")) === want);
  if (!c) return null;
  const atMs = atIso ? Date.parse(atIso) : Number.POSITIVE_INFINITY;
  const msgs: any[] = Array.isArray(c?.messages) ? c.messages : [];
  let chosen: any = null;
  for (const m of msgs) {
    if (!OUT(m)) continue;
    const t = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(t) || t > atMs) continue;
    if (!chosen || t >= Date.parse(String(chosen.at))) chosen = m;
  }
  const name = [c?.lead?.firstName, c?.lead?.lastName].filter(Boolean).join(" ").trim();
  return chosen ? { at: String(chosen.at), draftStatus: String(chosen.draftStatus ?? ""), body: String(chosen.text ?? chosen.body ?? ""), name } : { at: "", draftStatus: "", body: "", name };
}

/** origin/main commits (last 90d) whose subject mentions the phone digits or the customer name. */
function findNamingCommits(conv: string, name: string): FixCommit[] {
  const terms = [digits(conv), (name || "").trim()].filter(t => t && t.length >= 4);
  if (!terms.length) return [];
  const out: FixCommit[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    let raw = "";
    try {
      raw = execFileSync(
        "git",
        ["log", "origin/main", "--since=90.days", "-i", `--grep=${term}`, "--format=%H\t%ct\t%s"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      continue; // no repo / no match
    }
    for (const line of raw.split("\n")) {
      const [hash, ct, ...rest] = line.split("\t");
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      out.push({ hash: hash.slice(0, 8), subject: rest.join("\t"), dateMs: Number(ct) * 1000 });
    }
  }
  return out;
}

function selfTest(): void {
  const DEPLOY = Date.parse("2026-07-08T22:01:04Z"); // #170/#172 went live
  // Ryan Tower — #161 named him and landed 7/7, after his 7/4 stale draft.
  const ryan = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-04T23:39:06Z"),
    deployTsMs: DEPLOY,
    draftStatus: "stale",
    fixCommits: [{ hash: "526da8b6", subject: "Reply-path hold/sold disclosure (LEA-238) (#161)", dateMs: Date.parse("2026-07-07T11:26:30Z") }]
  });
  assert.equal(ryan.verdict, "stale_echo", "Ryan Tower hold-disclosure: fix commit postdates the flagged reply -> stale echo");
  assert.ok(ryan.namingCommit?.hash === "526da8b6", "stale echo cites the naming commit");

  // Mark Kocsis — punt draft predates the deploy and is a superseded stale draft, no naming commit.
  const kocsis = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-08T15:46:00Z"),
    deployTsMs: DEPLOY,
    draftStatus: "stale",
    fixCommits: []
  });
  assert.equal(kocsis.verdict, "stale_echo", "pre-deploy superseded stale draft -> stale echo");

  // A genuinely live miss: flagged AFTER the deploy, no fix.
  const live = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-09T03:00:00Z"),
    deployTsMs: DEPLOY,
    draftStatus: "",
    fixCommits: []
  });
  assert.equal(live.verdict, "live", "post-deploy reply with no fix -> live miss");

  // Ambiguous: predates deploy, NOT stale, no naming commit -> review by hand (don't auto-suppress).
  const review = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-08T12:00:00Z"),
    deployTsMs: DEPLOY,
    draftStatus: "",
    fixCommits: []
  });
  assert.equal(review.verdict, "review", "pre-deploy live (non-stale) reply with no fix -> review, not auto-suppressed");

  // A live reply that a LATER commit names is still a stale echo (fix shipped after the miss).
  const laterFix = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-09T03:00:00Z"),
    deployTsMs: DEPLOY,
    draftStatus: "",
    fixCommits: [{ hash: "abcd1234", subject: "fix that case (#900)", dateMs: Date.parse("2026-07-09T06:00:00Z") }]
  });
  assert.equal(laterFix.verdict, "stale_echo", "a commit postdating the flagged reply -> stale echo even if post-deploy");

  // Unknown deploy time + no fix -> review (never silently 'live').
  const noDeploy = classifyEcho({ flaggedAtMs: Date.parse("2026-07-09T03:00:00Z"), deployTsMs: NaN, draftStatus: "", fixCommits: [] });
  assert.equal(noDeploy.verdict, "review", "unknown deploy time + no fix -> review");

  console.log("PASS already-shipped guard self-test (stale-echo via named commit + pre-deploy stale draft; live; review fallbacks)");
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const conv = arg("--conv");
  if (!conv) {
    console.error("usage: already_shipped_guard.ts --conv <phone/convId> [--name <customer>] [--deploy-ts <iso>] [--at <iso>]");
    process.exit(2);
  }
  const name = arg("--name");
  const deployIso = arg("--deploy-ts") || process.env.DEPLOY_TS || "";
  const deployTsMs = deployIso ? Date.parse(deployIso) : NaN;
  const conversationsPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));

  const flagged = loadFlaggedReply(conversationsPath, conv, arg("--at"));
  if (!flagged || !flagged.at) {
    console.log(JSON.stringify({ conv, verdict: "review", reason: "could not locate a flagged outbound reply for this conversation — verify by hand" }, null, 2));
    return;
  }
  const resolvedName = name || flagged.name;
  const fixCommits = findNamingCommits(conv, resolvedName);
  const result = classifyEcho({ flaggedAtMs: Date.parse(flagged.at), deployTsMs, draftStatus: flagged.draftStatus, fixCommits });

  console.log(
    JSON.stringify(
      {
        conv,
        name: resolvedName || undefined,
        flaggedReplyAt: flagged.at,
        flaggedDraftStatus: flagged.draftStatus || undefined,
        deployTs: deployIso || "(unknown — pass --deploy-ts)",
        namingCommits: fixCommits.map(c => `${c.hash} ${c.subject}`),
        verdict: result.verdict,
        reason: result.reason
      },
      null,
      2
    )
  );
}

main();
