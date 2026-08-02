import "dotenv/config";
import { parseConversationStateWithLLM } from "../services/api/src/domain/llmDraft.ts";

type StateIntent =
  | "finance_docs"
  | "inventory_watch"
  | "used_low_mileage_watch"
  | "service_request"
  | "parts_request"
  | "apparel_request"
  | "hiring_manager"
  | "vendor_solicitation"
  | "corporate_misroute"
  | "scheduling"
  | "pricing"
  | "general"
  | "none";

type Fixture = {
  id: string;
  text: string;
  expectedState: StateIntent;
  expectedDepartment?: "service" | "parts" | "apparel" | "none";
  expectedHandoff?: string;
  expectedExplicit?: boolean;
};

const fixtures: Fixture[] = [
  // --- vendor_solicitation -----------------------------------------------------------------------
  // The pinned production turn: Jessica Miller +12168596131, Room58 "Contact Us" ADF, 2026-07-31.
  // A B2B pitch drew a sales draft AND a standard follow-up chase that was still running two days
  // after a human had declined. The three negatives below are the ones that actually matter: the
  // expensive failure of this class is calling a real buyer a vendor and going silent on them.
  {
    id: "vendor_b2b_pitch_jessica_miller_20260731",
    text: "Hi, We offer trained human Virtual Assistants supported by our custom-built AI system, MAVIS (My Advanced Virtual Intelligent System), that easily replaces the workload of a 10-person team handling marketing, admin, social media, lead generation, CRM management, content creation, customer support, and more. The best part is that you simply delegate tasks to one trained VA (full-time or part-time), and we handle the execution. Open for discussion?",
    expectedState: "vendor_solicitation",
    expectedDepartment: "none",
    expectedHandoff: "vendor_inquiry",
    expectedExplicit: true
  },
  {
    id: "vendor_marketing_agency_pitch",
    text: "I represent a digital marketing agency and we can get your dealership more leads. Can we set up 15 minutes this week?",
    expectedState: "vendor_solicitation",
    expectedDepartment: "none",
    expectedHandoff: "vendor_inquiry",
    expectedExplicit: true
  },
  {
    id: "vendor_supplier_pitch",
    text: "Our company supplies OEM-grade tooling to powersports dealers nationwide. Who handles purchasing for your store?",
    expectedState: "vendor_solicitation",
    expectedDepartment: "none",
    expectedHandoff: "vendor_inquiry",
    expectedExplicit: true
  },
  {
    // A customer selling US their bike is a TRADE, the most valuable lead we get — never a vendor.
    id: "vendor_negative_customer_selling_own_bike",
    text: "I want to sell you my 2019 Road King, what will you give me for it?",
    expectedState: "general",
    expectedDepartment: "none",
    expectedHandoff: "none"
  },
  {
    // Mentions owning a company; is buying for himself. Business words are not a vendor signal.
    id: "vendor_negative_business_owner_buying_for_himself",
    text: "I own a landscaping business and I am looking to buy a Street Glide for myself.",
    expectedState: "general",
    expectedDepartment: "none",
    expectedHandoff: "none"
  },
  {
    id: "vendor_negative_corporate_fleet_discount",
    text: "Do you offer a corporate or fleet discount for my company?",
    expectedState: "pricing",
    expectedDepartment: "none",
    expectedHandoff: "none"
  },
  {
    id: "hiring_manager_question_1",
    text: "Who is the hiring manager for American Harley Davidson?",
    expectedState: "hiring_manager",
    expectedDepartment: "none",
    expectedHandoff: "hiring_manager_inquiry",
    expectedExplicit: true
  },
  {
    id: "hiring_apply_job_1",
    text: "I wanted to apply for a job at your dealership. Who should I talk to?",
    expectedState: "hiring_manager",
    expectedDepartment: "none",
    expectedHandoff: "hiring_manager_inquiry",
    expectedExplicit: true
  },
  {
    id: "hiring_are_you_hiring_1",
    text: "Are you hiring?",
    expectedState: "hiring_manager",
    expectedDepartment: "none",
    expectedHandoff: "hiring_manager_inquiry",
    expectedExplicit: true
  },
  {
    id: "hiring_resume_destination_1",
    text: "Where do I send a resume?",
    expectedState: "hiring_manager",
    expectedDepartment: "none",
    expectedHandoff: "hiring_manager_inquiry",
    expectedExplicit: true
  },
  {
    id: "hiring_applied_online_owner_1",
    text: "I applied online, who handles that?",
    expectedState: "hiring_manager",
    expectedDepartment: "none",
    expectedHandoff: "hiring_manager_inquiry",
    expectedExplicit: true
  },
  {
    id: "prequal_not_hiring_1",
    text: "PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application.",
    expectedState: "finance_docs",
    expectedDepartment: "none",
    expectedHandoff: "credit_app",
    expectedExplicit: false
  },
  {
    id: "m8_takeoff_parts_1",
    text: "If you get anyone yanking out their 114/117 M-8 to upgrade let me know as I am in the market for one.",
    expectedState: "parts_request",
    expectedDepartment: "parts",
    expectedHandoff: "parts_request",
    expectedExplicit: true
  },
  {
    id: "parts_order_1",
    text: "Can parts order drag specialties for my Road King?",
    expectedState: "parts_request",
    expectedDepartment: "parts",
    expectedHandoff: "parts_request",
    expectedExplicit: true
  },
  {
    id: "parts_catalog_sissy_bar_1",
    text: "Can you order a sissy bar for my Low Rider ST?",
    expectedState: "parts_request",
    expectedDepartment: "parts",
    expectedHandoff: "parts_request",
    expectedExplicit: true
  },
  {
    id: "parts_catalog_slip_ons_1",
    text: "Do you carry slip ons for a 2024 Road Glide?",
    expectedState: "parts_request",
    expectedDepartment: "parts",
    expectedHandoff: "parts_request",
    expectedExplicit: true
  },
  {
    id: "service_install_1",
    text: "Can service quote an LED headlight install?",
    expectedState: "service_request",
    expectedDepartment: "service",
    expectedHandoff: "service_request",
    expectedExplicit: true
  },
  {
    id: "customer_cancel_with_service_context_not_service_request_1",
    text: "I have to cancel coming to you Tuesday. I'm having service done on the bike and inspection. I need to do a few more things before I can sell. I'll get back to you.",
    expectedState: "general",
    expectedDepartment: "none",
    expectedHandoff: "none",
    expectedExplicit: false
  },
  {
    id: "used_low_mileage_watch_1",
    text: "I don't want to waste your time as I'm looking for a low mileage used one, not new.",
    expectedState: "used_low_mileage_watch",
    expectedDepartment: "none",
    expectedHandoff: "used_low_mileage_watch",
    expectedExplicit: true
  },
  {
    id: "apparel_helmet_1",
    text: "Do you have helmets in apparel?",
    expectedState: "apparel_request",
    expectedDepartment: "apparel",
    expectedHandoff: "apparel_request",
    expectedExplicit: true
  },
  {
    id: "motorclothes_catalog_modular_helmet_1",
    text: "Do you have a modular helmet in XL?",
    expectedState: "apparel_request",
    expectedDepartment: "apparel",
    expectedHandoff: "apparel_request",
    expectedExplicit: true
  }
];

function pct(n: number, total: number) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
    console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
    process.exit(1);
  }
  if (process.env.LLM_ENABLED !== "1" || process.env.LLM_CONVERSATION_STATE_PARSER_ENABLED === "0") {
    console.error("LLM_ENABLED=1 and LLM_CONVERSATION_STATE_PARSER_ENABLED!=0 are required for this eval.");
    process.exit(1);
  }

  let stateOk = 0;
  let departmentOk = 0;
  let handoffOk = 0;
  let explicitOk = 0;
  let nullParses = 0;
  const mismatches: string[] = [];

  for (const fixture of fixtures) {
    const parsed = await parseConversationStateWithLLM({ text: fixture.text });
    if (!parsed) {
      nullParses += 1;
      mismatches.push(`- [${fixture.id}] parser returned null | expected state=${fixture.expectedState}`);
      continue;
    }

    const stateMatch = parsed.stateIntent === fixture.expectedState;
    const departmentMatch =
      !fixture.expectedDepartment || parsed.departmentIntent === fixture.expectedDepartment;
    const handoffMatch =
      !fixture.expectedHandoff || parsed.manualHandoffReason === fixture.expectedHandoff;
    const explicitMatch =
      typeof fixture.expectedExplicit !== "boolean" ||
      parsed.explicitRequest === fixture.expectedExplicit;

    if (stateMatch) stateOk += 1;
    if (departmentMatch) departmentOk += 1;
    if (handoffMatch) handoffOk += 1;
    if (explicitMatch) explicitOk += 1;

    if (!stateMatch || !departmentMatch || !handoffMatch || !explicitMatch) {
      mismatches.push(
        [
          `- [${fixture.id}] text=${JSON.stringify(fixture.text)}`,
          `expected state=${fixture.expectedState}`,
          fixture.expectedDepartment ? `expected department=${fixture.expectedDepartment}` : null,
          fixture.expectedHandoff ? `expected handoff=${fixture.expectedHandoff}` : null,
          typeof fixture.expectedExplicit === "boolean"
            ? `expected explicit=${fixture.expectedExplicit}`
            : null,
          `got state=${parsed.stateIntent}`,
          `got department=${parsed.departmentIntent}`,
          `got handoff=${parsed.manualHandoffReason}`,
          `got explicit=${parsed.explicitRequest}`,
          `confidence=${parsed.confidence ?? null}`
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }
  }

  const total = fixtures.length;
  console.log(`State accuracy: ${stateOk}/${total} (${pct(stateOk, total)}%)`);
  console.log(`Department accuracy: ${departmentOk}/${total} (${pct(departmentOk, total)}%)`);
  console.log(`Handoff accuracy: ${handoffOk}/${total} (${pct(handoffOk, total)}%)`);
  console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk, total)}%)`);
  console.log(`Null parses: ${nullParses}/${total}`);
  console.log("");

  if (mismatches.length) {
    console.log("Mismatches:");
    for (const mismatch of mismatches) console.log(mismatch);
    process.exit(1);
  }

  console.log("All checks passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
