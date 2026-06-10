import { buildDealerApiDeployment, type DealerSetup } from "./dealerSetupStore.js";
import { buildDealerRuntimePackage } from "./dealerRuntimePackage.js";

/**
 * Dealer provisioning plan (docs/multi_tenant_platform.md, M2 dry-run).
 *
 * Assembles everything `dealer:provision` would apply on the instance, as
 * reviewable files. This module only generates content — it never touches
 * the filesystem outside what the CLI writes under reports/, never SSHes,
 * and never applies anything. Reuses the Dealer Setup deployment math
 * (ports, PM2 names, nginx, deploy profile) so there is one source of truth.
 */

export type DealerProvisionFile = {
  path: string;
  content: string;
  description: string;
};

export type DealerProvisionPlan = {
  slug: string;
  dealerName: string;
  routingMode: DealerSetup["routingMode"];
  localPort: number;
  apiPm2Process: string;
  workerPm2Process: string;
  pgBossSchema: string;
  runtimeRoot: string;
  repoPath: string;
  files: DealerProvisionFile[];
  summaryLines: string[];
};

function pgBossSchemaForSlug(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "dealer";
  return `pgboss_${clean}`.slice(0, 50);
}

export function buildDealerProvisionPlan(setup: DealerSetup): DealerProvisionPlan {
  const deployment = buildDealerApiDeployment(setup);
  const pkg = buildDealerRuntimePackage(setup);
  const slug = setup.slug;
  const runtimeRoot = `/home/ubuntu/leadrider-runtime/${slug}`;
  const repoPath = deployment.repoPath || `/home/ubuntu/leadrider-api/${slug}`;
  const localPort = deployment.localPort;
  const apiPm2Process = deployment.pm2Process;
  const workerPm2Process = `leadrider-worker-${slug}`.slice(0, 80);
  const pgBossSchema = pgBossSchemaForSlug(slug);

  const pkgFile = (suffix: string) =>
    pkg.files.find(f => f.path === suffix || f.path.endsWith(suffix))?.content ?? "";

  const remoteEnvTemplate = pkgFile("env/remote-api.env.template");
  const nginxPreview = pkgFile(`.nginx.conf.preview`) || deployment.nginxPreview || "";

  const platformEnv = [
    "# /home/ubuntu/leadrider-runtime/platform.env",
    "# Shared across every dealer process on this instance. Sourced BEFORE the",
    "# dealer api.env (dealer values win). Fill on the server; never commit.",
    "DATABASE_URL=FILL_ME",
    "PG_SSL=1",
    "OPENAI_API_KEY=FILL_ME",
    "LLM_ENABLED=1",
    ""
  ].join("\n");

  const workerEnvBlock = [
    "",
    "# Worker dispatcher (docs/worker_queue_extraction.md)",
    "WORKER_INTERNAL_TOKEN=FILL_ME_RANDOM_HEX",
    `WORKER_API_BASE_URL=http://127.0.0.1:${localPort}`,
    `PGBOSS_SCHEMA=${pgBossSchema}`,
    `DEALER_ID=${slug}`,
    `PORT=${localPort}`,
    ""
  ].join("\n");

  const dealerEnv = `${remoteEnvTemplate.trimEnd()}\n${workerEnvBlock}`;

  const cronLines = [
    "# Crontab additions for this dealer (review, then crontab -e as ubuntu)",
    `15 8 * * * /bin/bash -lc "cd ${repoPath} && DATA_DIR=${runtimeRoot}/data REPORT_ROOT=${runtimeRoot}/reports FEEDBACK_LOOP_ENV_PATH=${runtimeRoot}/feedback_loop.env npm run feedback:nightly >> ${runtimeRoot}/reports/feedback_loop_cron.log 2>&1"`,
    `15 2 * * * DATA_DIR=${runtimeRoot}/data; mkdir -p "$DATA_DIR/backups"; cp "$DATA_DIR/conversations.json" "$DATA_DIR/backups/conversations.$(date +\\%Y\\%m\\%d_\\%H\\%M\\%S).json"; find "$DATA_DIR/backups" -type f -name "conversations.*.json" -mtime +30 -delete`,
    `0 * * * * /bin/bash -lc "cd ${repoPath} && DATA_DIR=${runtimeRoot}/data REPORT_ROOT=${runtimeRoot}/reports FEEDBACK_LOOP_ENV_PATH=${runtimeRoot}/feedback_loop.env FAST_LOOP_SINCE_HOURS=2 npm run feedback:hourly >> ${runtimeRoot}/reports/feedback_loop_hourly_cron.log 2>&1"`,
    ""
  ].join("\n");

  const pm2Commands = [
    "#!/usr/bin/env bash",
    "# Manual-apply PM2 commands (run on the instance after env files are filled).",
    "set -euo pipefail",
    `cd ${repoPath}`,
    "set -a; . /home/ubuntu/leadrider-runtime/platform.env 2>/dev/null || true; . " +
      `${runtimeRoot}/api.env; set +a`,
    `export DATA_DIR=${runtimeRoot}/data`,
    `pm2 start npm --name ${apiPm2Process} --cwd ${repoPath} -- --workspace @throttleiq/api run start`,
    `pm2 start npm --name ${workerPm2Process} --cwd ${repoPath} -- --workspace @throttleiq/worker run start`,
    "pm2 save",
    ""
  ].join("\n");

  const summaryLines = [
    `Dealer: ${setup.dealerName} (${slug})`,
    `Routing: ${setup.routingMode}  app=${setup.appUrl}  api=${setup.apiUrl}`,
    `Local port: ${localPort}`,
    `PM2: ${apiPm2Process} + ${workerPm2Process}`,
    `pg-boss schema: ${pgBossSchema}`,
    `Runtime: ${runtimeRoot}`,
    `Checkout: ${repoPath}`,
    `DNS records: ${(deployment.dnsRecords ?? []).map((r: any) => `${r.type} ${r.name}`).join(", ") || "(path mode: shared hostnames)"}`
  ];

  const planMd = [
    `# Provision plan: ${setup.dealerName} (${slug})`,
    "",
    "Generated dry-run. Nothing has been applied. Review each file, fill",
    "FILL_ME values on the server only, then follow the order below.",
    "",
    ...summaryLines.map(l => `- ${l}`),
    "",
    "## Apply order",
    "",
    `1. mkdir -p ${runtimeRoot}/{data,reports} and create env files from the templates`,
    "2. platform.env shared values (once per instance), dealer api.env secrets",
    `3. Clone/build checkout at ${repoPath} (normal deploy script with the generated profile)`,
    "4. nginx: install the server block, obtain TLS cert, reload",
    "5. pm2-commands.sh (API + worker pair), pm2 save",
    "6. crontab additions (cron-lines.txt)",
    `7. Seed Postgres: DATABASE_URL=... DEALER_ID=${slug} npm run pg:import`,
    `8. npm run dealer:smoke -- --dealer ${slug}`,
    "9. Vendor webhooks (Twilio/SendGrid) per the deployment manual",
    "",
    "Approval stops from the runtime package still apply: no DNS, vendor,",
    "credential, or customer-facing action without explicit human sign-off.",
    ""
  ].join("\n");

  const files: DealerProvisionFile[] = [
    { path: "plan.md", content: planMd, description: "Provision plan + apply order" },
    { path: "env/platform.env.template", content: platformEnv, description: "Shared instance env (once per box)" },
    { path: "env/dealer-api.env.template", content: dealerEnv, description: "Dealer env incl. worker block" },
    { path: `nginx/${slug}.conf`, content: nginxPreview, description: "nginx server block (review then apply)" },
    { path: "cron-lines.txt", content: cronLines, description: "Crontab additions" },
    { path: "pm2-commands.sh", content: pm2Commands, description: "PM2 start commands (API + worker)" }
  ];

  return {
    slug,
    dealerName: setup.dealerName,
    routingMode: setup.routingMode,
    localPort,
    apiPm2Process,
    workerPm2Process,
    pgBossSchema,
    runtimeRoot,
    repoPath,
    files,
    summaryLines
  };
}
