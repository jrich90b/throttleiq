/**
 * Gold-corpus harvest eval (pure, no LLM) — pins the dedup key, the deterministic train/eval split,
 * the harvest predicate, and the regex scrub. Plus a source guard that the runner stores to a
 * GITIGNORED path and never commits.
 * Run: npx tsx scripts/gold_corpus_harvest_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { hashString, pairKey, splitFor, shouldHarvestPair, scrubText } from "../services/api/src/domain/goldCorpusHarvest.ts";

// --- hash + key stability / dedup ---
assert.equal(hashString("abc"), hashString("abc"), "hash deterministic");
assert.notEqual(hashString("abc"), hashString("abd"), "hash distinguishes");
assert.equal(pairKey("conv1", "Which model are you leaning toward?"), pairKey("conv1", "which model   are you leaning toward?"), "key is case/space-insensitive (same pair → same key)");
assert.notEqual(pairKey("conv1", "draft A"), pairKey("conv2", "draft A"), "different conversation → different key");

// --- deterministic split + rough distribution ---
assert.equal(splitFor("k123"), splitFor("k123"), "split is stable for a key");
let evalN = 0; const N = 4000;
for (let i = 0; i < N; i++) if (splitFor(`key_${i}`, 0.2) === "eval") evalN++;
const frac = evalN / N;
assert.ok(frac > 0.15 && frac < 0.25, `~20% eval split, got ${(frac * 100).toFixed(1)}%`);

// --- harvest predicate (the intersection filter) ---
assert.equal(shouldHarvestPair({ verdict: "out_of_context", confidence: 0.9 }), true, "confident genuine error harvests");
assert.equal(shouldHarvestPair({ verdict: "out_of_context", confidence: 0.7 }), false, "below confidence does not");
assert.equal(shouldHarvestPair({ verdict: "faithful", confidence: 0.95 }), false, "faithful never harvests");
assert.equal(shouldHarvestPair(null), false, "no score never harvests");

// --- scrub: redacts names/PII, preserves models/days/prices ---
assert.ok(/\[EMAIL\]/.test(scrubText("reach me at a@b.com")), "email redacted");
assert.ok(/\[PHONE\]/.test(scrubText("call 716-555-1234")), "phone redacted");
assert.ok(/Hi \[NAME\]/.test(scrubText("Hi Sean, the bike is ready")), "greeting name redacted");
assert.ok(/Thanks \[NAME\]/.test(scrubText("Thanks Curtis")), "vocative name redacted");
assert.ok(/this is \[NAME\]/.test(scrubText("this is Alexandra at American")), "intro name redacted");
const kept = scrubText("Yes — the 2025 Road Glide is here. Saturday at 2pm? It's $24,999.");
assert.ok(/Road Glide/.test(kept) && /Saturday/.test(kept) && /\$24,999/.test(kept), "models/days/prices preserved");

// --- source guard: runner is gitignored-store + no-commit by construction ---
const runner = fs.readFileSync("scripts/gold_corpus_harvest_incremental.ts", "utf8");
assert.ok(/data\/gold_corpus/.test(runner), "runner default store path under data/gold_corpus (gitignored)");
assert.ok(/--init/.test(runner) && /watermark/i.test(runner), "runner supports --init watermark bootstrap");
const gitignore = fs.readFileSync(".gitignore", "utf8");
assert.ok(/gold_corpus/.test(gitignore), ".gitignore must exclude the harvest store (never auto-commit customer data)");

console.log("PASS gold-corpus harvest — key/dedup, split distribution, predicate, scrub, + gitignore/no-commit guard.");
