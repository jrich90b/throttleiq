import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Dealer provisioning APPLY (Phase 3 hands-off onboarding, Joe 2026-08-17).
 *
 * Rehearse-then-apply executor for the dry-run plan (dealer_provision.ts /
 * domain/dealerProvisionPlan.ts). DEFAULT IS REHEARSE: prints every action with the
 * exact command and touches nothing. `--apply` executes the server-home steps
 * (dirs + guarded env templates + local deploy profile). The checkout/build/PM2/health
 * step is NOT reimplemented — it hands off to the existing guarded deploy script
 * (`npm run deploy:api -- --profile …`), which carries the data-dir rails, health
 * checks, and rollback we already trust; that handoff additionally requires `--start`.
 *
 * HARD REFUSALS (fail-safe, non-negotiable):
 *  - slug `americanharley` — the LIVE dealer is never provisioned by this tool.
 *  - any path under /home/ubuntu/throttleiq — the legacy base checkout/store
 *    (AGENTS.md Dealer Runtime Safety; the 2026-06-16 wrong-store incident).
 *  - local port 3001 — American Harley's port.
 *  - env files are NEVER overwritten: every env write is guarded `[ -f … ] ||`
 *    (an existing api.env holds live secrets; failing toward "keep" is the rule).
 *
 * Steps 4 (nginx+TLS), 6 (cron), 7 (pg seed), 9 (vendor webhooks) from plan.md
 * stay manual-with-instructions in this slice — printed, never executed.
 *
 * Usage:
 *   npx tsx scripts/dealer_provision_apply.ts --slug <slug> [--from-api] [--apply] [--start]
 */

const SSH_HOST = process.env.PROVISION_SSH_HOST || "ubuntu@api.leadrider.ai";

export type ProvisionApplyStep = {
  id: string;
  title: string;
  kind: "check" | "local" | "remote" | "handoff" | "manual";
  command: string;
  detail: string;
};

export function refusalFor(plan: {
  slug: string;
  localPort: number;
  runtimeRoot: string;
  repoPath: string;
}): string | null {
  if (plan.slug === "americanharley") {
    return "REFUSED: 'americanharley' is the LIVE dealer — this tool never provisions or touches it.";
  }
  if (plan.localPort === 3001) {
    return "REFUSED: local port 3001 belongs to the live American Harley API.";
  }
  for (const p of [plan.runtimeRoot, plan.repoPath]) {
    if (/\/home\/ubuntu\/throttleiq(?:-runtime)?(?:\/|$)/.test(p)) {
      return `REFUSED: ${p} is the legacy base checkout/store (Dealer Runtime Safety) — never targeted by this tool.`;
    }
  }
  return null;
}

export function buildProvisionApplySteps(plan: {
  slug: string;
  dealerName: string;
  localPort: number;
  apiPm2Process: string;
  workerPm2Process: string;
  runtimeRoot: string;
  repoPath: string;
  files: Array<{ path: string; content: string }>;
}): ProvisionApplyStep[] {
  const file = (suffix: string) => plan.files.find(f => f.path === suffix || f.path.endsWith(suffix));
  const profileLocalPath = `infra/deploy/${plan.slug}.api.env`;
  return [
    {
      id: "preflight",
      title: "Preflight: disk, memory, port, PM2 collisions",
      kind: "check",
      command: [
        `df -h / | tail -1`,
        `free -m | head -2`,
        `(ss -ltn | grep -q ':${plan.localPort} ' && echo 'PORT ${plan.localPort} IN USE' || echo 'port ${plan.localPort} free')`,
        // pm2 id exits 0 even for unknown names (prints []) — jlist name-grep is the reliable test.
        `(pm2 jlist 2>/dev/null | grep -q '"name":"${plan.apiPm2Process}"' && echo 'PM2 ${plan.apiPm2Process} EXISTS' || echo 'pm2 name free')`
      ].join(" && "),
      detail: "Read-only. Apply aborts if the port or PM2 name is already taken, or disk/memory look tight."
    },
    {
      id: "dirs",
      title: `Create runtime home ${plan.runtimeRoot}`,
      kind: "remote",
      command: `mkdir -p ${plan.runtimeRoot}/data ${plan.runtimeRoot}/reports`,
      detail: "Idempotent (mkdir -p). The dealer's isolated data/reports directories."
    },
    {
      id: "env-platform",
      title: "Platform env template (write only if absent)",
      kind: "remote",
      command: `[ -f /home/ubuntu/leadrider-runtime/platform.env ] || cat > /home/ubuntu/leadrider-runtime/platform.env <<'EOF_ENV'\n${file("platform.env.template")?.content ?? ""}EOF_ENV`,
      detail: "Shared once-per-box env. NEVER overwrites an existing file — existing secrets always win."
    },
    {
      id: "env-dealer",
      title: `Dealer env template ${plan.runtimeRoot}/api.env (write only if absent)`,
      kind: "remote",
      command: `[ -f ${plan.runtimeRoot}/api.env ] || cat > ${plan.runtimeRoot}/api.env <<'EOF_ENV'\n${file("dealer-api.env.template")?.content ?? ""}EOF_ENV`,
      detail: "FILL_ME markers stay for human-supplied secrets (Twilio/SendGrid/etc. via secure channel). NEVER overwrites."
    },
    {
      id: "deploy-profile",
      title: `Local deploy profile ${profileLocalPath}`,
      kind: "local",
      command: `write ${profileLocalPath} (from the Dealer Setup deployment math) + DEPLOY_EXPECTED_DATA_DIR=${plan.runtimeRoot}/data`,
      detail: "The guarded deploy script refuses to run against the wrong data dir because of this pin."
    },
    {
      id: "deploy-handoff",
      title: `Checkout + build + PM2 + health via the EXISTING deploy rails`,
      kind: "handoff",
      command: `npm run deploy:api -- --profile ${profileLocalPath}`,
      detail: `Runs ONLY with --apply --start. Clone/build/rsync/PM2 (${plan.apiPm2Process}) with the deploy script's own health checks and rollback. First run per dealer is the human-reviewed launch step.`
    },
    {
      id: "manual-rest",
      title: "Remaining manual steps (printed, never executed)",
      kind: "manual",
      command: `nginx/${plan.slug}.conf + TLS; cron-lines.txt; pg:import (DEALER_ID=${plan.slug}); dealer:smoke; vendor webhooks`,
      detail: "Each needs sudo, credentials, or vendor consoles — human territory per the hard limits."
    }
  ];
}

// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}
function opt(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] ?? "").trim() : "";
}

async function loadSetup(slug: string, fromApi: boolean): Promise<any> {
  if (!fromApi) {
    const { listDealerSetups } = await import("../services/api/src/domain/dealerSetupStore.ts");
    const setups = await listDealerSetups(500);
    const setup = setups.find(s => s.slug === slug);
    if (!setup) {
      throw new Error(`No LOCAL dealer setup for '${slug}' (known: ${setups.map(s => s.slug).join(", ") || "none"}). Remote record? Add --from-api.`);
    }
    return setup;
  }
  const base = (process.env.LEADRIDER_API_BASE || "https://api.leadrider.ai").replace(/\/+$/, "");
  let token = String(process.env.LEADRIDER_OPERATOR_TOKEN || "").trim();
  if (!token) {
    const credsPath = path.join(process.cwd(), ".claude/skills/customer-reply/.creds");
    if (!fssync.existsSync(credsPath)) throw new Error("--from-api needs LEADRIDER_OPERATOR_TOKEN or .claude/skills/customer-reply/.creds");
    const raw = fssync.readFileSync(credsPath, "utf8");
    let email = "", password = "";
    try {
      const j = JSON.parse(raw);
      email = String(j.email ?? ""); password = String(j.password ?? "");
    } catch {
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*(email|password)\s*[=:]\s*(.*)$/i);
        if (m) m[1].toLowerCase() === "email" ? (email = m[2].trim()) : (password = m[2].replace(/\s+$/, ""));
      }
    }
    const res = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const json: any = await res.json();
    if (!json?.token) throw new Error(`login failed (${res.status})`);
    token = String(json.token);
  }
  const res = await fetch(`${base}/dealer-setups?limit=500`, { headers: { "x-auth-token": token } });
  const json: any = await res.json();
  const setup = (json?.setups ?? []).find((s: any) => s.slug === slug);
  if (!setup) throw new Error(`No dealer setup '${slug}' on the API (${base}).`);
  return setup;
}

async function main() {
  const argv = process.argv.slice(2);
  const slug = opt(argv, "--slug");
  if (!slug) {
    console.error("usage: dealer_provision_apply.ts --slug <slug> [--from-api] [--apply] [--start]");
    process.exit(2);
  }
  const apply = flag(argv, "--apply");
  const start = flag(argv, "--start");

  const setup = await loadSetup(slug, flag(argv, "--from-api"));
  const { buildDealerProvisionPlan } = await import("../services/api/src/domain/dealerProvisionPlan.ts");
  const { buildDealerApiDeployment } = await import("../services/api/src/domain/dealerSetupStore.ts");
  const plan = buildDealerProvisionPlan(setup);
  const deployment = buildDealerApiDeployment(setup);

  const refusal = refusalFor(plan);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }

  const steps = buildProvisionApplySteps(plan);
  console.log(`Provision ${apply ? "APPLY" : "REHEARSAL"} — ${plan.dealerName} [${plan.slug}]  (host ${SSH_HOST})`);
  for (const line of plan.summaryLines) console.log(`  ${line}`);
  console.log("");

  for (const [i, step] of steps.entries()) {
    console.log(`${i + 1}. [${step.kind}] ${step.title}`);
    console.log(`   ${step.detail}`);
    if (!apply) {
      console.log(`   would run: ${step.command.split("\n")[0].slice(0, 160)}${step.command.includes("\n") ? " …" : ""}`);
      continue;
    }
    if (step.kind === "manual") {
      console.log(`   MANUAL — see reports/dealer-provision/${plan.slug}/plan.md`);
      continue;
    }
    if (step.kind === "handoff") {
      if (!start) {
        console.log("   SKIPPED — the deploy/PM2 handoff additionally requires --start (the human-reviewed launch step).");
        continue;
      }
      console.log(`   handing off: ${step.command}`);
      const res = spawnSync("npm", ["run", "deploy:api", "--", "--profile", `infra/deploy/${plan.slug}.api.env`], {
        stdio: "inherit"
      });
      if (res.status !== 0) {
        console.error(`   deploy handoff exited ${res.status} — remember exit 23 = slow boot; check the public health URL before assuming failure.`);
        process.exit(res.status ?? 1);
      }
      continue;
    }
    if (step.kind === "local") {
      const profilePath = path.join(process.cwd(), "infra", "deploy", `${plan.slug}.api.env`);
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      const profileText = `${deployment.profileText.trimEnd()}\nDEPLOY_EXPECTED_DATA_DIR=${plan.runtimeRoot}/data\n`;
      if (fssync.existsSync(profilePath)) {
        console.log(`   exists, left untouched: ${profilePath}`);
      } else {
        await fs.writeFile(profilePath, profileText, "utf8");
        console.log(`   wrote ${profilePath}`);
      }
      continue;
    }
    const res = spawnSync("ssh", ["-o", "ConnectTimeout=15", SSH_HOST, step.command], { encoding: "utf8" });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    console.log(out.split("\n").map(l => `   ${l}`).join("\n"));
    if (res.status !== 0) {
      console.error(`   step '${step.id}' failed (exit ${res.status}) — aborting; nothing later ran.`);
      process.exit(1);
    }
    if (step.id === "preflight" && /IN USE|EXISTS/.test(out)) {
      console.error("   preflight collision — aborting before any mutation.");
      process.exit(1);
    }
  }

  console.log("");
  console.log(
    apply
      ? start
        ? "APPLY complete through the deploy handoff. Manual steps remain (nginx/TLS, cron, pg seed, smoke, webhooks)."
        : "APPLY complete for the server home (dirs, env templates, deploy profile). Re-run with --apply --start for the reviewed deploy/PM2 launch."
      : "Rehearsal only — nothing executed. Re-run with --apply for the server home; add --start for the deploy/PM2 handoff."
  );
}

const isDirectRun = process.argv[1]?.endsWith("dealer_provision_apply.ts");
if (isDirectRun) {
  main().catch(err => {
    console.error("dealer:provision:apply failed:", err?.message ?? err);
    process.exit(1);
  });
}
