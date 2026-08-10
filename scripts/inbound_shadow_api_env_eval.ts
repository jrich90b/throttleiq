/**
 * inbound_shadow_api_env:eval — pins the temporary replay API's environment (2026-08-10).
 *
 * WHY: the shadow-replay harness booted its per-case API with `AUTH_DISABLED: "1"`, but the API
 * reads that flag as an EXACT STRING — `(process.env.AUTH_DISABLED ?? "false").toLowerCase() ===
 * "true"` (services/api/src/index.ts) — so "1" left authentication ON. Measured 2026-08-10 by
 * booting the real dist with the harness's own env: `GET /conversations/:id` answered
 * `401 {"ok":false,"error":"auth required"}`, and with "true" the same request answered 200.
 *
 * What that cost: `waitForPreparedConversation` documents `GET /conversations/:id` as its
 * PREFERRED, semantic readiness signal — the gate that stops a turn replaying against an
 * unhydrated store and manufacturing the phantom `corpus_replay_regression` that
 * [[replay_fidelity:eval]] exists to describe. That branch could never return, so every case
 * fell through to the weaker log-line fallback, which proves only that the process hydrated
 * SOMETHING — not that THIS conversation loaded with the forced replay mode. A dead preferred
 * branch is invisible: the harness looks like it is checking and is not.
 *
 * This eval EXECUTES the env builder and a stand-in for the API's auth middleware over a real
 * loopback server, because a source-text assertion cannot tell a reachable readiness probe from
 * an unreachable one — that is precisely the failure it has to catch. It also executes the
 * hermeticity contract (a poisoned inherited env must not reach the sandbox store).
 *
 * LIMIT, stated on purpose: `shadowApiAuthDisabled` mirrors the API's rule rather than importing
 * it (importing index.ts boots a server, and auth code is not this loop's to edit). If the API
 * ever changes which strings disable auth, this eval pins the OLD rule — the mirror and its
 * source are named together above so the pair is greppable.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import {
  buildShadowApiEnv,
  shadowApiAuthDisabled,
  SHADOW_API_AUTH_DISABLED
} from "./inbound_shadow_replay.ts";

const CONV_ID = "+15550001111";
const SANDBOX_DIR = path.join("/tmp", "shadow-replay-case-eval", "data");

function envFor(overrides?: { baseEnv?: NodeJS.ProcessEnv; port?: number }) {
  return buildShadowApiEnv({
    dataDir: SANDBOX_DIR,
    jobsPath: path.join(SANDBOX_DIR, "twilio_inbound_jobs_shadow.json"),
    envFileVars: {},
    port: overrides?.port ?? 4599,
    baseEnv: overrides?.baseEnv ?? {}
  });
}

// ── 1. The API's own rule, executed over the value the harness actually ships ──────────
{
  assert.equal(
    shadowApiAuthDisabled(SHADOW_API_AUTH_DISABLED),
    true,
    "the constant the harness ships must satisfy the API's AUTH_DISABLED test"
  );
  // The regression itself: the value that shipped until 2026-08-10 must read as auth ON.
  assert.equal(shadowApiAuthDisabled("1"), false, '"1" must NOT disable auth — it is not "true"');
  assert.equal(shadowApiAuthDisabled(undefined), false, "an unset flag leaves auth ON");
  assert.equal(shadowApiAuthDisabled("TRUE"), true, "the API lowercases before comparing");

  const env = envFor();
  assert.equal(
    shadowApiAuthDisabled(env.AUTH_DISABLED),
    true,
    "the built shadow env must leave the temporary API's authenticated routes reachable"
  );
}

// ── 2. The readiness probe itself, over a real socket ──────────────────────────────────
/**
 * Stand-in for the API's auth middleware + `GET /conversations/:id`. Public paths (the three
 * inbound lanes) pass regardless; everything else needs a token unless the env disables auth.
 * The harness sends no token, so "reachable" and "auth disabled" are the same question.
 */
async function probeReadiness(authDisabledRaw: string | undefined): Promise<number> {
  const authDisabled = shadowApiAuthDisabled(authDisabledRaw);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const isPublic =
      pathname === "/health" ||
      pathname.startsWith("/webhooks/twilio") ||
      pathname.startsWith("/crm/leads/adf/sendgrid") ||
      pathname.startsWith("/public/widget");
    const token = req.headers["x-auth-token"];
    if (!authDisabled && !isPublic && !token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "auth required" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, conversation: { id: CONV_ID, mode: "suggest" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    // The exact request waitForPreparedConversation makes.
    const res = await fetch(`http://127.0.0.1:${port}/conversations/${encodeURIComponent(CONV_ID)}`);
    if (res.ok) {
      const body: any = await res.json();
      assert.equal(
        String(body?.conversation?.mode ?? ""),
        "suggest",
        "a reachable probe must carry the conversation the readiness gate compares modes on"
      );
    }
    return res.status;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

{
  const shipped = await probeReadiness(envFor().AUTH_DISABLED);
  assert.equal(shipped, 200, "the shipped shadow env must make the readiness probe reachable");

  // Not vacuous: the pre-fix value must still be observably unreachable.
  const legacy = await probeReadiness("1");
  assert.equal(legacy, 401, 'the pre-2026-08-10 value "1" must read as auth required');
}

// ── 3. Hermeticity: an inherited production env must never reach the sandbox store ─────
{
  const poisoned: NodeJS.ProcessEnv = {
    DATA_BACKEND: "postgres",
    DATABASE_URL: "postgres://live-host:5432/leadrider",
    DATA_DIR: "/home/ubuntu/leadrider-runtime/americanharley/data",
    CONVERSATIONS_DB_PATH: "/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json",
    CONVERSATIONS_PATH: "/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json",
    SETTINGS_DB_PATH: "/home/ubuntu/leadrider-runtime/americanharley/data/settings.json"
  };
  const env = envFor({ baseEnv: poisoned });

  assert.equal(env.DATA_BACKEND, "file", "a shadow case must never run against Postgres");
  assert.equal(env.DATABASE_URL, "", "an inherited DATABASE_URL must be cleared");
  for (const key of ["DATA_DIR", "CONVERSATIONS_DB_PATH", "CONVERSATIONS_PATH", "SETTINGS_DB_PATH"]) {
    const value = String(env[key] ?? "");
    assert.ok(
      value.startsWith(SANDBOX_DIR),
      `${key} must point inside the per-case sandbox, got: ${value}`
    );
    assert.ok(
      !value.includes("leadrider-runtime"),
      `${key} must not inherit the live runtime store, got: ${value}`
    );
  }
  // Autopilot delivery stays a dry run, so a replayed turn can never text a real customer.
  assert.equal(
    env.ASYNC_TWILIO_AUTOPILOT_DELIVERY_DRY_RUN,
    "1",
    "replayed autopilot turns must never leave a real send"
  );
}

console.log("inbound_shadow_api_env:eval PASS");
