import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  buildAcknowledgedInventoryWatchReply,
  hasInventoryWatchConfirmationText,
  hasPriorOutOfStockNoticeForModel,
  isDealershipLocationQuestionText,
  isExplicitCustomerCallbackRequestText
} from "../services/api/src/domain/workflowRegressionGuards.ts";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";
import {
  isDealerLocationQuestionText,
  isLogisticsProgressUpdateText
} from "../services/api/src/domain/transitionSafety.ts";

type FixClassification = "global" | "mixed";

type DealerProfile = {
  dealerName?: string;
  agentName?: string;
  address?: {
    line1?: string;
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
};

type DealerProfileInput = {
  profilePath: string;
  profile: DealerProfile;
};

type EvalCase = {
  id: string;
  classification: FixClassification;
  actual: unknown;
  expected: unknown;
  note: string;
};

type EvalCaseResult = EvalCase & {
  ok: boolean;
};

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function argValues(name: string) {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
  }
  return values.flatMap(value => value.split(",").map(item => item.trim()).filter(Boolean));
}

async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function defaultProfilePaths() {
  const cwd = process.cwd();
  return [
    path.resolve(cwd, "services/api/data/dealer_profile.json"),
    path.resolve(
      cwd,
      "reports/dealer-setup/americanharley-sandbox/runtime-config-package/config/dealer_profile.json"
    ),
    path.resolve(
      cwd,
      "reports/dealer-setup/fictional-powersports-sandbox/runtime-config-package/config/dealer_profile.json"
    )
  ];
}

async function readDealerProfiles(): Promise<DealerProfileInput[]> {
  const profilePaths = (argValues("--profile").length ? argValues("--profile") : defaultProfilePaths()).map(
    profilePath => path.resolve(profilePath)
  );
  const profiles: DealerProfileInput[] = [];
  for (const profilePath of profilePaths) {
    if (!(await fileExists(profilePath))) continue;
    profiles.push({
      profilePath,
      profile: JSON.parse(await fs.readFile(profilePath, "utf8"))
    });
  }
  return profiles;
}

function formatAddress(profile: DealerProfile) {
  const address = profile.address ?? {};
  const line1 = String(address.line1 ?? address.street ?? "").trim();
  const city = String(address.city ?? "").trim();
  const stateZip = [address.state, address.zip].map(value => String(value ?? "").trim()).filter(Boolean).join(" ");
  return [line1, city, stateZip].filter(Boolean).join(", ");
}

function buildProfileLocationReply(profile: DealerProfile) {
  const dealerName = String(profile.dealerName ?? "the dealership").trim();
  const agentName = String(profile.agentName ?? "Sales Team").trim();
  const address = formatAddress(profile) || "the address on file";
  return (
    `Hi — this is ${agentName} at ${dealerName}. We’re located at ${address}. ` +
    "Do you want pricing details or a quick model comparison?"
  );
}

function sameValue(actual: unknown, expected: unknown) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function evaluateProfile(input: DealerProfileInput) {
  const profile = input.profile;
  const dealerName = String(profile.dealerName ?? "").trim();
  const agentName = String(profile.agentName ?? "").trim();
  const address = formatAddress(profile);
  const locationReply = buildProfileLocationReply(profile);
  const watchDraft = buildAcknowledgedInventoryWatchReply({
    watchModels: ["Iron 883"],
    alternativeOptionLines: ["Breakout: 2025 Breakout plus 2 more."]
  });
  const watchInvariantInput = {
    inboundText: "I have no problem. let me know if you find something",
    draftText: "Got it — I’ll keep an eye out for a 2022 Forty-Eight and text you as soon as one comes in.",
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch",
    dialogState: "inventory_watch_active",
    classificationBucket: "in_store",
    classificationCta: "contact_us"
  };
  const unresolvedOtherInvariantInput = {
    inboundText: "Do you have anything in my range with some bags on it?",
    draftText:
      "I’m not seeing new 2026 Harley-Davidson Other in stock right now. If you'd like, you can stop by and we can go over availability and pricing, or I can text you as soon as one comes in. Are you after a certain color?",
    followUpMode: "manual_handoff",
    followUpReason: "credit_app",
    dialogState: "payments_handoff",
    classificationBucket: "finance_prequal",
    classificationCta: "hdfs_coa"
  };
  const cases: EvalCase[] = [
    {
      id: "explicit_customer_callback_request_routes_before_stale_schedule",
      classification: "global",
      actual: isExplicitCustomerCallbackRequestText("Hey, can you give me a call?"),
      expected: true,
      note: "Customer-requested callback should not be suppressed by stale scheduling context."
    },
    {
      id: "returning_call_statement_not_callback_request",
      classification: "global",
      actual: isExplicitCustomerCallbackRequestText("This is Darwin returning your call."),
      expected: false,
      note: "Do not create a callback handoff when the customer only says they are returning a call."
    },
    {
      id: "dealership_location_question_detected",
      classification: "global",
      actual: isDealershipLocationQuestionText("Sorry, remind me again what address is this at?"),
      expected: true,
      note: "Address questions should route before generic reminder suppression."
    },
    {
      id: "email_address_question_not_dealer_location",
      classification: "global",
      actual: isDealershipLocationQuestionText("What is my email address on file?"),
      expected: false,
      note: "Dealer-location detection should not catch customer/account address requests."
    },
    {
      id: "location_reply_uses_dealer_profile",
      classification: "mixed",
      actual:
        (!dealerName || locationReply.includes(dealerName)) &&
        (!agentName || locationReply.includes(agentName)) &&
        (!address || locationReply.includes(address)),
      expected: true,
      note: "Shared route can be global only if dealer name, agent, and address remain profile-driven."
    },
    {
      id: "adf_location_question_this_is_located_detected",
      classification: "mixed",
      actual: isDealerLocationQuestionText("Not sure where this is located or what is the cost."),
      expected: true,
      note: "ADF customer phrasing with 'where this is located' must override generic/test-ride source copy."
    },
    {
      id: "customer_address_not_dealer_location_question",
      classification: "global",
      actual: isDealerLocationQuestionText("What is my street address on file?"),
      expected: false,
      note: "Dealer-location fallback must not capture customer/account address questions."
    },
    {
      id: "inventory_watch_confirmation_detected",
      classification: "global",
      actual: hasInventoryWatchConfirmationText("Let me know if you find something."),
      expected: true,
      note: "Customer watch confirmations should not be treated as pure short acknowledgements."
    },
    {
      id: "prior_out_of_stock_notice_matches_same_model",
      classification: "global",
      actual: hasPriorOutOfStockNoticeForModel(
        ["I’m not seeing an Iron 883 in stock right now, but I can keep an eye out."],
        "Iron 883"
      ),
      expected: true,
      note: "Availability replies should not repeat stale unavailable context as if it were new."
    },
    {
      id: "watch_ack_answers_available_alternatives",
      classification: "global",
      actual: watchDraft.includes("available right now"),
      expected: true,
      note: "Watch acknowledgements with alternatives must answer the availability turn explicitly."
    },
    {
      id: "watch_ack_without_publisher_hint_is_blocked_control",
      classification: "global",
      actual: applyDraftStateInvariants(watchInvariantInput).reason,
      expected: "short_ack_no_action_guard",
      note: "Control case proving why mode/publisher invariant hints are required."
    },
    {
      id: "watch_ack_with_publisher_hint_is_allowed",
      classification: "global",
      actual: applyDraftStateInvariants({ ...watchInvariantInput, shortAckIntent: false }).allow,
      expected: true,
      note: "Suggest/autopilot publication must preserve parse hints through the final invariant boundary."
    },
    {
      id: "delivery_ready_before_date_progress_detected",
      classification: "mixed",
      actual: isLogisticsProgressUpdateText(
        "I spoke with Hollis. He told me the bike be ready before Juneteenth and I am good with that. Please let him know he got time."
      ),
      expected: true,
      note: "Purchase/delivery readiness updates should not fall into stale small-talk or media prompts."
    },
    {
      id: "unresolved_harley_other_inventory_repaired",
      classification: "global",
      actual: applyDraftStateInvariants(unresolvedOtherInvariantInput).draftText,
      expected: "I’ll have the team check current options in your range with bags and follow up shortly.",
      note: "Final publication boundary must repair unresolved generic inventory entities before draft/send."
    },
    {
      id: "truncated_in_good_draft_repaired",
      classification: "global",
      actual: applyDraftStateInvariants({
        inboundText: "is he the best man for the job?",
        draftText: "Yeah, Hollis knows his stuff — you’ll be in good",
        followUpMode: "active",
        followUpReason: "manual_resume",
        dialogState: "small_talk"
      }).reason,
      expected: "truncated_draft_repaired",
      note: "Final publication boundary must catch common incomplete LLM small-talk endings."
    },
    {
      id: "truncated_and_moves_draft_repaired",
      classification: "global",
      actual: applyDraftStateInvariants({
        inboundText: "is he the best man for the job?",
        draftText: "Yep, Hollis is solid — knows his stuff and moves",
        followUpMode: "active",
        followUpReason: "manual_resume",
        dialogState: "small_talk"
      }).reason,
      expected: "truncated_draft_repaired",
      note: "Final publication boundary must catch incomplete conjunction plus verb endings."
    }
  ];

  const results: EvalCaseResult[] = cases.map(evalCase => ({
    ...evalCase,
    ok: sameValue(evalCase.actual, evalCase.expected)
  }));

  return {
    dealerName: dealerName || path.basename(path.dirname(input.profilePath)),
    profilePath: input.profilePath,
    cases: results,
    failures: results.filter(result => !result.ok)
  };
}

function renderMarkdown(report: {
  generatedAt: string;
  profiles: ReturnType<typeof evaluateProfile>[];
  total: number;
  passed: number;
  failed: number;
}) {
  const lines: string[] = [];
  lines.push("# Inbound Reply QA Cross-Dealer Predeploy Eval");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`Profiles: ${report.profiles.length}`);
  lines.push(`Checks: ${report.passed}/${report.total} passed`);
  lines.push("");
  for (const profile of report.profiles) {
    lines.push(`## ${profile.dealerName}`);
    lines.push("");
    lines.push(`Profile: \`${profile.profilePath}\``);
    lines.push("");
    lines.push("| Result | Case | Classification | Note |");
    lines.push("| --- | --- | --- | --- |");
    for (const result of profile.cases) {
      lines.push(
        `| ${result.ok ? "PASS" : "FAIL"} | \`${result.id}\` | ${result.classification} | ${result.note} |`
      );
    }
    lines.push("");
  }
  if (report.failed) {
    lines.push("## Failures");
    lines.push("");
    for (const profile of report.profiles) {
      for (const failure of profile.failures) {
        lines.push(
          `- ${profile.dealerName} \`${failure.id}\`: expected ${JSON.stringify(
            failure.expected
          )}, actual ${JSON.stringify(failure.actual)}`
        );
      }
    }
    lines.push("");
  }
  lines.push("## Runtime Replay Limitation");
  lines.push("");
  lines.push(
    "This eval is profile-matrix synthetic coverage for global/mixed routing and publisher invariants. It does not replace true cross-dealer production runtime replay when another dealer DATA_DIR snapshot is available."
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const outDir = path.resolve(
    argValue("--out-dir") || "reports/automations/inbound-reply-qa/20260530/cross_dealer_predeploy"
  );
  const profiles = await readDealerProfiles();
  if (!profiles.length) throw new Error("No dealer profiles found for cross-dealer eval.");

  const profileResults = profiles.map(evaluateProfile);
  const total = profileResults.reduce((sum, profile) => sum + profile.cases.length, 0);
  const failed = profileResults.reduce((sum, profile) => sum + profile.failures.length, 0);
  const report = {
    generatedAt,
    profiles: profileResults,
    total,
    passed: total - failed,
    failed
  };
  const safeTimestamp = generatedAt.replace(/[:.]/g, "").replace("T", "T").replace("Z", "Z");
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `inbound-reply-cross-dealer-eval-${safeTimestamp}.json`);
  const markdownPath = path.join(outDir, `inbound-reply-cross-dealer-eval-${safeTimestamp}.md`);
  const latestJsonPath = path.join(outDir, "latest.json");
  const latestMarkdownPath = path.join(outDir, "report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, renderMarkdown(report));
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMarkdownPath, renderMarkdown(report));

  console.log(JSON.stringify({
    ok: failed === 0,
    profiles: profileResults.length,
    passed: total - failed,
    total,
    failed,
    jsonPath,
    markdownPath,
    latestJsonPath,
    latestMarkdownPath
  }, null, 2));

  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
