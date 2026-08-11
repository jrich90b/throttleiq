/**
 * hiring_lead_not_a_sales_lead:eval
 *
 * Pins the hiring demotion guard (`isExplicitHiringRequest`, domain/conversationStateParserPrompt.ts):
 * a job applicant who STATES rather than ASKS must still reach the hiring handoff, and the words
 * "job"/"career"/"resume" appearing incidentally must still NOT.
 *
 * Production miss (Brian Marsh, +17166798748, 2026-08-08, reported by Joe 2026-08-10): his web lead
 * ("I will provide my resume ... I would love to one of your salesman") entered the SALES lane, and
 * on his follow-up the agent drafted showroom appointment times at a job applicant. The parser read
 * him correctly every single time — `hiring_manager` / `hiring_manager_inquiry` /
 * `explicit_request:true` — and a lexical shape test (a required question mark) threw the verdict
 * away, which then read downstream as an "accepted non-hiring intent" and VETOED the deterministic
 * `isHiringManagerInquiryText` detector that also returns TRUE on his text.
 *
 * WHY THIS EVAL IS PURE, with no LLM call. The fixtures below are the REAL inbound turns from the
 * americanharley store paired with the parser verdicts ACTUALLY OBSERVED on them (3 runs each,
 * measured 2026-08-11 — every distinct verdict seen is a separate case here, so the eval covers the
 * observed spread rather than one lucky sample). That keeps the gate's DECISION pinned
 * deterministically: an LLM-backed assertion here would re-measure the parser, which is not what
 * this guard is responsible for, and would red-line main on ordinary judge noise (trap 8).
 *
 * The assertions are on the DECISION (does the turn reach a person?), never on a label spelling.
 */
import assert from "node:assert/strict";
import { isExplicitHiringRequest } from "../services/api/src/domain/conversationStateParserPrompt.ts";

type Verdict = {
  state_intent: string;
  manual_handoff_reason: string;
  explicit_request: boolean;
  confidence: number;
};

type Case = {
  id: string;
  lead: string;
  text: string;
  /** Every distinct parser verdict observed across 3 runs on this exact text. */
  verdicts: Verdict[];
  /** true = the turn must reach the hiring handoff (a person). */
  expectHandoff: boolean;
  why: string;
};

const hiring = (confidence: number): Verdict => ({
  state_intent: "hiring_manager",
  manual_handoff_reason: "hiring_manager_inquiry",
  explicit_request: true,
  confidence
});
const general = (confidence: number): Verdict => ({
  state_intent: "general",
  manual_handoff_reason: "none",
  explicit_request: false,
  confidence
});

const CASES: Case[] = [
  // ---- the reported miss -------------------------------------------------
  {
    id: "brian_marsh_adf_statement",
    lead: "+17166798748",
    text:
      "WEB LEAD (ADF)\nSource: Room58 - Standard\nRef: 11754\nName: Brian Marsh\n" +
      "Vehicle: Harley-Davidson Full Line\n\nInquiry:\nI will provide my resume, I ve been a sales " +
      "manager and sales person for 16 years. I have owned Harley s for years and done business " +
      "with you. I would love to one of your salesman.",
    verdicts: [hiring(0.98), hiring(0.94)],
    expectHandoff: true,
    why: "THE REPORTED MISS. A statement, no question mark — he got the sales lane and, next turn, offered appointment times."
  },
  {
    id: "brian_marsh_followup_statement",
    lead: "+17166798748",
    text:
      "Good afternoon,  he asked if I could take a call Saturday and I haven't heard anything yet.  " +
      "I'm available and interested in your position.\nThank you, Brian Marsh",
    verdicts: [hiring(0.86), hiring(0.97), hiring(0.93)],
    expectHandoff: false,
    why:
      "KNOWN RESIDUAL GAP, pinned deliberately: this turn carries no hiring VOCABULARY ('position' " +
      "alone is not in it), so the structural lock still blocks it even though the parser reads it " +
      "correctly 3/3. Fixing the lead at intake (the case above) is what takes it out of the sales " +
      "lane; widening the vocabulary regex to catch a bare 'position' would be the keyword-scan " +
      "anti-pattern. If this shape ever shows up as a COLD first touch, that is the trigger to " +
      "revisit — not a regex edit."
  },
  // ---- the other real applicants in the store ----------------------------
  {
    id: "cameron_mouyeos_adf_technician_opening",
    lead: "+17163743944",
    text:
      "WEB LEAD (ADF)\nSource: Room58 - Standard\nRef: 11132\nName: Cameron Mouyeos\n" +
      "Vehicle: Harley-Davidson Full Line\n\nInquiry:\nDear Michele Hartrich, I hope you re doing " +
      "well. I recently came across the entry level technician opening at Harley Davidson and " +
      "wanted to express my interest in the role. I am a 19 year old automotive student at SUNY " +
      "Erie. I am currently finishing up my first year in school and coming up on a year in the " +
      "field. With my experience in the automotive field, I believe I could be a strong fit for " +
      "your team. I have experience changing brakes and tires and I'm eager to learn more. I ve " +
      "been interested in working on motorcycles for a while and would like to try and get my foot " +
      "through the door to possible build a career. If possible, I would appreciate any additional " +
      "insight into what you re looking for in an ideal candidate. Thank you for your time, and I " +
      "hope to connect soon. Best regards, Cameron Mouyeos",
    verdicts: [hiring(0.95), hiring(0.96), hiring(0.98)],
    expectHandoff: true,
    why:
      "A real applicant for a posted opening; no question mark anywhere in it. Kept VERBATIM from " +
      "the store — an abridged copy of this letter drops 'build a career', which is the only hiring " +
      "vocabulary in 900 words, and the case silently stops testing the guard."
  },
  {
    id: "cameron_mouyeos_followup_cover_letter",
    lead: "+17163743944",
    text: "Thank you very much. I was just wondering because I am completing a cover letter and inquiry for a job application.",
    verdicts: [hiring(0.95), hiring(0.92), hiring(0.86)],
    expectHandoff: true,
    why:
      "Same applicant mid-thread. Note the 0.86 run: a vendor-style 0.88 confidence floor would " +
      "have dropped a known job applicant here, which is why this guard has no floor."
  },
  {
    id: "joseph_juston_adf_uploaded_resume",
    lead: "+17167963238",
    text:
      "WEB LEAD (ADF)\nSource: Room58 - Standard\nRef: 10981\nName: Joseph Juston\n" +
      "Vehicle: Harley-Davidson Full Line\n\nInquiry:\nI uploaded my resume",
    verdicts: [hiring(0.86), hiring(0.9), hiring(0.86)],
    expectHandoff: true,
    why:
      "The floor case that decided the design: 2 of his 3 runs sit BELOW 0.88, so a confidence " +
      "floor would silently drop a real applicant while excluding no decoy."
  },
  {
    id: "amy_szyminski_adf_attached_resume",
    lead: "+17168615133",
    text:
      "WEB LEAD (ADF)\nSource: Room58 - Standard\nRef: 10833\nName: Amy Szyminski\n" +
      "Vehicle: Harley-Davidson Full Line\n\nInquiry:\ni have vast experience in sales and customer " +
      "service. i am a people person and love interacting with customers. i have attached my resume " +
      "for additional information on my skills.",
    verdicts: [hiring(0.98)],
    expectHandoff: true,
    why: "A real applicant; pure statement."
  },
  // ---- the decoys: hiring WORDS, no hiring MEANING -----------------------
  {
    id: "decoy_service_job_done",
    lead: "+17164789267",
    text:
      "Loved “Hey Steve, ya whenever you get a chance. Hollis has a lot of the job done. Tour pak is " +
      "on, audio is done, pretty sure he has the front lighting done. Looks like hes getting close”",
    verdicts: [general(0.73), general(0.79), general(0.85)],
    expectHandoff: false,
    why: "A SERVICE job in progress. The word 'job' is there; the meaning is not."
  },
  {
    id: "decoy_praise_great_job",
    lead: "+17169123294",
    text: "I'm you took care of us today you're doing a great job.",
    verdicts: [general(0.9)],
    expectHandoff: false,
    why: "Praise for the staff. Note it scores 0.90 — HIGHER than two real applicants, which is why confidence is the wrong discriminator."
  },
  {
    id: "decoy_small_talk_new_job",
    lead: "+17163278698",
    text: "I'm in Boston for two weeks training for my new job I'll b bk ",
    verdicts: [general(0.9)],
    expectHandoff: false,
    why: "Small talk from an existing customer about HIS job elsewhere."
  }
];

// ---------------------------------------------------------------------------
// 1. The guard's decision on every real turn, against every observed verdict.
// ---------------------------------------------------------------------------
const financeCueOf = (textLower: string): boolean =>
  /\b(prequal|pre[-\s]?qualified|credit app|credit application|finance application|approval|hdfs|coa|lien|binder|e-?sign)\b/.test(
    textLower
  );
const requestSignalOf = (raw: string): boolean =>
  /\?/.test(raw) ||
  /\b(can you|could you|would you|can i|please|need|i need|i want|help|reach out|call me|text me|let me know|quote|how much|order|do you have|schedule)\b/.test(
    raw.toLowerCase()
  );

let checks = 0;
for (const c of CASES) {
  const textLower = c.text.toLowerCase();
  // Every fixture must genuinely be the statement-shaped class this guard is about; if one of them
  // starts carrying a question mark the case has stopped testing what it claims to test.
  assert.equal(
    requestSignalOf(c.text),
    false,
    `${c.id}: fixture must be statement-shaped (no request signal) or it does not exercise this guard`
  );
  for (const v of c.verdicts) {
    const allowed = isExplicitHiringRequest({
      textLower,
      hasRequestSignal: false,
      financeCue: financeCueOf(textLower),
      parsed: v
    });
    assert.equal(
      allowed,
      c.expectHandoff,
      `${c.id} @confidence ${v.confidence}: expected reaches-a-person=${c.expectHandoff}, got ${allowed}. ${c.why}`
    );
    checks++;
  }
}

// ---------------------------------------------------------------------------
// 2. The regression direction: question-shaped hiring turns behave exactly as before.
// ---------------------------------------------------------------------------
for (const text of ["Are you hiring?", "Where do I send a resume?", "Who is the hiring manager?"]) {
  assert.equal(
    isExplicitHiringRequest({
      textLower: text.toLowerCase(),
      hasRequestSignal: true,
      financeCue: false,
      // A question-shaped hiring turn must pass on its SHAPE alone — pass a verdict that fails every
      // parser lock, so this can only be green if the pre-existing path is untouched.
      parsed: { state_intent: "general", manual_handoff_reason: "none", explicit_request: false }
    }),
    true,
    `question-shaped hiring turn must still reach the handoff without any parser assertion: ${text}`
  );
  checks++;
}

// ---------------------------------------------------------------------------
// 3. Fail direction: finance beats hiring, and no hiring vocabulary means no handoff.
// ---------------------------------------------------------------------------
assert.equal(
  isExplicitHiringRequest({
    textLower: "i submitted my credit application, do i qualify for approval? also who handles hiring",
    hasRequestSignal: true,
    financeCue: true,
    parsed: {
      state_intent: "hiring_manager",
      manual_handoff_reason: "hiring_manager_inquiry",
      explicit_request: true
    }
  }),
  false,
  "a finance turn must NEVER become a hiring handoff, even on a confident hiring verdict"
);
checks++;

assert.equal(
  isExplicitHiringRequest({
    textLower: "i am interested in your position and available whenever",
    hasRequestSignal: false,
    financeCue: false,
    parsed: {
      state_intent: "hiring_manager",
      manual_handoff_reason: "hiring_manager_inquiry",
      explicit_request: true
    }
  }),
  false,
  "the vocabulary lock must still bound what a parser verdict alone can act on"
);
checks++;

// A confident-looking verdict that is missing ANY ONE of the three locks must not carry a
// statement-shaped turn. These are the locks that exclude the decoys, so they are asserted
// together AND individually — removing one of two redundant defences must still be visible.
const RESUME = "i have attached my resume for the sales role";
for (const partial of [
  { state_intent: "general", manual_handoff_reason: "hiring_manager_inquiry", explicit_request: true },
  { state_intent: "hiring_manager", manual_handoff_reason: "none", explicit_request: true },
  { state_intent: "hiring_manager", manual_handoff_reason: "hiring_manager_inquiry", explicit_request: false }
]) {
  assert.equal(
    isExplicitHiringRequest({ textLower: RESUME, hasRequestSignal: false, financeCue: false, parsed: partial }),
    false,
    `a statement-shaped turn must need ALL THREE parser locks, missing: ${JSON.stringify(partial)}`
  );
  checks++;
}

console.log(`hiring_lead_not_a_sales_lead:eval PASS (${checks} checks over ${CASES.length} real store turns)`);
