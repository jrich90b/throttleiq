import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildTlpBrowserUsePrompt,
  resolveTlpBrowserUseScriptPath,
  runTlpBrowserUseRescue,
  tlpBrowserUseRescueEnabled
} from "../services/api/src/connectors/crm/tlpBrowserUse.ts";

assert.equal(tlpBrowserUseRescueEnabled({ TLP_BROWSER_USE_RESCUE: "1" } as any), true);
assert.equal(tlpBrowserUseRescueEnabled({ TLP_PORTAL_USE_BROWSER_USE: "true" } as any), true);
assert.equal(tlpBrowserUseRescueEnabled({ TLP_BROWSER_USE_RESCUE: "0" } as any), false);

const logPrompt = buildTlpBrowserUsePrompt(
  {
    action: "log_customer_contact",
    leadRef: "11338",
    phone: "+17165551212",
    note: "Customer called asking about the 2022 Street Glide. Staff promised pictures.",
    categoryValue: "MOTORCYCLES",
    contactedValue: "YES"
  },
  new Error("selector changed")
);
assert.match(logPrompt, /Task: log a customer contact note/i);
assert.match(logPrompt, /Lead ref: 11338/i);
assert.match(logPrompt, /Do not send SMS, email, chat, or any customer-facing message/i);
assert.match(logPrompt, /Customer called asking about the 2022 Street Glide/i);
assert.match(logPrompt, /Save\/submit the contact log/i);
assert.match(logPrompt, /RESULT_STATUS: saved/i);
assert.match(logPrompt, /RESULT_STATUS: blocked/i);

const deliveredPrompt = buildTlpBrowserUsePrompt(
  {
    action: "mark_dealership_visit_delivered",
    leadRef: "11335",
    phone: "+17165550000",
    note: "Sold and delivered the 2026 Street Glide 3 Limited.",
    details: {
      firstName: "Arthur",
      model: "Street Glide 3 Limited",
      stockId: "T58-25"
    }
  },
  "visit selector timeout"
);
assert.match(deliveredPrompt, /Task: mark dealership visit outcome as delivered\/sold/i);
assert.match(deliveredPrompt, /Street Glide 3 Limited/i);
assert.match(deliveredPrompt, /stockId: T58-25/i);
assert.match(deliveredPrompt, /Save\/submit the internal CRM update/i);
assert.match(deliveredPrompt, /RESULT_STATUS: saved/i);

assert.ok(resolveTlpBrowserUseScriptPath()?.endsWith("scripts/tlp_crm_browser_use.py"));

const previousFlag = process.env.TLP_BROWSER_USE_RESCUE;
const previousPortalFlag = process.env.TLP_PORTAL_USE_BROWSER_USE;
const previousScript = process.env.TLP_BROWSER_USE_SCRIPT_PATH;
const previousPython = process.env.TLP_BROWSER_USE_PYTHON;
delete process.env.TLP_BROWSER_USE_RESCUE;
delete process.env.TLP_PORTAL_USE_BROWSER_USE;
const disabled = await runTlpBrowserUseRescue(
  {
    action: "log_customer_contact",
    leadRef: "11338",
    note: "No browser-use should run in this test."
  },
  new Error("primary failed")
);
assert.equal(disabled.attempted, false);
assert.equal(disabled.skipped, true);
assert.match(disabled.summary, /disabled/i);
if (previousFlag !== undefined) process.env.TLP_BROWSER_USE_RESCUE = previousFlag;
if (previousPortalFlag !== undefined) process.env.TLP_PORTAL_USE_BROWSER_USE = previousPortalFlag;

const tempDir = await mkdtemp(path.join(tmpdir(), "tlp-browser-use-rescue-eval-"));
try {
  const fakeScript = path.join(tempDir, "fake-runner.js");
  await writeFile(
    fakeScript,
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
const resultPath = args[args.indexOf("--result") + 1];
fs.writeFileSync(resultPath, JSON.stringify({
  ok: true,
  blocked: false,
  summary: args.join(" ")
}));
`,
    "utf8"
  );
  process.env.TLP_BROWSER_USE_RESCUE = "1";
  process.env.TLP_BROWSER_USE_SCRIPT_PATH = fakeScript;
  process.env.TLP_BROWSER_USE_PYTHON = process.execPath;
  const attached = await runTlpBrowserUseRescue(
    {
      action: "log_customer_contact",
      leadRef: "11338",
      note: "Use fake runner to prove CDP and portal URL options pass through."
    },
    new Error("primary failed"),
    {
      cdpUrl: "http://127.0.0.1:9222",
      portalUrl: "https://tlpcrm.com/current-lead"
    }
  );
  assert.equal(attached.attempted, true);
  assert.equal(attached.ok, true);
  assert.match(attached.summary, /--cdp-url http:\/\/127\.0\.0\.1:9222/);
  assert.match(attached.summary, /--portal-url https:\/\/tlpcrm\.com\/current-lead/);
} finally {
  await rm(tempDir, { recursive: true, force: true });
  if (previousFlag !== undefined) process.env.TLP_BROWSER_USE_RESCUE = previousFlag;
  else delete process.env.TLP_BROWSER_USE_RESCUE;
  if (previousPortalFlag !== undefined) process.env.TLP_PORTAL_USE_BROWSER_USE = previousPortalFlag;
  else delete process.env.TLP_PORTAL_USE_BROWSER_USE;
  if (previousScript !== undefined) process.env.TLP_BROWSER_USE_SCRIPT_PATH = previousScript;
  else delete process.env.TLP_BROWSER_USE_SCRIPT_PATH;
  if (previousPython !== undefined) process.env.TLP_BROWSER_USE_PYTHON = previousPython;
  else delete process.env.TLP_BROWSER_USE_PYTHON;
}

console.log("tlp_browser_use_rescue_eval passed");
