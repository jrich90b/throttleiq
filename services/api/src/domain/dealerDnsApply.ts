import { promises as dns } from "node:dns";
import {
  Route53Client,
  ListHostedZonesByNameCommand,
  ChangeResourceRecordSetsCommand
} from "@aws-sdk/client-route-53";
import { getDealerSetup, updateDealerSetup, buildDealerApiDeployment, type DealerSetup } from "./dealerSetupStore.js";

/**
 * Dealer DNS plan/apply (Phase 2 hands-off onboarding, Joe 2026-08-17).
 *
 * The leadrider.ai zone lives on AWS Route53 (verified by NS lookup 8/16). This module turns
 * the Dealer Setup record's generated DNS records into a reviewable PLAN (dry-run default:
 * desired vs currently-resolving, per-record action) and, behind an explicit apply that is
 * ALSO flag-gated (DEALER_DNS_APPLY_ENABLED, default OFF), UPSERTs them via the Route53 API.
 *
 * Guardrails:
 *  - ZONE FENCE (deterministic compliance gate): every record name must sit inside
 *    leadrider.ai. A record outside the zone fails the whole plan — this tool can never
 *    write DNS for any other domain, no matter what a record generator produces.
 *  - Plan is the default; apply is a separate handler, flag-gated and credential-gated
 *    with explicit, actionable errors when AWS is not configured.
 *  - Verify-after-apply: Route53 acknowledges with a change id; public resolvers lag
 *    (propagation), so the step note records the change id and the plan can be re-run to
 *    watch records converge.
 */

const ZONE_NAME = (process.env.LEADRIDER_DNS_ZONE || "leadrider.ai").toLowerCase().replace(/\.$/, "");

export function isDealerDnsApplyEnabled(): boolean {
  const raw = String(process.env.DEALER_DNS_APPLY_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function awsDnsCredentialsPresent(): boolean {
  return !!(String(process.env.AWS_ACCESS_KEY_ID ?? "").trim() && String(process.env.AWS_SECRET_ACCESS_KEY ?? "").trim());
}

export type DealerDnsPlanRecord = {
  type: "A" | "CNAME";
  name: string;
  desired: string;
  purpose: string;
  current: string[];
  action: "create" | "update" | "noop";
};

export type DealerDnsPlan = {
  zone: string;
  records: DealerDnsPlanRecord[];
  changes: number;
  blocked?: string;
};

export type DnsResolver = (name: string, type: "A" | "CNAME") => Promise<string[]>;

async function defaultResolver(name: string, type: "A" | "CNAME"): Promise<string[]> {
  try {
    if (type === "A") return await dns.resolve4(name);
    return (await dns.resolveCname(name)).map(v => v.replace(/\.$/, ""));
  } catch {
    return [];
  }
}

function insideZone(name: string): boolean {
  const clean = String(name ?? "").toLowerCase().replace(/\.$/, "");
  return clean === ZONE_NAME || clean.endsWith(`.${ZONE_NAME}`);
}

export async function buildDealerDnsPlan(
  setup: Pick<DealerSetup, "slug" | "routingMode" | "appUrl" | "apiUrl">,
  resolver: DnsResolver = defaultResolver
): Promise<DealerDnsPlan> {
  const desired = buildDealerApiDeployment(setup).dnsRecords;
  // ZONE FENCE: refuse the entire plan if any generated record leaves the zone.
  const outside = desired.filter(record => !insideZone(record.name));
  if (outside.length) {
    return {
      zone: ZONE_NAME,
      records: [],
      changes: 0,
      blocked: `refusing to plan records outside ${ZONE_NAME}: ${outside.map(r => r.name).join(", ")}`
    };
  }
  const records: DealerDnsPlanRecord[] = [];
  for (const record of desired) {
    const current = await resolver(record.name, record.type);
    const desiredValue = record.value.toLowerCase().replace(/\.$/, "");
    const normalized = current.map(v => v.toLowerCase().replace(/\.$/, ""));
    const action: DealerDnsPlanRecord["action"] = !normalized.length
      ? "create"
      : normalized.includes(desiredValue)
        ? "noop"
        : "update";
    records.push({ type: record.type, name: record.name, desired: record.value, purpose: record.purpose, current, action });
  }
  return { zone: ZONE_NAME, records, changes: records.filter(r => r.action !== "noop").length };
}

async function applyPlanToRoute53(plan: DealerDnsPlan): Promise<{ changeId: string; upserted: number }> {
  const client = new Route53Client({});
  const zones = await client.send(new ListHostedZonesByNameCommand({ DNSName: `${ZONE_NAME}.`, MaxItems: 1 }));
  const zone = (zones.HostedZones ?? [])[0];
  const zoneName = String(zone?.Name ?? "").replace(/\.$/, "");
  if (!zone?.Id || zoneName !== ZONE_NAME) {
    throw new Error(`Route53 hosted zone for ${ZONE_NAME} not found (got ${zoneName || "nothing"}). Check the AWS account/key.`);
  }
  const changes = plan.records
    .filter(record => record.action !== "noop")
    .map(record => ({
      Action: "UPSERT" as const,
      ResourceRecordSet: {
        Name: `${record.name}.`,
        Type: record.type,
        TTL: 300,
        ResourceRecords: [{ Value: record.desired }]
      }
    }));
  if (!changes.length) return { changeId: "(no changes)", upserted: 0 };
  const resp = await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zone.Id,
      ChangeBatch: { Comment: "LeadRider dealer-setup DNS apply", Changes: changes }
    })
  );
  return { changeId: String(resp.ChangeInfo?.Id ?? "?"), upserted: changes.length };
}

// ---------------------------------------------------------------------------
// Express handlers (one-line wiring in index.ts — source-size ratchet).
// ---------------------------------------------------------------------------

export async function dealerDnsPlanHandler(req: any, res: any) {
  const setup = await getDealerSetup(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: "Dealer setup not found." });
  const plan = await buildDealerDnsPlan(setup);
  return res.json({
    ok: !plan.blocked,
    enabled: isDealerDnsApplyEnabled(),
    credentialed: awsDnsCredentialsPresent(),
    plan
  });
}

export async function dealerDnsApplyHandler(req: any, res: any) {
  if (!isDealerDnsApplyEnabled()) {
    return res.status(409).json({ ok: false, error: "DNS apply is disabled (DEALER_DNS_APPLY_ENABLED)." });
  }
  if (!awsDnsCredentialsPresent()) {
    return res.status(409).json({
      ok: false,
      error: "AWS credentials are not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY with Route53 access)."
    });
  }
  const setup = await getDealerSetup(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: "Dealer setup not found." });
  const plan = await buildDealerDnsPlan(setup);
  if (plan.blocked) return res.status(400).json({ ok: false, error: plan.blocked });
  try {
    const result = await applyPlanToRoute53(plan);
    const updated = await updateDealerSetup(setup.id, {
      stage: "dns",
      status: "in_progress",
      stepId: "domains",
      stepStatus: result.upserted ? "ready_to_verify" : "done",
      stepNote: result.upserted
        ? `Route53 UPSERT ${result.upserted} record(s), change ${result.changeId}. Re-run the plan to watch propagation.`
        : "DNS already matches — nothing to change."
    });
    console.log(`[dealer dns] applied ${result.upserted} change(s) for ${setup.slug} (${result.changeId})`);
    return res.json({ ok: true, result, plan, setup: updated ?? setup });
  } catch (err: any) {
    return res.status(502).json({ ok: false, error: String(err?.message ?? err).slice(0, 300), plan });
  }
}
