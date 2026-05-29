type SmokeTarget = {
  label: string;
  url: string;
};

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function cleanBase(value: string) {
  return value.trim().replace(/\/+$/, "");
}

async function check(target: SmokeTarget) {
  const started = Date.now();
  try {
    const resp = await fetch(target.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
    return {
      ...target,
      ok: resp.ok,
      status: resp.status,
      ms: Date.now() - started
    };
  } catch (err: any) {
    return {
      ...target,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: String(err?.message ?? err).slice(0, 180)
    };
  }
}

async function main() {
  const slug = argValue("--dealer") || argValue("--slug") || process.env.DEALER_SLUG || "americanharley";
  const routingMode = argValue("--routing-mode") || process.env.TENANT_ROUTING_MODE || "subdomain";
  const defaultApp = routingMode === "subdomain" ? `https://${slug}.leadrider.ai` : `https://app.leadrider.ai/d/${slug}`;
  const defaultApi = routingMode === "path"
    ? `https://api.leadrider.ai/t/${slug}`
    : routingMode === "integration_mapping"
      ? "https://api.leadrider.ai"
      : `https://api.${slug}.leadrider.ai`;
  const appBase = cleanBase(argValue("--app") || process.env.APP_BASE_URL || defaultApp);
  const apiBase = cleanBase(argValue("--api") || process.env.API_BASE_URL || defaultApi);
  const targets: SmokeTarget[] = [
    { label: "web", url: appBase },
    { label: "api_health", url: `${apiBase}/health` }
  ];
  const results = await Promise.all(targets.map(check));
  for (const result of results) {
    const suffix = result.ok ? `${result.status} ${result.ms}ms` : `${result.status || "ERR"} ${result.error || ""}`.trim();
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.label} ${result.url} ${suffix}`);
  }
  if (!results.every(result => result.ok)) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
