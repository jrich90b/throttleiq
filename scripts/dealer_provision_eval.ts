import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";

/**
 * Dealer provision plan eval (docs/multi_tenant_platform.md). No database,
 * no network — safe for ci:eval.
 */
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dealer-provision-eval-"));
  process.env.DATA_DIR = tmp;
  delete process.env.DEALER_SETUPS_PATH;

  const { addDealerSetup } = await import("../services/api/src/domain/dealerSetupStore.ts");
  const { buildDealerProvisionPlan } = await import(
    "../services/api/src/domain/dealerProvisionPlan.ts"
  );
  const { getWorkerPgBossSchema } = await import("../services/worker/src/config.ts");

  // Worker schema isolation (the dealer-#2 collision fix)
  const envBackup = {
    PGBOSS_SCHEMA: process.env.PGBOSS_SCHEMA,
    DEALER_ID: process.env.DEALER_ID,
    DEALER_SLUG: process.env.DEALER_SLUG
  };
  delete process.env.PGBOSS_SCHEMA;
  delete process.env.DEALER_SLUG;
  process.env.DEALER_ID = "americanharley";
  assert.equal(getWorkerPgBossSchema(), "pgboss_americanharley");
  process.env.DEALER_ID = "Eval-Powersports 2";
  assert.equal(getWorkerPgBossSchema(), "pgboss_eval_powersports_2");
  process.env.PGBOSS_SCHEMA = "custom_schema";
  assert.equal(getWorkerPgBossSchema(), "custom_schema", "explicit PGBOSS_SCHEMA must win");
  delete process.env.DEALER_ID;
  delete process.env.PGBOSS_SCHEMA;
  assert.equal(getWorkerPgBossSchema(), "pgboss_americanharley", "default dealer fallback");
  for (const [k, v] of Object.entries(envBackup)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  console.log("worker schema isolation ok");

  // Provision plan from a fresh dealer record (path routing is the default)
  const setup = await addDealerSetup({ dealerName: "Eval Powersports" });
  assert.equal(setup.routingMode, "path", "new dealers default to path routing");
  const plan = buildDealerProvisionPlan(setup);

  assert.equal(plan.slug, "eval-powersports");
  assert.ok(plan.localPort >= 31000 && plan.localPort < 32000, `port allocated (${plan.localPort})`);
  assert.equal(plan.apiPm2Process, "leadrider-api-eval-powersports");
  assert.equal(plan.workerPm2Process, "leadrider-worker-eval-powersports");
  assert.equal(plan.pgBossSchema, "pgboss_eval_powersports");

  const byPath = new Map(plan.files.map(f => [f.path, f.content]));
  const planMd = byPath.get("plan.md") ?? "";
  assert.ok(planMd.includes("pg:import"), "plan includes Postgres seed step");
  assert.ok(planMd.includes("dealer:smoke"), "plan includes smoke step");

  const dealerEnv = byPath.get("env/dealer-api.env.template") ?? "";
  assert.ok(dealerEnv.includes(`PGBOSS_SCHEMA=pgboss_eval_powersports`), "dealer env pins pg-boss schema");
  assert.ok(dealerEnv.includes(`WORKER_API_BASE_URL=http://127.0.0.1:${plan.localPort}`), "worker points at dealer port");
  assert.ok(dealerEnv.includes("DEALER_ID=eval-powersports"), "dealer env pins DEALER_ID");
  assert.ok(!/\n(DATABASE_URL|OPENAI_API_KEY)=(?!FILL)/.test(byPath.get("env/platform.env.template") ?? ""), "platform env has no real secrets");

  const nginx = byPath.get("nginx/eval-powersports.conf") ?? "";
  assert.ok(nginx.includes(`${plan.localPort}`), "nginx proxies to the dealer port");

  const cron = byPath.get("cron-lines.txt") ?? "";
  assert.ok(cron.includes("/home/ubuntu/leadrider-runtime/eval-powersports/data"), "cron uses dealer runtime paths");
  assert.ok(cron.includes("feedback:nightly") && cron.includes("feedback:hourly"), "cron covers both loops");

  const pm2 = byPath.get("pm2-commands.sh") ?? "";
  assert.ok(pm2.includes("@throttleiq/worker run start"), "pm2 starts the worker pair");

  // American Harley grandfathering: subdomain + legacy PM2 name preserved
  const ah = await addDealerSetup({ dealerName: "American Harley-Davidson", slug: "americanharley", routingMode: "subdomain" });
  const ahPlan = buildDealerProvisionPlan(ah);
  assert.equal(ahPlan.localPort, 3001);
  assert.equal(ahPlan.apiPm2Process, "throttleiq-api");
  assert.equal(ahPlan.pgBossSchema, "pgboss_americanharley");

  console.log("PASS dealer provision eval");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
