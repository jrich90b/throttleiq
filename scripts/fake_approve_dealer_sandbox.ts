import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DealerSetupStepStatus } from "../services/api/src/domain/dealerSetupStore.js";

type FakeApprovalStep = {
  id: string;
  status: DealerSetupStepStatus;
  note: string;
};

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function configureStorePaths() {
  const cwd = process.cwd();
  const isApiWorkspace = cwd.endsWith(path.join("services", "api"));
  const apiRoot = isApiWorkspace ? cwd : path.resolve(cwd, "services/api");
  if (!process.env.DEALER_SETUPS_PATH?.trim()) {
    process.env.DEALER_SETUPS_PATH = path.resolve(apiRoot, "data/dealer_setups.json");
  }
  return {
    dealerSetupsPath: process.env.DEALER_SETUPS_PATH
  };
}

function safeSlug(value: string) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "dealer";
}

function fakeApprovalSteps(completeHandoff: boolean): FakeApprovalStep[] {
  const approvalNote = "FAKE SANDBOX APPROVAL: completed locally to test the setup workflow. Not a production approval.";
  const steps: FakeApprovalStep[] = [
    { id: "intake", status: "done", note: `${approvalNote} Intake accepted.` },
    { id: "domains", status: "done", note: `${approvalNote} DNS/domain checklist accepted without changing DNS.` },
    { id: "sendgrid", status: "done", note: `${approvalNote} SendGrid checklist accepted without vendor submission.` },
    { id: "twilio", status: "done", note: `${approvalNote} Twilio/SMS compliance checklist accepted without carrier submission.` },
    { id: "google", status: "done", note: `${approvalNote} Google calendar/users checklist accepted without OAuth/MFA.` },
    { id: "inventory", status: "done", note: `${approvalNote} Inventory/export URL accepted for sandbox.` },
    { id: "crm", status: "done", note: `${approvalNote} CRM/ADF/Twilio routing accepted for sandbox.` },
    { id: "profile", status: "done", note: `${approvalNote} Dealer profile, tone, features, and rules accepted.` },
    { id: "remote_env", status: "done", note: `${approvalNote} Server settings checklist accepted without writing secrets.` },
    { id: "api", status: "done", note: `${approvalNote} API runtime package/profile accepted without deploying.` },
    { id: "vercel", status: "done", note: `${approvalNote} Vercel checklist accepted without changing project/domain settings.` },
    { id: "manual", status: "done", note: `${approvalNote} Deployment manual reviewed.` },
    { id: "smoke", status: "done", note: `${approvalNote} Smoke test marked pass for workflow simulation only.` },
    { id: "launch_gate", status: "done", note: `${approvalNote} Launch gate accepted for workflow simulation only.` }
  ];
  if (completeHandoff) {
    steps.push({ id: "handoff", status: "done", note: `${approvalNote} Handoff marked complete without creating a production client.` });
  }
  return steps;
}

async function main() {
  const slug = safeSlug(argValue("--slug") || argValue("--dealer") || "fictional-powersports-sandbox");
  const completeHandoff = hasFlag("--complete-handoff");
  const force = hasFlag("--force");
  if (!force && !slug.includes("sandbox")) {
    throw new Error(`Refusing fake approvals for non-sandbox slug "${slug}". Use --force only for an intentional local test.`);
  }

  const storePaths = configureStorePaths();
  const { getDealerSetup, listDealerSetups, updateDealerSetup } = await import("../services/api/src/domain/dealerSetupStore.js");
  const { buildDealerLaunchDryRun } = await import("../services/api/src/domain/dealerLaunchDryRun.js");
  const setup = (await listDealerSetups(500)).find(row => row.slug === slug);
  if (!setup) throw new Error(`Dealer setup "${slug}" not found in ${storePaths.dealerSetupsPath}.`);

  for (const step of fakeApprovalSteps(completeHandoff)) {
    await updateDealerSetup(setup.id, {
      stage: step.id === "handoff" ? "live" : step.id === "launch_gate" || step.id === "smoke" ? "live" : undefined,
      status: completeHandoff && step.id === "handoff" ? "live" : "ready",
      stepId: step.id,
      stepStatus: step.status,
      stepNote: step.note
    });
  }

  const refreshed = await getDealerSetup(setup.id);
  if (!refreshed) throw new Error("Sandbox setup disappeared during fake approvals.");
  const dryRun = buildDealerLaunchDryRun(refreshed);
  const artifactDir = path.resolve(process.cwd(), "reports/dealer-setup", safeSlug(refreshed.slug));
  await fs.mkdir(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, "fake-approval-report.json");
  const report = {
    ok: true,
    simulated: true,
    completeHandoff,
    dealerSetupsPath: storePaths.dealerSetupsPath,
    setup: {
      id: refreshed.id,
      dealerName: refreshed.dealerName,
      slug: refreshed.slug,
      status: refreshed.status,
      readiness: refreshed.deployReadiness,
      appUrl: refreshed.appUrl,
      apiUrl: refreshed.apiUrl
    },
    dryRun,
    warnings: [
      "This is a local sandbox simulation only.",
      "No DNS, Vercel, Lightsail deploy, vendor, credential, billing, legal, or production Active Client change was made.",
      "The production activation endpoint still performs real app/API smoke checks."
    ]
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (!dryRun.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
