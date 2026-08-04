/**
 * The two finance-outcome gates, side by side so the difference between them is impossible to miss.
 *
 * Lifted out of index.ts with the prequal ruling (Joe, 2026-08-04: "a pre qual should not create a
 * finance outcome") — the de-tangle program wants this wiring in the domain layer anyway.
 *
 * They are NOT interchangeable:
 *   - `isFinanceOutcomeContext` is BROAD, and includes how the lead ARRIVED. Correct for READING an
 *     outcome a human already chose (the To-Do outcome endpoint): a staff member picking
 *     "declined" on a prequal lead's task is telling us the outcome, so we record it.
 *   - `shouldPromptBusinessManagerFinanceOutcome` is NARROW, and asks the centralized referee in
 *     routeStateReducer. It gates the UNPROMPTED SMS + open task, which must never fire on an
 *     origin label alone.
 */
import {
  decideBusinessManagerFinanceOutcomePrompt,
  type BusinessManagerFinanceOutcomePromptDecision
} from "./routeStateReducer.js";

/** Broad "this lead is finance-flavoured" test — see the header for when this is the right one. */
export function isFinanceOutcomeContext(conv: any): boolean {
  return (
    conv?.classification?.bucket === "finance_prequal" ||
    conv?.classification?.cta === "hdfs_coa" ||
    conv?.classification?.cta === "prequalify" ||
    /credit_app|credit_app_cosigner|credit_app_needs_info|financing_declined|credit_app_approved/.test(
      String(conv?.followUp?.reason ?? "").toLowerCase()
    ) ||
    String(conv?.appointment?.appointmentType ?? "").toLowerCase() === "finance_discussion"
  );
}

/**
 * Conversation-shaped adapter over the pure referee. The skip is observable without an ad-hoc log:
 * this decision is sampled in `buildDecisionRegistry`, so a lead that starts nagging the business
 * manager again surfaces as a decision DIFF in the equivalence harness.
 */
export function shouldPromptBusinessManagerFinanceOutcome(
  conv: any
): BusinessManagerFinanceOutcomePromptDecision {
  return decideBusinessManagerFinanceOutcomePrompt({
    leadCta: conv?.classification?.cta,
    leadBucket: conv?.classification?.bucket,
    followUpReason: conv?.followUp?.reason,
    appointmentType: conv?.appointment?.appointmentType
  });
}
