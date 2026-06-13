import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildWebTextWidgetSalesBuyTradeDraft,
  buildWebTextWidgetInboundBody,
  extractWebTextWidgetCustomerMessage,
  extractWebTextWidgetSalesVehicleContext,
  normalizeWebTextWidgetDepartment,
  type WebTextWidgetSalesVehicleContext,
  webTextWidgetClassification,
  webTextWidgetTodoReason
} from "../services/api/src/domain/webTextWidget.ts";

type Case = {
  id: string;
  actual: unknown;
  expected: unknown;
};

type WidgetLanguageFixture = {
  id: string;
  message: string;
  expectedContext: WebTextWidgetSalesVehicleContext | null;
  expectedDraft?: string | null;
  draftMustExclude?: string[];
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

const widgetLanguageFixtures: WidgetLanguageFixture[] = [
  {
    id: "widget_language_buy_trade_simple",
    message: "I want to buy a 2018 Street Bob. I have a 2014 Sportster to trade.",
    expectedContext: {
      requestedVehicle: { year: "2018", model: "Street Bob", condition: "used" },
      tradeVehicle: { year: "2014", model: "Sportster", condition: "used" },
      sellOption: "trade"
    },
    expectedDraft:
      "Hi Test - thanks for reaching out. I can help with the 2018 Street Bob and take a look at your 2014 Sportster trade. Send over the VIN and photos when you can, and I'll have the team confirm the bike details and trade options.",
    draftMustExclude: ["not seeing", "Sportster To Trade"]
  },
  {
    id: "widget_language_color_before_year",
    message: "Interested in the black 2018 Street Bob. I have a 2014 Sportster to trade.",
    expectedContext: {
      requestedVehicle: { year: "2018", model: "Street Bob", condition: "used" },
      tradeVehicle: { year: "2014", model: "Sportster", condition: "used" },
      sellOption: "trade"
    },
    expectedDraft:
      "Hi Test - thanks for reaching out. I can help with the 2018 Street Bob and take a look at your 2014 Sportster trade. Send over the VIN and photos when you can, and I'll have the team confirm the bike details and trade options."
  },
  {
    id: "widget_language_cash_only_inventory",
    message: "Looking to buy a 2024 Road Glide. Cash buyer if it is still available.",
    expectedContext: {
      requestedVehicle: { year: "2024", model: "Road Glide", condition: "used" },
      sellOption: "cash"
    },
    expectedDraft: null
  },
  {
    id: "widget_language_customer_sell_only",
    message: "I want to sell my 2020 Fat Boy.",
    expectedContext: {
      tradeVehicle: { year: "2020", model: "Fat Boy", condition: "used" },
      sellOption: "trade"
    },
    expectedDraft: null
  },
  {
    id: "widget_language_pending_incoming_trade_is_requested_inventory",
    message: "I am interested in the used 2016 Freewheeler you are taking in on trade.",
    expectedContext: {
      requestedVehicle: { year: "2016", model: "Freewheeler", condition: "used" }
    },
    expectedDraft: null
  },
  {
    id: "widget_language_finance_only_context_left_to_orchestrator",
    message: "Do you have financing on used bikes?",
    expectedContext: null,
    expectedDraft: null
  },
  {
    id: "widget_language_test_ride_context_left_to_parser_or_orchestrator",
    message: "Can I schedule a test ride on the 2020 Low Rider S?",
    expectedContext: null,
    expectedDraft: null
  }
];

for (const fixture of widgetLanguageFixtures) {
  const context = extractWebTextWidgetSalesVehicleContext(fixture.message);
  cases.push({
    id: `${fixture.id}_fallback_context`,
    actual: context,
    expected: fixture.expectedContext
  });
  if ("expectedDraft" in fixture) {
    const draft = buildWebTextWidgetSalesBuyTradeDraft({
      firstName: "Test",
      context
    });
    cases.push({
      id: `${fixture.id}_guarded_buy_trade_draft`,
      actual: draft,
      expected: fixture.expectedDraft
    });
  }
  for (const forbidden of fixture.draftMustExclude ?? []) {
    const draft = buildWebTextWidgetSalesBuyTradeDraft({
      firstName: "Test",
      context
    });
    cases.push({
      id: `${fixture.id}_draft_excludes_${forbidden.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
      actual: String(draft ?? "").toLowerCase().includes(forbidden.toLowerCase()),
      expected: false
    });
  }
}

const shadowReplaySource = readFileSync(
  path.join(process.cwd(), "scripts/inbound_shadow_replay.ts"),
  "utf8"
);
cases.push(
  {
    id: "shadow_replay_accepts_widget_provider",
    actual:
      shadowReplaySource.includes('type Provider = "twilio" | "sendgrid_adf" | "web_widget"') &&
      shadowReplaySource.includes("submitWebTextWidget") &&
      shadowReplaySource.includes("/public/widget/text-us"),
    expected: true
  },
  {
    id: "shadow_replay_all_provider_balances_widget_cases",
    actual:
      shadowReplaySource.includes('const providerOrder: Provider[] = ["web_widget", "twilio", "sendgrid_adf"]') &&
      shadowReplaySource.includes('if (args.provider !== "all") return sorted.slice(0, args.limit);'),
    expected: true
  },
  {
    id: "nightly_runs_widget_eval_and_shadow_replay",
    actual: (() => {
      const nightly = readFileSync(path.join(process.cwd(), "scripts/feedback_loop_nightly.sh"), "utf8");
      return (
        nightly.includes("step=web_text_widget_eval") &&
        nightly.includes("npm run web_text_widget:eval") &&
        nightly.includes("step=inbound_shadow_replay") &&
        nightly.includes("npm run inbound_shadow:replay")
      );
    })(),
    expected: true
  },
  {
    id: "ci_eval_runs_widget_eval",
    actual: (() => {
      const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
      return String(pkg?.scripts?.["ci:eval"] ?? "").includes("npm run web_text_widget:eval");
    })(),
    expected: true
  }
);

const apiSource = readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
const llmDraftSource = readFileSync(new URL("../services/api/src/domain/llmDraft.ts", import.meta.url), "utf8");
const widgetRouteStart = apiSource.indexOf('app.post("/public/widget/text-us"');
const widgetRoute = widgetRouteStart >= 0 ? apiSource.slice(widgetRouteStart, widgetRouteStart + 14000) : "";
const salesContextResolverStart = apiSource.indexOf("async function resolveWebTextWidgetSalesVehicleContext");
const salesContextResolver =
  salesContextResolverStart >= 0 ? apiSource.slice(salesContextResolverStart, salesContextResolverStart + 1400) : "";
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
    id: "sales_widget_uses_semantic_parser_before_fallback_extractor",
    actual:
      apiSource.includes("parseWebTextWidgetSalesLeadWithLLM") &&
      apiSource.includes("resolveWebTextWidgetSalesVehicleContext") &&
      salesContextResolver.indexOf("webTextWidgetParserResultToContext(parsed)") <
        salesContextResolver.indexOf("extractWebTextWidgetSalesVehicleContext(message)"),
    expected: true
  },
  {
    id: "sales_widget_applies_buy_trade_guarded_draft",
    actual:
      widgetRoute.includes("buildWebTextWidgetSalesBuyTradeDraft") &&
      widgetRoute.includes("web_text_widget_sales_buy_trade_draft_created"),
    expected: true
  },
  {
    // Mike +17163686204 (2026-06-13): asked the price of a used 2013 Street
    // Glide with no posted price; the agent handed off + made a staff task but
    // published nothing, so the customer got silence. A web-widget sales lead
    // must always at least acknowledge — never dead air.
    id: "sales_widget_never_leaves_silence_acknowledgment_fallback",
    actual:
      widgetRoute.includes("widgetAckFallback") &&
      widgetRoute.includes("I'll text you right back") &&
      widgetRoute.includes("const draftText = String(") &&
      /\|\|\s*widgetAckFallback/.test(widgetRoute) &&
      widgetRoute.includes("if (draftText) {"),
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
  },
  {
    id: "llm_widget_sales_parser_schema_distinguishes_requested_and_trade",
    actual:
      llmDraftSource.includes("WEB_TEXT_WIDGET_SALES_LEAD_PARSER_JSON_SCHEMA") &&
      llmDraftSource.includes("requested_vehicle") &&
      llmDraftSource.includes("trade_vehicle") &&
      llmDraftSource.includes("Never merge the requested vehicle with the trade vehicle."),
    expected: true
  },
  {
    id: "llm_widget_sales_parser_examples_cover_widget_language_families",
    actual:
      llmDraftSource.includes("I want to buy the 2000 wide glide") &&
      llmDraftSource.includes("I have a brand new 2025 road king special") &&
      llmDraftSource.includes("Interested in the black 2018 Street Bob") &&
      llmDraftSource.includes("Looking at that 2024 Road Glide") &&
      llmDraftSource.includes("I want to sell my 2020 Fat Boy") &&
      llmDraftSource.includes("Do you have financing on used bikes?") &&
      llmDraftSource.includes("I am interested in the used 2016 Freewheeler you are taking in on trade") &&
      llmDraftSource.includes("Can I schedule a test ride on the 2020 Low Rider S"),
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
