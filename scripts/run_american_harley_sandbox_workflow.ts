import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTaskKind, AgentTaskProvider, AgentTaskRisk } from "../services/api/src/domain/agentTaskStore.js";
import type { DealerSetup, DealerSetupStepStatus } from "../services/api/src/domain/dealerSetupStore.js";

type WorkflowStep = {
  id: string;
  status: DealerSetupStepStatus;
  note: string;
  task?: {
    title: string;
    kind: AgentTaskKind;
    provider?: AgentTaskProvider;
    risk?: AgentTaskRisk;
    approvalRequired?: boolean;
    instructions: string;
  };
};

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function configureStorePaths() {
  const cwd = process.cwd();
  const isApiWorkspace = cwd.endsWith(path.join("services", "api"));
  const apiRoot = isApiWorkspace ? cwd : path.resolve(cwd, "services/api");
  if (!process.env.DEALER_SETUPS_PATH?.trim()) {
    process.env.DEALER_SETUPS_PATH = path.resolve(apiRoot, "data/dealer_setups.json");
  }
  if (!process.env.AGENT_TASKS_PATH?.trim()) {
    process.env.AGENT_TASKS_PATH = path.resolve(apiRoot, "data/agent_tasks.json");
  }
  return {
    dealerSetupsPath: process.env.DEALER_SETUPS_PATH,
    agentTasksPath: process.env.AGENT_TASKS_PATH
  };
}

function safeSlug(value: string) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "dealer";
}

function coreFacts(setup: DealerSetup) {
  return [
    `Dealer: ${setup.dealerName}`,
    `Slug: ${setup.slug}`,
    `App URL: ${setup.appUrl}`,
    `API URL: ${setup.apiUrl}`,
    `Website: ${setup.website || "not provided"}`,
    `Primary contact: ${setup.primaryContact || "not provided"}`,
    `Sandbox: yes. Do not deploy or change production vendor settings.`
  ].join("\n");
}

function buildSteps(setup: DealerSetup): WorkflowStep[] {
  const facts = coreFacts(setup);
  return [
    {
      id: "intake",
      status: "done",
      note: "Sandbox intake confirmed from the setup record."
    },
    {
      id: "domains",
      status: "waiting_on_dealer",
      note: "Sandbox DNS records are generated, but DNS is intentionally not changed.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox domain checklist`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Prepare web/API DNS records for sandbox review only.",
          "Do not add or change DNS records without explicit human approval.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "sendgrid",
      status: "waiting_on_dealer",
      note: "SendGrid checklist created; no sender/domain verification submitted.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox SendGrid checklist`,
        kind: "provider_browser",
        risk: "low",
        approvalRequired: false,
        instructions: [
          "Prepare SendGrid sender/domain and inbound parse checklist.",
          "Stop for login, MFA, DNS, sender verification, API keys, or production changes.",
          "Do not expose secrets or submit verification.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "twilio",
      status: "waiting_on_dealer",
      note: "Twilio checklist created; no number, A2P/10DLC, webhook, or compliance submission changed.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox Twilio checklist`,
        kind: "provider_browser",
        risk: "low",
        approvalRequired: false,
        instructions: [
          "Prepare Twilio number, webhook, A2P/10DLC, opt-in, STOP/HELP, and routing checklist.",
          "Stop for billing, phone number purchases, carrier registration, compliance attestations, login, MFA, or production changes.",
          "Do not send real customer messages.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "google",
      status: "waiting_on_dealer",
      note: "Google Calendar checklist created; no OAuth/login/MFA changes performed.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox Google Calendar checklist`,
        kind: "provider_browser",
        risk: "low",
        approvalRequired: false,
        instructions: [
          "Prepare Google OAuth, Gmail/support mailbox, users, and calendar checklist.",
          "Stop for login, MFA, consent, credentials, token creation, or production changes.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "inventory",
      status: "ready_to_verify",
      note: "Inventory/export URL captured from the setup record; ready for parser/import validation.",
      task: {
        title: `Validate ${setup.dealerName} sandbox inventory export`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Validate the captured inventory/export URL format and expected import path.",
          "Do not change vendor exports or scrape credentialed portals.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "crm",
      status: "ready_to_verify",
      note: "CRM/ADF/Twilio routing checklist created from setup provider assumptions.",
      task: {
        title: `Validate ${setup.dealerName} sandbox CRM routing`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Validate ADF inbound endpoint, lead source mapping, owner routing, and Twilio route mapping.",
          "Do not submit vendor changes, use MFA, or send live tests.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "profile",
      status: "ready_to_verify",
      note: "Normalized dealer config generated from setup record; ready for review.",
      task: {
        title: `Generate ${setup.dealerName} sandbox dealer config`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Generate and review the normalized dealer config.",
          "Keep American Harley-specific assumptions isolated to this sandbox setup.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "remote_env",
      status: "ready_to_verify",
      note: "Remote env checklist/template generated; no secrets written.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox remote env checklist`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Review remote API env requirements and confirm secret values must be filled only on the server.",
          "Do not write or expose real secrets.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "api",
      status: "ready_to_verify",
      note: "API runtime profile generated with isolated sandbox repo/env/data/PM2 paths; not deployed.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox API runtime profile`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Review isolated API runtime profile, health URL, rollback path, and smoke command.",
          "Do not deploy.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "vercel",
      status: "waiting_on_dealer",
      note: "Vercel checklist created; no project/domain change made.",
      task: {
        title: `Prepare ${setup.dealerName} sandbox Vercel checklist`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Prepare Vercel frontend domain/env checklist for sandbox review.",
          "Do not add domains, change env, or deploy without explicit approval.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "manual",
      status: "done",
      note: "Deployment manual generated locally for sandbox review.",
      task: {
        title: `Review ${setup.dealerName} sandbox deployment manual`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Review generated deployment manual, rollback path, health checks, remote env, and human approval stops.",
          "Do not deploy.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "smoke",
      status: "blocked",
      note: "Sandbox public domains are intentionally not assumed live; run smoke tests only after sandbox deployment is approved.",
      task: {
        title: `Run ${setup.dealerName} sandbox smoke plan`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Prepare smoke-test plan for sandbox web, API health, inventory, ADF, Twilio, SendGrid, and calendar.",
          "Do not send real customer messages or deploy sandbox.",
          "",
          facts
        ].join("\n")
      }
    },
    {
      id: "launch_gate",
      status: "blocked",
      note: "Launch gate blocked by intentional no-deploy policy, missing sandbox DNS/provider approvals, and blocked sandbox smoke.",
      task: {
        title: `Review ${setup.dealerName} sandbox launch gate`,
        kind: "dealer_setup",
        risk: "approval_required",
        approvalRequired: true,
        instructions: [
          "Review launch readiness and blockers.",
          "Expected result: blocked until explicit deployment and vendor approval decisions are made.",
          "",
          facts
        ].join("\n")
      }
    }
  ];
}

async function ensureTask(setup: DealerSetup, step: WorkflowStep) {
  if (!step.task) return null;
  const { addAgentTask, listAgentTasks } = await import("../services/api/src/domain/agentTaskStore.js");
  const marker = `[dealer-setup:${setup.id}:${step.id}]`;
  const existing = (await listAgentTasks(1000)).find(task => {
    return task.instructions.includes(marker) && task.status !== "completed" && task.status !== "failed";
  });
  if (existing) return existing;
  return addAgentTask({
    provider: step.task.provider ?? "codex",
    kind: step.task.kind,
    title: step.task.title,
    instructions: `${marker}\n${step.task.instructions}`,
    clientName: setup.dealerName,
    priority: "high",
    risk: step.task.risk ?? "approval_required",
    approval: {
      required: step.task.approvalRequired !== false,
      reason: step.task.approvalRequired === false
        ? undefined
        : "Sandbox setup task can affect production-like routing or external provider setup, so human approval is required before action."
    },
    requestedBy: {
      name: "Dealer Sandbox Workflow",
      role: "system"
    }
  });
}

async function writeArtifacts(setup: DealerSetup) {
  const { buildDealerDeploymentManual } = await import("../services/api/src/domain/dealerDeploymentManual.js");
  const refreshed = setup;
  const artifactDir = path.resolve(process.cwd(), "reports/dealer-setup", safeSlug(refreshed.slug));
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(artifactDir, "dealer-config.json"),
    `${JSON.stringify(refreshed.dealerConfig ?? {}, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(artifactDir, "deployment-manual.md"),
    buildDealerDeploymentManual(refreshed, "markdown").body
  );
  await fs.writeFile(
    path.join(artifactDir, "remote-api-env.template"),
    refreshed.remoteEnvTemplate ?? ""
  );
  return artifactDir;
}

async function main() {
  const slug = argValue("--slug") || "americanharley-sandbox";
  const storePaths = configureStorePaths();
  const { getDealerSetup, listDealerSetups, updateDealerSetup } = await import("../services/api/src/domain/dealerSetupStore.js");
  const setup = (await listDealerSetups(500)).find(row => row.slug === slug);
  if (!setup) {
    throw new Error(`Dealer setup with slug "${slug}" was not found. Run npm run dealer:sandbox:seed -- --slug ${slug} first.`);
  }

  const taskResults: Array<{ stepId: string; taskId: string; status: string }> = [];
  for (const step of buildSteps(setup)) {
    const task = await ensureTask(setup, step);
    if (task) taskResults.push({ stepId: step.id, taskId: task.id, status: task.status });
    await updateDealerSetup(setup.id, {
      status: step.status === "blocked" ? "blocked" : "in_progress",
      stepId: step.id,
      stepStatus: step.status,
      stepNote: step.note
    });
  }

  const refreshed = await getDealerSetup(setup.id);
  if (!refreshed) throw new Error("Sandbox setup disappeared during workflow.");
  const artifactDir = await writeArtifacts(refreshed);
  console.log(JSON.stringify({
    ok: true,
    dealerSetupsPath: storePaths.dealerSetupsPath,
    agentTasksPath: storePaths.agentTasksPath,
    setup: {
      id: refreshed.id,
      dealerName: refreshed.dealerName,
      slug: refreshed.slug,
      status: refreshed.status,
      readiness: refreshed.deployReadiness,
      appUrl: refreshed.appUrl,
      apiUrl: refreshed.apiUrl
    },
    tasks: taskResults,
    artifacts: {
      dir: artifactDir,
      dealerConfig: path.join(artifactDir, "dealer-config.json"),
      manual: path.join(artifactDir, "deployment-manual.md"),
      remoteEnvTemplate: path.join(artifactDir, "remote-api-env.template")
    }
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
