import {
  buildWebTextWidgetInboundBody,
  normalizeWebTextWidgetDepartment,
  webTextWidgetClassification,
  webTextWidgetTodoReason
} from "../services/api/src/domain/webTextWidget.ts";

type Case = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const cases: Case[] = [
  {
    id: "sales_department_alias_maps_to_sales",
    actual: normalizeWebTextWidgetDepartment("Sales"),
    expected: "sales"
  },
  {
    id: "motor_clothes_alias_maps_to_apparel",
    actual: normalizeWebTextWidgetDepartment("Motor Clothes"),
    expected: "apparel"
  },
  {
    id: "service_classification_routes_department",
    actual: webTextWidgetClassification("service"),
    expected: { bucket: "service", cta: "service_request" }
  },
  {
    id: "sales_has_no_department_todo",
    actual: webTextWidgetTodoReason("sales"),
    expected: null
  },
  {
    id: "parts_has_department_todo",
    actual: webTextWidgetTodoReason("parts"),
    expected: "parts"
  },
  {
    id: "inbound_body_includes_department_and_message",
    actual: buildWebTextWidgetInboundBody({
      department: "apparel",
      name: "Jane Rider",
      message: "Do you have helmets in stock?",
      pageUrl: "https://example.test/gear",
      pageTitle: "Gear"
    }).includes("Department: Motor Clothes\nName: Jane Rider"),
    expected: true
  }
];

let passed = 0;
for (const c of cases) {
  const actual = JSON.stringify(c.actual);
  const expected = JSON.stringify(c.expected);
  const ok = actual === expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${expected} actual=${actual}`);
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} web text widget checks`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} web text widget checks passed.`);
