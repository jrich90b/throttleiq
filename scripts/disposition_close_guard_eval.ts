/**
 * Active-deal disposition closeout guard. Production incident 2026-06-11:
 * Dave Batka +17169982451 — credit app submitted 3 hours earlier, open
 * credit-approval task, "Showed / finance needs more info" outcome — archived
 * as customer_sell_on_own (0.9) nine seconds after texting "I am going to
 * take care of the pipes myself".
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { canApplyDispositionCloseout, hasActiveDealCloseoutBlockers } = await import(
  "../services/api/src/domain/transitionSafety.ts"
);

const nowMs = Date.parse("2026-06-11T19:08:28.000Z");
const batka: any = {
  id: "+17169982451",
  messages: [
    {
      direction: "in",
      provider: "sendgrid_adf",
      at: "2026-06-11T16:26:16.000Z",
      body: "WEB LEAD (ADF)\nSource: HDFS COA Online\nApp ID: 1013954557, Model Year: 2026, Model: Road Glide Limited"
    }
  ],
  appointment: { staffNotify: { outcome: { note: "Showed — finance needs more info", updatedAt: "2026-06-11T15:30:00.000Z" } } }
};
const openTodos = [{ convId: "+17169982451", reason: "approval", summary: "Credit approval task" }];

assert.equal(hasActiveDealCloseoutBlockers(batka, { openTodos, nowMs }), true, "credit todo blocks closeout");
assert.equal(
  hasActiveDealCloseoutBlockers({ ...batka, id: "other" }, { openTodos: [], nowMs }),
  true,
  "recent credit-app ADF alone blocks closeout"
);
assert.equal(
  hasActiveDealCloseoutBlockers(
    { id: "x", messages: [], appointment: batka.appointment },
    { openTodos: [], nowMs }
  ),
  true,
  "recent finance-pending appointment outcome blocks closeout"
);
assert.equal(
  hasActiveDealCloseoutBlockers({ id: "x", messages: [] }, { openTodos: [], nowMs }),
  false,
  "no active-deal signals = no block"
);
// Stale signals stop blocking.
assert.equal(
  hasActiveDealCloseoutBlockers(
    {
      id: "x",
      messages: [{ direction: "in", provider: "sendgrid_adf", at: "2026-05-01T00:00:00.000Z", body: "App ID: 99" }]
    },
    { openTodos: [], nowMs }
  ),
  false,
  "old credit ADF outside the window does not block"
);

// The full gate: Dave's exact situation must refuse the closeout even with an
// accepted 0.9 parse.
assert.equal(
  canApplyDispositionCloseout({
    conv: batka,
    text: "I am going to take care of the pipes myself",
    parsedAccepted: true,
    hasDecision: true,
    openTodos
  }),
  false,
  "active financing must veto disposition closeout regardless of parser confidence"
);
assert.equal(
  canApplyDispositionCloseout({
    conv: { id: "y", messages: [] },
    text: "I'm going to sell my bike myself, thanks anyway",
    parsedAccepted: true,
    hasDecision: true,
    openTodos: []
  }),
  true,
  "clean sell-on-own without active deal still closes"
);

// Wiring + parser pins.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  (apiSource.match(/openTodos: listOpenTodos\(\)/g) ?? []).length >= 3,
  "all disposition closeout gates must pass open todos"
);
const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(
  llmSource,
  /I am going to take care of the pipes myself/,
  "disposition parser few-shots pin the production fixture"
);
assert.match(
  llmSource,
  /handling parts, accessories, pipes, installs, or service themselves/i,
  "disposition parser rules exclude self-service scope statements"
);

console.log("PASS disposition close guard eval");
