/**
 * Worker deploy parity eval (2026-07-31).
 *
 * THE INCIDENT. `deploy_api_lightsail.sh` built and shipped only `@throttleiq/api`. The worker runs
 * `node dist/index.js` from its OWN build, so every change under services/worker/src silently never
 * reached production. That was harmless while the worker was a shadow — and became a live outage
 * the moment `WORKER_DRIVEN_TICKS=1` flipped (2026-07-30 09:17Z) and disabled the API's in-process
 * ticks, making the worker the ONLY tick source.
 *
 * Found 2026-07-31: the box was still running a 2026-06-10 worker build. It scheduled 4 of the 8
 * minute-lane tasks, so `task-escalations`, `gate-blocker-digest` and `photo-delivery` had been
 * dead for ~24h. Measured blast radius: 0 of the 17 tasks created after the cutover were ever
 * escalated. (No photo deliveries happened to be queued, so no customer was affected — luck, not
 * design.)
 *
 * `worker_dispatch:eval` already pins that the worker's task NAMES match the API's registry. That
 * passed throughout — the schedule was correct in SOURCE. What nothing checked was whether the
 * source ever gets COMPILED AND SHIPPED. That is this eval.
 *
 * Run: npx tsx scripts/worker_deploy_parity_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const deploy = fs.readFileSync("scripts/deploy_api_lightsail.sh", "utf8");
let n = 0;

// --- The artifact (default) path must build AND upload the worker. -------------------------------
{
  assert.match(
    deploy,
    /npm --workspace @throttleiq\/worker run build/,
    "the deploy builds the worker, not just the API"
  );
  assert.match(
    deploy,
    /services\/worker\/dist\/index\.js/,
    "and verifies the worker build actually produced a dist"
  );
  assert.match(
    deploy,
    /rsync[^\n]*services\/worker\/dist\/[^\n]*services\/worker\/dist\//,
    "the worker dist is uploaded alongside the API dist"
  );
  n += 3;

  // Both builds must live in the SAME artifact branch — a worker build stranded in the remote-only
  // branch would never run, since DEPLOY_BUILD_MODE defaults to "local".
  assert.match(deploy, /DEPLOY_BUILD_MODE="\$\{DEPLOY_BUILD_MODE:-local\}"/, "artifact mode is the default");
  const localBranch = deploy.slice(
    deploy.indexOf('echo "Building API locally (artifact deploy)..."'),
    deploy.indexOf('if [[ "$DEPLOY_BUILD_MODE" == "local" && "$DEPLOY_DRY_RUN" != "1" ]]')
  );
  assert.ok(
    localBranch.includes("@throttleiq/worker run build"),
    "the worker build sits in the LOCAL artifact branch, which is the default path"
  );
  n += 2;
}

// --- A stale worker dist must be restarted, or a fresh build still would not take effect. --------
{
  assert.match(deploy, /DEPLOY_WORKER_PM2_PROCESS/, "the worker process is nameable");
  assert.match(deploy, /pm2 restart "\$DEPLOY_WORKER_PM2_PROCESS"/, "and is restarted after deploy");
  // Restart only — never `pm2 start`. Creating a worker that was not there would double every
  // background job against the same store.
  const restartBlock = deploy.slice(deploy.indexOf("DEPLOY_RESTART_WORKER:-1"));
  assert.ok(
    !/pm2 start[^\n]*DEPLOY_WORKER_PM2_PROCESS/.test(restartBlock),
    "the deploy never CREATES a worker process — that is a deliberate ops step"
  );
  // It must be forwarded over ssh, or the remote block reads an empty variable and silently skips.
  assert.match(
    deploy,
    /"DEPLOY_WORKER_PM2_PROCESS=\$\(shell_quote "\$DEPLOY_WORKER_PM2_PROCESS"\)"/,
    "the worker process name is forwarded to the remote shell"
  );
  n += 4;
}

// --- The dirty-tree guard must cover the worker too. ---------------------------------------------
{
  assert.match(
    deploy,
    /git status --porcelain services\/api services\/worker packages/,
    "an uncommitted worker edit must block an artifact deploy, exactly like an API edit"
  );
  n += 1;
}

// --- The dealer profile names the worker, so the restart is not silently skipped in prod. --------
{
  const profile = fs.readFileSync("infra/deploy/americanharley.api.env.example", "utf8");
  assert.match(
    profile,
    /^DEPLOY_WORKER_PM2_PROCESS=.+$/m,
    "the americanharley profile names its worker process"
  );
  n += 1;
}

// --- Cadence parity is only meaningful if the schedule ships; keep both facts together. ----------
{
  const cfg = fs.readFileSync("services/worker/src/config.ts", "utf8");
  const api = fs.readFileSync("services/api/src/domain/workerTasks.ts", "utf8");
  // Only the `tasks: [...]` arrays — config.ts also carries queue names and dealer defaults.
  const scheduled = [...cfg.matchAll(/tasks:\s*\[([^\]]*)\]/g)]
    .flatMap(m => [...m[1].matchAll(/"([a-z-]+)"/g)].map(x => x[1]));
  const registered = [...api.matchAll(/"([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(scheduled.length >= 8, `expected the worker to schedule at least 8 tasks, found ${scheduled.length}`);
  n += 1;
  for (const task of scheduled) {
    assert.ok(registered.includes(task), `worker schedules "${task}" but the API does not register it`);
    n += 1;
  }
  // The three jobs the stale dist silently dropped — name them so a future trim is deliberate.
  for (const task of ["task-escalations", "gate-blocker-digest", "photo-delivery", "staff-task-digests"]) {
    assert.ok(scheduled.includes(task), `"${task}" must stay scheduled (it went dark in the 7/30 stale-dist outage)`);
    n += 1;
  }
}

console.log(`PASS worker deploy parity eval (${n} assertions)`);
