/**
 * Provision-apply eval (deterministic — no SSH, no filesystem writes).
 *
 * Pins the money-path safety mechanics of scripts/dealer_provision_apply.ts:
 *   1. HARD REFUSALS: americanharley, port 3001, and any legacy
 *      /home/ubuntu/throttleiq* path abort before any step is built.
 *   2. Env writes are guarded `[ -f … ] ||` — an existing env file (live
 *      secrets) is NEVER overwritten. Fail direction: keep.
 *   3. The checkout/build/PM2 step is a HANDOFF to the existing guarded deploy
 *      script with the dealer's own profile — never a hand-rolled deploy.
 *   4. Preflight checks port + PM2 collisions before anything mutates.
 */
import assert from "node:assert/strict";
import { buildProvisionApplySteps, refusalFor } from "./dealer_provision_apply.ts";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const demoPlan = {
  slug: "demo-dealer",
  dealerName: "Demo Dealer",
  localPort: 31234,
  apiPm2Process: "leadrider-api-demo-dealer",
  workerPm2Process: "leadrider-worker-demo-dealer",
  runtimeRoot: "/home/ubuntu/leadrider-runtime/demo-dealer",
  repoPath: "/home/ubuntu/leadrider-api/demo-dealer",
  files: [
    { path: "env/platform.env.template", content: "PLATFORM=1\n" },
    { path: "env/dealer-api.env.template", content: "DEALER=1\n" }
  ]
};

ok("americanharley is refused outright", () => {
  const r = refusalFor({ ...demoPlan, slug: "americanharley" });
  assert.ok(r && /LIVE dealer/.test(r));
});
ok("port 3001 is refused outright", () => {
  const r = refusalFor({ ...demoPlan, localPort: 3001 });
  assert.ok(r && /3001/.test(r));
});
ok("legacy base paths are refused (runtime store incident, 2026-06-16)", () => {
  assert.ok(refusalFor({ ...demoPlan, runtimeRoot: "/home/ubuntu/throttleiq-runtime/data" }));
  assert.ok(refusalFor({ ...demoPlan, repoPath: "/home/ubuntu/throttleiq" }));
});
ok("a normal isolated dealer passes the refusal gate", () => {
  assert.equal(refusalFor(demoPlan), null);
});
ok("every env write is guarded — existing files are never overwritten", () => {
  const steps = buildProvisionApplySteps(demoPlan);
  const envSteps = steps.filter(s => s.id.startsWith("env-"));
  assert.equal(envSteps.length, 2);
  for (const s of envSteps) {
    assert.match(s.command, /^\[ -f [^\]]+\] \|\| cat > /, `${s.id} must be [ -f … ] || guarded`);
  }
});
ok("checkout/PM2 is a handoff to the existing deploy rails with the dealer profile", () => {
  const steps = buildProvisionApplySteps(demoPlan);
  const handoff = steps.find(s => s.kind === "handoff");
  assert.ok(handoff);
  assert.match(handoff!.command, /npm run deploy:api -- --profile infra\/deploy\/demo-dealer\.api\.env/);
});
ok("preflight checks port and PM2 collisions before any mutation", () => {
  const steps = buildProvisionApplySteps(demoPlan);
  assert.equal(steps[0].id, "preflight");
  assert.equal(steps[0].kind, "check");
  assert.match(steps[0].command, /:31234 /);
  // pm2 id exits 0 for unknown names — the check must use jlist name-grep (false-EXISTS aborts
  // safely, but a false-free would let a collision through; caught live on the 8/17 burn-in).
  assert.match(steps[0].command, /pm2 jlist.*"name":"leadrider-api-demo-dealer"/);
  const firstMutation = steps.findIndex(s => s.kind !== "check");
  assert.ok(firstMutation > 0, "no mutation may precede preflight");
});
ok("nginx/cron/pg/webhooks stay manual", () => {
  const steps = buildProvisionApplySteps(demoPlan);
  const manual = steps.find(s => s.id === "manual-rest");
  assert.ok(manual && manual.kind === "manual");
  assert.match(manual!.command, /nginx.*cron.*pg:import.*smoke.*webhooks/s);
});

console.log(`dealer_provision_apply:eval PASS (${passed} checks)`);
