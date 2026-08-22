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

export type FixCommit = {
  hash: string;
  subject: string;
  dateMs: number;
  /**
   * `convId::dimension` keys this commit declares it fixes, parsed from the
   * `<!-- loop-finding-key: ... -->` markers act_runner writes into every PR body
   * (loopPrDedup.findingKeyMarker). Present only on loop-filed fixes; a
   * hand-authored or direct-to-main commit has none.
   */
  findingKeys?: string[];
};
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
  /**
   * Was the graded reply anchored to the one the detector flagged (`--at`)?
   * Unpinned, we grade the conversation's NEWEST outbound, which is often neither
   * the flagged reply nor even agent output — staff reply by hand in the same
   * thread, and their sends are indistinguishable from the agent's own (the
   * "Alexandra" persona sends carry no actor field either). A newest-outbound
   * that postdates the deploy then reads as a live miss when nothing regressed.
   * Defaults to pinned so a caller that supplies `flaggedAtMs` deliberately is trusted.
   */
  replyPinned?: boolean;
  /**
   * The finding's dimension (the `::dimension` half of `convId::dimension`).
   *
   * WHY (2026-08-20, measured): a naming commit proves someone fixed SOMETHING on this
   * conversation — it says nothing about WHICH defect. Threads we work on most therefore
   * became permanently immune: 3 of 4 fresh operator complaints came back `stale_echo`
   * citing an unrelated fix (Maxie Johnson's missing finance task "fixed" by #766, a draft
   * reviewer change; Zackary Busch's wrong-salesperson intro "fixed" by #764, a
   * ladder-health denominator). When a dimension IS supplied, a commit only suppresses a
   * finding if it CLAIMS that finding — via its `loop-finding-key` marker. Everything else
   * is downgraded to `review`: an extra item for a human, never a swallowed live one.
   *
   * Omit it and the guard keeps its pre-2026-08-22 conversation-only behaviour, and says so
   * in `dimensionChecked: false` — a caller that cannot name the defect gets the old,
   * weaker verdict rather than a silent change of meaning.
   */
  dimension?: string;
  /** Last-10 digits of the conversation, used to confirm a marker names THIS lead. */
  convDigits?: string;
};

/** The `convId::dimension` keys a commit message declares (act_runner's PR-body marker). */
export function parseFindingKeys(message: string): string[] {
  const out: string[] = [];
  const re = /<!--\s*loop-finding-key:\s*([^>]*?)\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(message ?? "")))) {
    const key = String(m[1] ?? "").trim();
    if (key) out.push(key);
  }
  return out;
}

/**
 * Does this commit CLAIM the finding under review — same lead AND same dimension?
 * A commit with no marker at all claims nothing (false): that is the whole point.
 */
export function commitClaimsFinding(
  commit: FixCommit,
  dimension: string,
  convDigits: string
): boolean {
  const wantDim = String(dimension ?? "").trim().toLowerCase();
  if (!wantDim) return false;
  const wantConv = String(convDigits ?? "").replace(/\D/g, "").slice(-10);
  for (const key of commit.findingKeys ?? []) {
    const idx = String(key).lastIndexOf("::");
    if (idx < 0) continue;
    const gotConv = key.slice(0, idx).replace(/\D/g, "").slice(-10);
    const gotDim = key.slice(idx + 2).trim().toLowerCase();
    if (gotDim !== wantDim) continue;
    // No digits on either side (an email/ref key) → the dimension match stands alone.
    if (wantConv && gotConv && gotConv !== wantConv) continue;
    return true;
  }
  return false;
}

/**
 * Pure verdict. A finding is a STALE ECHO (already shipped — no action) when the
 * flagged reply predates a fix, established either by:
 *   (a) a commit that CLAIMS the case and lands AFTER the flagged reply, or
 *   (b) the flagged reply predating the live deploy AND being a superseded stale
 *       draft OR having ≥1 commit claiming the case.
 * It is LIVE (a real miss) when the flagged reply is at/after the live deploy.
 * Otherwise REVIEW (predates deploy, no claiming fix — verify by hand).
 *
 * "CLAIMS" (2026-08-22): with a `dimension` supplied, a commit must declare it fixes
 * `<this lead>::<this dimension>` via its `loop-finding-key` marker. Without a dimension
 * the old, weaker rule stands: any commit naming the lead counts. See `EchoInput.dimension`
 * for the measurement that forced the distinction.
 */
export function classifyEcho(input: EchoInput): EchoResult {
  const { flaggedAtMs, deployTsMs, draftStatus, fixCommits } = input;
  const isStaleDraft = String(draftStatus ?? "") === "stale";
  const replyPinned = input.replyPinned !== false;
  const dimension = String(input.dimension ?? "").trim();
  const dimensionChecked = dimension.length > 0;
  // With a dimension in hand, only a commit that CLAIMS this finding counts as its fix.
  // Without one we cannot tell, so every naming commit counts (the pre-2026-08-22 rule).
  const corroborating = dimensionChecked
    ? fixCommits.filter(c => commitClaimsFinding(c, dimension, String(input.convDigits ?? "")))
    : fixCommits;

  // (a) a fix commit that postdates the flagged reply and claims the case.
  const byDate = (list: FixCommit[]) =>
    [...list].filter(c => Number.isFinite(c.dateMs) && c.dateMs > flaggedAtMs).sort((a, b) => a.dateMs - b.dateMs)[0];
  const namingCommit = byDate(corroborating);
  if (namingCommit) {
    return {
      verdict: "stale_echo",
      reason: `fixed by ${namingCommit.hash} "${namingCommit.subject}" (${new Date(namingCommit.dateMs).toISOString()}) — the flagged reply predates that commit${dimensionChecked ? `, and that commit declares it fixes "${dimension}" on this lead` : ""}`,
      namingCommit
    };
  }

  // A commit names the LEAD but claims a different defect (or claims nothing). It is not
  // evidence about THIS finding. It never suppresses — but it also never overrides the
  // stale-draft proof in (b), which is about the reply itself and not about any commit.
  const unrelated = dimensionChecked ? byDate(fixCommits) : undefined;
  const unrelatedNote = unrelated
    ? ` ${fixCommits.length} commit(s) name this lead but none declares it fixes "${dimension}" — nearest is ${unrelated.hash} "${unrelated.subject}" (${new Date(unrelated.dateMs).toISOString()}); a commit naming the conversation is not a fix for this defect, so read it before suppressing.`
    : "";

  // (b) predates the live deploy + a corroborating signal (stale draft or a claiming commit).
  if (Number.isFinite(deployTsMs) && flaggedAtMs < deployTsMs) {
    if (isStaleDraft || corroborating.length > 0) {
      const bits = [
        `flagged reply predates the live deploy (${new Date(deployTsMs).toISOString()})`,
        isStaleDraft ? "and is a superseded stale draft (never reached the customer)" : "",
        corroborating.length ? `and ${corroborating.length} commit(s) ${dimensionChecked ? `declare they fix "${dimension}" on` : "name"} this case` : ""
      ].filter(Boolean);
      return { verdict: "stale_echo", reason: bits.join(" ") };
    }
    return {
      verdict: "review",
      reason: `predates the live deploy (${new Date(deployTsMs).toISOString()}) but no fix commit for this defect and not a stale draft — verify by hand before surfacing.${unrelatedNote}`,
      namingCommit: unrelated
    };
  }

  if (unrelated) {
    return {
      verdict: "review",
      reason: `no commit declares it fixes "${dimension}" on this lead.${unrelatedNote}`,
      namingCommit: unrelated
    };
  }

  // At/after the live deploy (or deploy time unknown and no fix): treat as a real live miss.
  if (!Number.isFinite(deployTsMs)) {
    return {
      verdict: "review",
      reason: `deploy time unknown and no naming fix commit — verify by hand`
    };
  }
  // "live" is a confident claim, and an unpinned reply cannot earn it: without `--at`
  // we graded the newest outbound, which may be a staff-typed reply or a later agent
  // turn rather than the one the detector flagged. Downgrade to review — that still
  // surfaces the item for a human, it just never asserts a regression we didn't see.
  if (!replyPinned) {
    return {
      verdict: "review",
      reason: `newest outbound is at/after the live deploy (${new Date(deployTsMs).toISOString()}) but no --at anchor was given, so this may not be the flagged reply (or even agent output) — re-run with --at <iso> of the flagged reply`
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

/**
 * origin/main commits (last 90d) whose MESSAGE mentions the phone digits or the customer
 * name. The full body is read, not just the subject, because the `loop-finding-key` marker
 * that says WHICH defect a commit fixed lives in the body (act_runner writes it into the PR
 * body and the squash-merge carries it through).
 */
// Record separator: a commit message can never contain a NUL byte, and a multi-line %B needs
// one. git emits it via the %x00 placeholder - never put the byte itself in argv, where
// execve would truncate the format string at it.
const REC = "\u0000";
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
        ["log", "origin/main", "--since=90.days", "-i", `--grep=${term}`, "--format=%x00%H%x09%ct%x09%s%x09%B"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      continue; // no repo / no match
    }
    for (const rec of raw.split(REC)) {
      if (!rec.trim()) continue;
      const [hash, ct, subject, ...bodyParts] = rec.split("\t");
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      out.push({
        hash: hash.slice(0, 8),
        subject: String(subject ?? "").trim(),
        dateMs: Number(ct) * 1000,
        findingKeys: parseFindingKeys(bodyParts.join("\t"))
      });
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

  // A genuinely live miss: flagged AFTER the deploy, no fix, anchored with --at.
  const live = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-09T03:00:00Z"),
    deployTsMs: DEPLOY,
    draftStatus: "",
    fixCommits: [],
    replyPinned: true
  });
  assert.equal(live.verdict, "live", "post-deploy pinned reply with no fix -> live miss");

  // Mark Kocsis, 2026-07-10: his 9:30-Saturday punts were stale drafts fixed by #170, but the
  // NEWEST outbound was Scott's hand-typed SMS 26 min after the deploy. Unpinned, that reads as
  // a post-deploy reply -> the guard used to cry "live" on a case it had already fixed.
  const unpinnedHumanReply = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-10T02:02:55Z"),
    deployTsMs: Date.parse("2026-07-10T01:36:11Z"),
    draftStatus: "",
    fixCommits: [],
    replyPinned: false
  });
  assert.equal(unpinnedHumanReply.verdict, "review", "post-deploy but UNPINNED reply -> review, never a confident 'live'");
  assert.match(unpinnedHumanReply.reason, /--at/, "the review reason tells the operator to pin --at");

  // Unpinned must never *suppress*: a stale echo stays a stale echo (evidence-backed, not a guess).
  const unpinnedStale = classifyEcho({
    flaggedAtMs: Date.parse("2026-07-06T20:38:33Z"),
    deployTsMs: DEPLOY,
    draftStatus: "stale",
    fixCommits: [],
    replyPinned: false
  });
  assert.equal(unpinnedStale.verdict, "stale_echo", "unpinned only downgrades 'live'; it never weakens a stale-echo suppression");

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

  // ---- 2026-08-22: a naming commit must CLAIM the defect, not merely the conversation ----
  // The marker act_runner writes into every PR body, verbatim (loopPrDedup.findingKeyMarker).
  const marker = (k: string) => `<!-- loop-finding-key: ${k} -->`;
  assert.deepEqual(
    parseFindingKeys(`root cause...\n${marker("+17166036684::reported_issue")}\n`),
    ["+17166036684::reported_issue"],
    "the PR-body marker is the machine-readable claim"
  );
  assert.deepEqual(parseFindingKeys("a hand-authored commit\n\nno marker here"), [], "no marker -> claims nothing");

  // Maxie Johnson (+17166036684), measured 2026-08-20: "this did not create a finance task about
  // financing" came back stale_echo citing #766 — a draft-reviewer change that has nothing to do
  // with task creation. The complaint was LIVE (0 todos on the thread to this day).
  const MAXIE_DEPLOY = Date.parse("2026-08-20T10:10:10Z");
  const unrelatedFix: FixCommit = {
    hash: "9afeed2e",
    subject: "Draft reviewer: it may name a gap it cannot fill, never fill it (+17166036684) (#766)",
    dateMs: Date.parse("2026-08-19T21:53:07Z"),
    // #766 was filed against the reviewer-rewrite finding on this same lead, so its marker
    // claims THAT dimension — and only that one.
    findingKeys: parseFindingKeys(`...\n${marker("+17166036684::draft_review_rewrite")}\n`)
  };
  const maxie = classifyEcho({
    flaggedAtMs: Date.parse("2026-08-19T19:00:00Z"),
    deployTsMs: MAXIE_DEPLOY,
    draftStatus: "",
    fixCommits: [unrelatedFix],
    dimension: "reported_issue",
    convDigits: "+17166036684"
  });
  assert.equal(maxie.verdict, "review", "a commit naming the LEAD but claiming another dimension never suppresses");
  assert.ok(maxie.reason.includes("9afeed2e"), "the review reason names the commit it refused to trust");
  assert.ok(!maxie.reason.includes("fixed by"), "and never claims the finding was fixed");

  // Same lead, same commit, and now the finding it really does claim -> still suppressed.
  const claimed = classifyEcho({
    flaggedAtMs: Date.parse("2026-08-19T19:00:00Z"),
    deployTsMs: MAXIE_DEPLOY,
    draftStatus: "",
    fixCommits: [unrelatedFix],
    dimension: "draft_review_rewrite",
    convDigits: "+17166036684"
  });
  assert.equal(claimed.verdict, "stale_echo", "a commit that CLAIMS this convId::dimension still suppresses");
  assert.equal(claimed.namingCommit?.hash, "9afeed2e", "and cites it");

  // A marker for the same dimension on a DIFFERENT lead must not travel.
  const otherLead = classifyEcho({
    flaggedAtMs: Date.parse("2026-08-19T19:00:00Z"),
    deployTsMs: MAXIE_DEPLOY,
    draftStatus: "",
    fixCommits: [{ ...unrelatedFix, findingKeys: ["+15551234567::reported_issue"] }],
    dimension: "reported_issue",
    convDigits: "+17166036684"
  });
  assert.equal(otherLead.verdict, "review", "a claim about another lead is not a claim about this one");

  // The stale-draft proof is about the REPLY, not about any commit: an unrelated naming commit
  // must not weaken it (that would trade one false verdict for another).
  const staleDraftWithUnrelatedCommit = classifyEcho({
    flaggedAtMs: Date.parse("2026-08-19T19:00:00Z"),
    deployTsMs: MAXIE_DEPLOY,
    draftStatus: "stale",
    fixCommits: [unrelatedFix],
    dimension: "reported_issue",
    convDigits: "+17166036684"
  });
  assert.equal(staleDraftWithUnrelatedCommit.verdict, "stale_echo", "a superseded stale draft still suppresses on its own evidence");

  // No dimension supplied -> the pre-2026-08-22 rule, unchanged (legacy callers keep their verdict).
  const legacy = classifyEcho({
    flaggedAtMs: Date.parse("2026-08-19T19:00:00Z"),
    deployTsMs: MAXIE_DEPLOY,
    draftStatus: "",
    fixCommits: [unrelatedFix]
  });
  assert.equal(legacy.verdict, "stale_echo", "without a dimension the guard cannot judge relevance and keeps its old, weaker verdict");

  console.log(
    "PASS already-shipped guard self-test (stale-echo via CLAIMING commit + pre-deploy stale draft; live; unpinned + review fallbacks; dimension relevance)"
  );
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  // --key is the finding key the feed already carries, and it supplies BOTH halves.
  const key = arg("--key");
  const keyIdx = key.lastIndexOf("::");
  const conv = arg("--conv") || (keyIdx > 0 ? key.slice(0, keyIdx) : "");
  if (!conv) {
    console.error(
      "usage: already_shipped_guard.ts (--key <convId::dimension> | --conv <phone/convId> [--dimension <d>]) [--name <customer>] [--deploy-ts <iso>] [--at <iso>]"
    );
    process.exit(2);
  }
  const dimension = arg("--dimension") || (keyIdx >= 0 ? key.slice(keyIdx + 2).trim() : "");
  const name = arg("--name");
  const deployIso = arg("--deploy-ts") || process.env.DEPLOY_TS || "";
  const deployTsMs = deployIso ? Date.parse(deployIso) : NaN;
  const conversationsPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));

  const atIso = arg("--at");
  const flagged = loadFlaggedReply(conversationsPath, conv, atIso);
  if (!flagged || !flagged.at) {
    console.log(JSON.stringify({ conv, verdict: "review", reason: "could not locate a flagged outbound reply for this conversation — verify by hand" }, null, 2));
    return;
  }
  const resolvedName = name || flagged.name;
  const fixCommits = findNamingCommits(conv, resolvedName);
  const result = classifyEcho({
    flaggedAtMs: Date.parse(flagged.at),
    deployTsMs,
    draftStatus: flagged.draftStatus,
    fixCommits,
    replyPinned: Boolean(atIso),
    dimension,
    convDigits: conv
  });

  console.log(
    JSON.stringify(
      {
        conv,
        dimension: dimension || undefined,
        dimensionChecked: Boolean(dimension),
        name: resolvedName || undefined,
        flaggedReplyAt: flagged.at,
        replyPinned: Boolean(atIso),
        flaggedDraftStatus: flagged.draftStatus || undefined,
        deployTs: deployIso || "(unknown — pass --deploy-ts)",
        namingCommits: fixCommits.map(
          c => `${c.hash} ${c.subject}${c.findingKeys?.length ? ` [claims ${c.findingKeys.join(", ")}]` : " [claims nothing]"}`
        ),
        verdict: result.verdict,
        reason: result.reason,
        ...(dimension
          ? {}
          : {
              warning:
                "no --dimension/--key given: a stale_echo here means only that SOME commit named this lead, not that this defect was fixed — pass --key <convId::dimension>"
            })
      },
      null,
      2
    )
  );
}

main();
