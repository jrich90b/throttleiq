/**
 * Photo-question vision eval (Phase 1, DARK — Joe 2026-07-28; Tim Williams asked why a light was off in
 * a photo we sent, with the OTHER lights ON so the bike was powered).
 *
 * A customer asks about a photo WE sent. The agent reads THAT photo and: answers a benign visual
 * question directly; DESCRIBES + hands a FUNCTIONAL/condition question to a tech (NEVER diagnosing
 * function from a still); or takes a closer look. This pins the pure decision, the reply builders +
 * the never-a-functional-claim guard (the crux), and the both-paths / live-only-lead-owner-task wiring.
 * Ships DARK behind PHOTO_QUESTION_VISION_ENABLED => merging changes nothing. Wired into ci:eval.
 * Run: npx tsx scripts/photo_question_vision_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decidePhotoQuestionTurn } from "../services/api/src/domain/routeStateReducer.ts";
import {
  assertsFunctionalClaim,
  buildPhotoQuestionVisualReply,
  buildPhotoQuestionHandoffReply,
  buildPhotoQuestionCloserLookReply,
  buildPhotoQuestionTaskSummary
} from "../services/api/src/domain/photoQuestionVision.ts";

// --- 1) Pure decision table. ---
const base = {
  parserAccepted: true,
  asksAboutSentPhoto: true,
  textConfidence: 0.9,
  confidenceMin: 0.7,
  hasSentPhoto: true,
  visionAccepted: true,
  isFunctionalQuestion: false,
  canAnswerVisually: true,
  visionConfidence: 0.9
};
const kind = (o: Partial<typeof base>) => decidePhotoQuestionTurn({ ...base, ...o }).kind;
assert.equal(kind({ parserAccepted: false }), "none", "no parse => none");
assert.equal(kind({ asksAboutSentPhoto: false }), "none", "not about the sent photo => none");
assert.equal(kind({ textConfidence: 0.5 }), "none", "low text confidence => none");
assert.equal(kind({ hasSentPhoto: false }), "none", "no photo we sent => none (existing handling)");
assert.equal(kind({ visionAccepted: false }), "closer_look_handoff", "couldn't read the photo => a human looks");
assert.equal(kind({ isFunctionalQuestion: true }), "describe_and_handoff", "a functional question NEVER answers from a still => describe + tech");
assert.equal(kind({}), "answer_visual", "a confident benign visual question => answer directly");
assert.equal(kind({ canAnswerVisually: false }), "closer_look_handoff", "can't answer visually => closer look");
assert.equal(kind({ visionConfidence: 0.5 }), "closer_look_handoff", "low vision confidence => closer look");
// A functional question wins even when vision thinks it could answer visually (never diagnose).
assert.equal(kind({ isFunctionalQuestion: true, canAnswerVisually: true }), "describe_and_handoff", "functional beats visual");

// --- 2) The never-a-functional-claim guard (the crux). ---
assert.equal(assertsFunctionalClaim("the light works fine"), true, "'works' is a functional claim");
assert.equal(assertsFunctionalClaim("that bulb is burnt out"), true, "'burnt out' is a functional claim");
assert.equal(assertsFunctionalClaim("it's broken / faulty / needs replacing"), true, "broken/faulty/replace are functional claims");
assert.equal(assertsFunctionalClaim("everything looks fine, nothing wrong"), true, "'nothing wrong' is a condition claim");
assert.equal(assertsFunctionalClaim("one auxiliary lamp is not illuminated in the photo"), false, "a pure visual observation is NOT a functional claim");
assert.equal(assertsFunctionalClaim("the other lights are lit so the bike is powered"), false, "scene reasoning is not a functional claim");

// --- 3) Reply builders. ---
// Handoff reply: describes what's visible + hands to a tech; NEVER a working/broken claim — even if
// the vision read leaked one, it's scrubbed.
const handoff = buildPhotoQuestionHandoffReply({
  firstName: "Tim",
  read: {
    observation: "one auxiliary light is not lit",
    sceneState: "the other lights are lit so the bike appears powered on"
  }
});
assert.match(handoff, /Tim/, "handoff greets by name");
assert.match(handoff, /tech/i, "handoff hands to a tech");
assert.match(handoff, /powered on|not lit/i, "handoff surfaces the honest visible read + scene context");
assert.doesNotMatch(handoff, /\b(works?|working|broken|burnt|faulty|defective|is fine|nothing wrong)\b/i, "handoff makes NO function/condition claim");
// Leaked functional wording in the read is SCRUBBED from the reply.
const scrubbed = buildPhotoQuestionHandoffReply({
  firstName: "Tim",
  read: { observation: "the bulb is burnt out and needs replacing", sceneState: "the light is broken" }
});
assert.doesNotMatch(scrubbed, /\b(burnt|broken|needs replacing|replac)\w*\b/i, "leaked functional claims are scrubbed from the handoff reply");
assert.match(scrubbed, /tech/i, "scrubbed handoff still hands to a tech");

// Visual reply: uses the vision's confident answer.
const visual = buildPhotoQuestionVisualReply({ firstName: "Tim", read: { answer: "No — that's the front headlight, not a windshield." } });
assert.ok(visual && /headlight/.test(visual), "visual reply carries the vision's answer");
assert.equal(buildPhotoQuestionVisualReply({ firstName: "Tim", read: { answer: "" } }), null, "empty answer => null (caller falls back)");

// Closer-look reply.
assert.match(buildPhotoQuestionCloserLookReply({ firstName: "Tim" }), /closer look/i, "closer-look reply offers a closer look");

// Task summary.
const task = buildPhotoQuestionTaskSummary({ focus: "light", question: "why is that light off? the others are on" });
assert.match(task, /about something in the photo/i, "task references the photo question");
assert.match(task, /the light/i, "task names the focus");
assert.match(task, /why is that light off/i, "task carries the customer's question");

// --- 4) Parser contract + dark gate. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export async function parsePhotoReferenceQuestionWithLLM/, "text intent parser exported");
assert.match(llm, /export async function answerPhotoQuestionWithLLM/, "vision Q&A parser exported");
assert.match(llm, /process\.env\.PHOTO_QUESTION_VISION_ENABLED !== "1"/, "both parsers are DARK behind the flag");
assert.match(llm, /You CANNOT tell from a still photo whether a part WORKS, is BROKEN/, "the vision prompt forbids diagnosing function from a still");

// --- 5) Source guards: both paths, dark gate, functional=>lead-owner task (live-only), dedup. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  (api.match(/resolvePhotoQuestionReply\(conv,/g) ?? []).length >= 2,
  "the photo-question resolver runs in BOTH the live and regenerate paths"
);
assert.match(api, /if \(process\.env\.PHOTO_QUESTION_VISION_ENABLED !== "1"\) return null;/, "the resolver is dark by default");
assert.match(api, /decidePhotoQuestionTurn\(/, "the resolver uses the centralized decision");
assert.match(api, /if \(scope !== "live"\) return;/, "the tech task is LIVE-only (regen never creates tasks)");
assert.match(api, /addTodo\(conv, "other", buildPhotoQuestionTaskSummary\([\s\S]{0,80}?conv\.leadOwner\)/, "the tech task is owned by the lead owner");
assert.match(api, /photo_question_describe_handoff/, "the describe+handoff outcome is recorded");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(String(pkg.scripts?.["ci:eval"] ?? "").includes("photo_question_vision:eval"), "photo_question_vision:eval is wired into ci:eval");

console.log("PASS photo-question vision eval (decision + never-diagnose guard + reply builders + both-paths/lead-owner-task wiring, dark)");
