import { readFileSync } from "node:fs";
import {
  buildWebTextWidgetSalesBuyTradeDraft,
  buildWebTextWidgetInboundBody,
  extractWebTextWidgetCustomerMessage,
  extractWebTextWidgetSalesVehicleContext,
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
    id: "sales_classification_routes_inventory_interest",
    actual: webTextWidgetClassification("sales"),
    expected: { bucket: "inventory_interest", cta: "check_availability" }
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
  },
  {
    id: "sales_widget_extracts_customer_message_from_metadata_body",
    actual: extractWebTextWidgetCustomerMessage(
      buildWebTextWidgetInboundBody({
        department: "sales",
        name: "Howard R ackerman",
        message:
          "I want to buy the 2000 wide glide.I have a brand new 2025 road king special that I just bought.Its black on black.",
        pageUrl: "https://example.test/used",
        pageTitle: "Used inventory"
      })
    ),
    expected:
      "I want to buy the 2000 wide glide.I have a brand new 2025 road king special that I just bought.Its black on black."
  },
  {
    id: "sales_widget_keeps_requested_vehicle_and_trade_vehicle_distinct",
    actual: extractWebTextWidgetSalesVehicleContext(
      "I want to buy the 2000 wide glide.I have a brand new 2025 road king special that I just bought.Its black on black. I can supply pics and vin number.I will buy it with cash if we are unable to make a deal with the road king. Thanks!"
    ),
    expected: {
      requestedVehicle: { year: "2000", model: "Wide Glide", condition: "used" },
      tradeVehicle: {
        year: "2025",
        model: "Road King Special",
        condition: "new",
        color: "Black on Black"
      },
      sellOption: "either"
    }
  },
  {
    id: "sales_widget_buy_trade_draft_names_requested_bike_not_inventory_miss",
    actual: buildWebTextWidgetSalesBuyTradeDraft({
      firstName: "Howard",
      context: extractWebTextWidgetSalesVehicleContext(
        "I want to buy the 2000 wide glide.I have a brand new 2025 road king special that I just bought.Its black on black. I can supply pics and vin number.I will buy it with cash if we are unable to make a deal with the road king. Thanks!"
      )
    }),
    expected:
      "Hi Howard - thanks for reaching out. I can help with the 2000 Wide Glide and take a look at your 2025 Road King Special trade. Send over the VIN and photos when you can, and I'll have the team confirm the bike details and trade options."
  }
];

const apiSource = readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
const widgetRouteStart = apiSource.indexOf('app.post("/public/widget/text-us"');
const widgetRoute = widgetRouteStart >= 0 ? apiSource.slice(widgetRouteStart, widgetRouteStart + 14000) : "";
cases.push(
  {
    id: "sales_widget_uses_orchestrator",
    actual: widgetRoute.includes('safeOrchestrateInbound("web_text_widget_sales"'),
    expected: true
  },
  {
    id: "sales_widget_publishes_guarded_sms_draft",
    actual:
      widgetRoute.includes("publishCustomerReplyDraft({") &&
      widgetRoute.includes('channel: "sms"') &&
      widgetRoute.includes("evaluateWidgetSalesDraftInvariant"),
    expected: true
  },
  {
    id: "sales_widget_creates_followup_task",
    actual:
      widgetRoute.includes("Sales website text lead:") &&
      widgetRoute.includes('"followup"') &&
      widgetRoute.includes('setFollowUpMode(conv, "manual_handoff", "web_text_widget_sales")'),
    expected: true
  },
  {
    id: "sales_widget_orchestrates_customer_message_not_metadata_block",
    actual: widgetRoute.includes("body: message"),
    expected: true
  },
  {
    id: "sales_widget_applies_buy_trade_guarded_draft",
    actual:
      widgetRoute.includes("buildWebTextWidgetSalesBuyTradeDraft") &&
      widgetRoute.includes("web_text_widget_sales_buy_trade_draft_created"),
    expected: true
  }
);

const regenerateRouteStart = apiSource.indexOf('app.post("/conversations/:id/regenerate"');
const regenerateRoute =
  regenerateRouteStart >= 0 ? apiSource.slice(regenerateRouteStart, regenerateRouteStart + 16000) : "";
cases.push(
  {
    id: "regenerate_preserves_web_widget_provider",
    actual:
      regenerateRoute.includes('inboundProvider === "web_widget"') &&
      regenerateRoute.includes("? extractWebTextWidgetCustomerMessage(inboundBodyRaw)"),
    expected: true
  },
  {
    id: "regenerate_applies_buy_trade_widget_draft",
    actual:
      regenerateRoute.includes("regenWebTextWidgetBuyTradeDraft") &&
      regenerateRoute.includes("web_text_widget_sales_buy_trade_draft_created"),
    expected: true
  }
);

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
