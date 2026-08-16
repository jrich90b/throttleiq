/**
 * Dealer DNS plan/apply eval (deterministic — injectable resolver, no AWS calls).
 *
 * Pins the safety mechanics of domain/dealerDnsApply.ts:
 *   1. ZONE FENCE: a generated record outside leadrider.ai blocks the WHOLE plan —
 *      this tool can never write DNS for a foreign domain.
 *   2. Plan actions: no current record -> create; matching -> noop; differing -> update;
 *      `changes` counts only non-noop records.
 *   3. Fail-safe gates: apply is OFF unless DEALER_DNS_APPLY_ENABLED=1, and AWS
 *      credentials are correctly detected as absent.
 */
import assert from "node:assert/strict";
import {
  awsDnsCredentialsPresent,
  buildDealerDnsPlan,
  isDealerDnsApplyEnabled,
  type DnsResolver
} from "../services/api/src/domain/dealerDnsApply.ts";

let passed = 0;
function ok(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok - ${name}`);
  });
}

const subdomainSetup = {
  slug: "demo-dealer",
  routingMode: "subdomain" as const,
  appUrl: "https://demo-dealer.leadrider.ai",
  apiUrl: "https://api.demo-dealer.leadrider.ai"
};

const foreignSetup = {
  slug: "demo-dealer",
  routingMode: "subdomain" as const,
  appUrl: "https://evil.example.com",
  apiUrl: "https://api.demo-dealer.leadrider.ai"
};

const resolverOf = (table: Record<string, string[]>): DnsResolver => async name => table[name] ?? [];

await ok("zone fence blocks any record outside leadrider.ai", async () => {
  const plan = await buildDealerDnsPlan(foreignSetup, resolverOf({}));
  assert.ok(plan.blocked, "plan must be blocked");
  assert.match(plan.blocked!, /evil\.example\.com/);
  assert.equal(plan.records.length, 0);
  assert.equal(plan.changes, 0);
});

await ok("missing records plan as create", async () => {
  const plan = await buildDealerDnsPlan(subdomainSetup, resolverOf({}));
  assert.ok(!plan.blocked);
  assert.equal(plan.records.length, 2);
  assert.ok(plan.records.every(r => r.action === "create"));
  assert.equal(plan.changes, 2);
});

await ok("matching records plan as noop (trailing dot + case insensitive)", async () => {
  const plan = await buildDealerDnsPlan(
    subdomainSetup,
    resolverOf({
      "demo-dealer.leadrider.ai": ["CNAME.Vercel-DNS.com."],
      "api.demo-dealer.leadrider.ai": ["44.194.249.46"]
    })
  );
  assert.ok(plan.records.every(r => r.action === "noop"), JSON.stringify(plan.records));
  assert.equal(plan.changes, 0);
});

await ok("wrong current value plans as update, and only non-noop count as changes", async () => {
  const plan = await buildDealerDnsPlan(
    subdomainSetup,
    resolverOf({
      "demo-dealer.leadrider.ai": ["cname.vercel-dns.com"],
      "api.demo-dealer.leadrider.ai": ["1.2.3.4"]
    })
  );
  const byName = Object.fromEntries(plan.records.map(r => [r.name, r.action]));
  assert.equal(byName["demo-dealer.leadrider.ai"], "noop");
  assert.equal(byName["api.demo-dealer.leadrider.ai"], "update");
  assert.equal(plan.changes, 1);
});

await ok("apply flag is OFF unless DEALER_DNS_APPLY_ENABLED=1", () => {
  const prev = process.env.DEALER_DNS_APPLY_ENABLED;
  delete process.env.DEALER_DNS_APPLY_ENABLED;
  assert.equal(isDealerDnsApplyEnabled(), false);
  process.env.DEALER_DNS_APPLY_ENABLED = "1";
  assert.equal(isDealerDnsApplyEnabled(), true);
  if (prev === undefined) delete process.env.DEALER_DNS_APPLY_ENABLED;
  else process.env.DEALER_DNS_APPLY_ENABLED = prev;
});

await ok("absent AWS credentials are detected", () => {
  const prevId = process.env.AWS_ACCESS_KEY_ID;
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  assert.equal(awsDnsCredentialsPresent(), false);
  if (prevId !== undefined) process.env.AWS_ACCESS_KEY_ID = prevId;
  if (prevSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
});

console.log(`dealer_dns_apply:eval PASS (${passed} checks)`);
