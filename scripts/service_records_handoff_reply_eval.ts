/**
 * service_records_handoff_reply:eval — a service RECORDS/history question must not be answered as a
 * service SCHEDULING request.
 *
 * Real miss (6/16): "Do u [know] when the last time the tires were changed" landed in a service-context
 * conversation, tripped isServiceDepartmentSchedulingRequest (the word "when" reads as a scheduling
 * signal), and drafted "I'll have service check availability and follow up." — a future-booking framing
 * for a PAST-maintenance question. The service handoff itself (todo + manual_handoff) is correct; only
 * the reply FRAMING was wrong. Parser-first fix: the vehicle-fact classifier (questionType ===
 * "service_records") decides records-vs-scheduling, and both the live and regenerate service-handoff
 * blocks route through resolveServiceDepartmentHandoffReply so the framing is identical.
 *
 * Deterministic source guard (the records-vs-scheduling classification itself is LLM and lives in the
 * vehicle-fact parser + its replay fixture).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
const countOf = (needle: string) => src.split(needle).length - 1;

// 1) The pure picker frames records vs scheduling distinctly.
const picker = src.slice(
  src.indexOf("function buildServiceDepartmentHandoffReply("),
  src.indexOf("function buildServiceDepartmentHandoffReply(") + 500
);
assert.ok(picker.length > 0, "buildServiceDepartmentHandoffReply must exist");
assert.ok(
  /isServiceRecordsQuestion[\s\S]{0,120}service records/i.test(picker),
  "records question must return a SERVICE-RECORDS framed reply"
);
assert.ok(
  /buildServiceSchedulingHandoffReply\(text\)/.test(picker),
  "non-records turns fall back to the scheduling-handoff reply"
);

// 2) The resolver is parser-first: hint-gated vehicle-fact parser, keyed on service_records.
const resolver = src.slice(
  src.indexOf("async function resolveServiceDepartmentHandoffReply("),
  src.indexOf("async function resolveServiceDepartmentHandoffReply(") + 700
);
assert.ok(resolver.length > 0, "resolveServiceDepartmentHandoffReply must exist");
assert.ok(
  /hasVehicleFactQuestionParserHint\(/.test(resolver),
  "resolver must hint-gate the LLM call"
);
assert.ok(
  /parseVehicleFactQuestionWithLLM\(/.test(resolver) &&
    /questionType === "service_records"/.test(resolver),
  "resolver must use the vehicle-fact parser's service_records classification (parser-first)"
);

// 3) BOTH paths (live + regen) route the service handoff through the resolver — not the bare
//    scheduling reply — so the framing is identical (route-parity law).
assert.ok(
  countOf("resolveServiceDepartmentHandoffReply(conv, event.body)") >= 2,
  "both the live and regenerate service-handoff blocks must use the records-aware resolver"
);
assert.ok(
  countOf("buildServiceSchedulingHandoffReply(event.body)") === 0,
  "no service-handoff block may call buildServiceSchedulingHandoffReply directly (must go via the resolver)"
);

console.log("PASS service-records-handoff-reply eval (records questions get records framing, both paths)");
