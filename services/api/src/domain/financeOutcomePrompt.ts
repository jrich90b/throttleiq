/**
 * The `unreachable` finance outcome — prompt surface (Joe, 2026-08-11: "build the separate button").
 *
 * It lives here rather than in llmDraft.ts because llmDraft pays for its own growth under
 * source_size_ratchet:eval, and a prompt surface is exactly the thing that keeps growing.
 *
 * WHY THE OUTCOME EXISTS. MEASURED on the live store: of 14 finance tasks marked `needs_more_info`,
 * most were not about missing information at all — "Phone number is not reachable", "4th call attempt
 * that does not go through", "Call will not go through", "remind stone to follow up in two weeks".
 * Staff were using the lender-contingency bucket as a catch-all for customers they could not REACH.
 *
 * The conflation is not cosmetic: anything acting on `needs_more_info` would ask a customer for a pay
 * stub when the real problem is that nobody has answered the phone. This is the comprehension half of
 * the fix; the staff-facing option is the other half.
 *
 * ⚠️ `unreachable` is NOT a credit verdict and must never be treated as one. It says nothing about the
 * application — it says we have not spoken to the person.
 */
export const FINANCE_OUTCOME_UNREACHABLE_MAPPING =
  "- unreachable: nobody could get hold of the CUSTOMER — no answer, voicemail, a bad or disconnected number, repeated call attempts that do not go through. This is about reaching the person, NOT about their credit, and it is never a lender verdict.";

export const FINANCE_OUTCOME_UNREACHABLE_RULE =
  "- A call that never CONNECTED is unreachable, never needs_more_info. 'Phone number is not reachable', '4th call attempt that does not go through', 'called and left voicemail' say nothing about the application — they say we have not spoken to them. Getting this wrong makes us ask a customer for a pay stub when the real problem is that nobody has answered.";

/**
 * Every example below is a REAL note a staff member filed against a finance task in the live store,
 * not an invented wording — the fixture IS the measurement. The last one is the deliberate contrast:
 * we DID reach them and the lender wants something, which is the case that stays `needs_more_info`.
 */
export const FINANCE_OUTCOME_UNREACHABLE_EXAMPLES: string[] = [
  'input: "Summary: Phone number is not reachable" output: {"outcome":"unreachable","explicit_outcome":true,"confidence":0.96,"reason_text":"phone number is not reachable","required_items":[]}',
  'input: "Summary: 4th call attempt that does not go through" output: {"outcome":"unreachable","explicit_outcome":true,"confidence":0.96,"reason_text":"4th call attempt did not go through","required_items":[]}',
  'input: "Summary: Called and left voicemail" output: {"outcome":"unreachable","explicit_outcome":true,"confidence":0.92,"reason_text":"called and left voicemail","required_items":[]}',
  'input: "Summary: Spoke with him, lender still wants a recent pay stub before they finalize." output: {"outcome":"needs_more_info","explicit_outcome":true,"confidence":0.95,"reason_text":"lender wants a recent pay stub","required_items":["A recent pay stub"]}'
];
